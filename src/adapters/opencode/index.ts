// pixling-proxy for OpenCode. One module for both plugin APIs:
//   V2 (opencode 2.x):    `setup(ctx)` subscribes to events. What 2.2.5 calls.
//   V1 (opencode-ai 1.x): `server(input)` returns hooks.
// Bundled into packages/opencode/dist with no runtime dependencies. Each event is
// decoded for the fields this plugin reads, and nothing it does reaches OpenCode as a
// failure.
import { Option, Schema } from 'effect';
import type { Activity } from '../../core/Activity.ts';
import type { SessionExtension } from '../../runtimes/base.ts';
import { makeLive } from '../../runtimes/live/index.ts';
import { log } from '../../runtimes/log.ts';

const NAMESPACE = 'opencode';
const AUTHOR = 'OpenCode';
const TEXT_PARTS_WITHIN_MS = 250;
const TOOL_AFTER_TEXT_MS = 50;
const MAX_EARLY_REPLIED = 200;

const Text = Schema.optional(Schema.NullOr(Schema.String));

interface V1Message {
  info?: { role?: string };
  parts?: { type: string; text?: string; synthetic?: boolean }[];
}

interface V1Client {
  session: {
    get?(req: { path: { id: string } }): Promise<{ data?: { parentID?: string | null } } | undefined>;
    messages(req: { path: { id: string }; query?: { limit?: number } }): Promise<{ data?: V1Message[] } | undefined>;
    promptAsync(req: { path: { id: string }; body: { parts: { type: 'text'; text: string }[] } }): Promise<unknown>;
  };
  postSessionIdPermissionsPermissionId(req: {
    path: { id: string; permissionID: string };
    body: { response: 'once' | 'always' | 'reject' };
  }): Promise<unknown>;
}

const V1Properties = Schema.Struct({
  info: Schema.optional(Schema.Struct({ id: Text, parentID: Text })),
  sessionID: Text,
  part: Schema.optional(
    Schema.Struct({
      id: Text,
      sessionID: Text,
      type: Text,
      text: Text,
      tool: Text,
      synthetic: Schema.optional(Schema.NullOr(Schema.Boolean)),
      time: Schema.optional(Schema.Struct({ end: Schema.optional(Schema.NullOr(Schema.Number)) })),
    }),
  ),
  id: Text,
  permissionID: Text,
  permission: Schema.optional(Schema.Unknown),
  type: Text,
  tool: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
  patterns: Schema.optional(Schema.Unknown),
  pattern: Schema.optional(Schema.Unknown),
});
const decodeV1 = Schema.decodeUnknownOption(V1Properties);

interface V2Context {
  session: {
    prompt(req: { sessionID: string; text: string }): Promise<unknown>;
    get(req: { sessionID: string }): Promise<{ parentID?: string | null } | null | undefined>;
  };
  event: {
    subscribe(opts: {
      signal: AbortSignal;
      types: string[];
    }): AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
  };
  permission: { reply(req: { sessionID: string; requestID: string; decision: 'once' | 'reject' }): Promise<unknown> };
}

const V2Data = Schema.Struct({
  sessionID: Text,
  id: Text,
  info: Schema.optional(Schema.Struct({ id: Text, parentID: Text })),
  parentID: Text,
  text: Text,
  name: Text,
  requestID: Text,
  action: Text,
  resources: Schema.optional(Schema.Array(Schema.Unknown)),
  metadata: Schema.optional(Schema.Unknown),
});
const decodeV2 = Schema.decodeUnknownOption(V2Data);

const failed = (what: string) => (e: unknown) =>
  log(`${NAMESPACE} ${what} failed: ${e instanceof Error ? e.name : 'unknown'}`);

const hasKeys = (value: unknown) =>
  typeof value === 'object' && value !== null && Object.keys(value as object).length > 0;

// What a permission asks about. An empty `metadata` must not hide the rest.
const v1Card = (p: typeof V1Properties.Type) => (hasKeys(p.metadata) ? p.metadata : (p.patterns ?? p.pattern));
const v2Card = (d: typeof V2Data.Type) => {
  if (d.resources?.length)
    return d.resources.every((r) => typeof r === 'string') ? d.resources.join('\n') : d.resources;
  return d.metadata;
};

// What both plugin APIs do, keyed by OpenCode session id.
function makeProxy(deliver: (id: string, message: string) => unknown, extension: SessionExtension | undefined) {
  const live = makeLive({ namespace: NAMESPACE, author: AUTHOR, deliver }, extension);
  const asking = new Map<string, AbortController>();
  const earlyReplied = new Set<string>();
  return {
    open: (id: string) => live.start(id),
    close: (id: string) => live.close(id),
    // One thing the agent did, as it ends.
    async did(id: string, activity: Activity): Promise<void> {
      await live.start(id);
      await live.observe(id, activity);
    },
    async turnEnded(id: string, text: string | null | undefined): Promise<void> {
      await live.start(id);
      await live.finish(id, text);
    },
    // Asks on the resident while OpenCode's own screen asks too. `reply` runs if the
    // resident is answered first; `replied` withdraws the card if the screen is.
    async permission(
      id: string,
      request: string,
      card: { tool: string; input: unknown },
      reply: (allow: boolean) => Promise<unknown>,
    ): Promise<void> {
      if (earlyReplied.delete(request)) return;
      const asked = new AbortController();
      asking.set(request, asked);
      try {
        await live.start(id);
        const answer = await live.permission(id, card, asked.signal);
        if (answer && !asked.signal.aborted) await reply(answer.decision === 'allow');
      } finally {
        asking.delete(request);
      }
    },
    replied(request: string) {
      if (!request) return;
      const inFlight = asking.get(request);
      if (inFlight) {
        inFlight.abort();
        return;
      }
      earlyReplied.add(request);
      if (earlyReplied.size > MAX_EARLY_REPLIED) {
        const oldest = earlyReplied.values().next().value;
        if (oldest !== undefined) earlyReplied.delete(oldest);
      }
    },
  };
}

const v1Activity = (part: NonNullable<typeof V1Properties.Type.part>): Activity | null => {
  if (part.type === 'tool') return part.tool ? { kind: 'tool', name: part.tool } : null;
  if (!part.time?.end) return null;
  if (part.type === 'text') return { kind: 'text', text: part.text ?? '' };
  return part.type === 'reasoning' ? { kind: 'reasoning', form: 'full', text: part.text ?? '' } : null;
};

function lastAssistantText(messages: V1Message[] | undefined): string {
  const last = (messages || []).filter((m) => m.info?.role === 'assistant').at(-1);
  return (last?.parts || [])
    .filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => p.text)
    .join('');
}

// Which sessions are the user's own: subagents have a parent, and get no resident.
// A session from before a restart was never seen starting, so its host is asked.
// Remembered as a promise, so events of one session stay in order while it answers.
function makeRoots(parentOf: (id: string) => Promise<string | null | undefined>) {
  const known = new Map<string, Promise<boolean>>();
  return {
    started(id: string, parent: string | null | undefined): boolean {
      known.set(id, Promise.resolve(!parent));
      return !parent;
    },
    forget: (id: string) => known.delete(id),
    has(id: string): Promise<boolean> {
      const seen = known.get(id);
      if (seen) return seen;
      const asked = parentOf(id).then(
        (parent) => !parent,
        (e) => {
          // Not known yet: ask again next time.
          failed('session lookup')(e);
          known.delete(id);
          return false;
        },
      );
      known.set(id, asked);
      return asked;
    },
  };
}

// The plugin, with what `extension` adds to every session (src/bin passes the emote
// extension; the adapter knows nothing of it).
export const opencodeProxy = (extension?: SessionExtension) => ({
  id: 'pixling-proxy',

  // V1
  async server({ client }: { client: V1Client }) {
    const proxy = makeProxy(
      (id, text) => client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }] } }),
      extension,
    );
    const roots = makeRoots(async (id) => {
      if (!client.session.get) throw new Error('no session.get');
      return (await client.session.get({ path: { id } }))?.data?.parentID;
    });
    const saidParts = new Map<string, Set<string>>();
    // Text parts in a row are one text: a message may end as several, and the reply is
    // all of them. Told when something else comes, or after a moment without another.
    const texts = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
    const tellText = async (id: string) => {
      const waiting = texts.get(id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      texts.delete(id);
      await proxy.did(id, { kind: 'text', text: waiting.text });
    };
    const holdText = (id: string, text: string) => {
      const waiting = texts.get(id);
      if (waiting) clearTimeout(waiting.timer);
      const timer = setTimeout(() => void tellText(id).catch(failed('text')), TEXT_PARTS_WITHIN_MS);
      timer.unref?.();
      texts.set(id, { text: (waiting?.text ?? '') + text, timer });
    };

    const handle = async (type: string | undefined, p: typeof V1Properties.Type) => {
      switch (type) {
        case 'session.created':
          if (p.info?.id && roots.started(p.info.id, p.info.parentID)) await proxy.open(p.info.id);
          break;
        case 'session.deleted':
          if (p.info?.id) {
            roots.forget(p.info.id);
            saidParts.delete(p.info.id);
            await tellText(p.info.id);
            proxy.close(p.info.id);
          }
          break;
        // Updates repeat, so each part is told once: a text or reasoning part once it has
        // an end time, a tool part as soon as it appears.
        case 'message.part.updated': {
          const part = p.part;
          if (!part?.id || !part.sessionID || part.synthetic) break;
          const activity = v1Activity(part);
          if (!activity || !(await roots.has(part.sessionID))) break;
          const said = saidParts.get(part.sessionID) ?? new Set();
          saidParts.set(part.sessionID, said);
          if (said.has(part.id)) break;
          said.add(part.id);
          if (activity.kind === 'text') {
            holdText(part.sessionID, activity.text);
            break;
          }
          await tellText(part.sessionID);
          await proxy.did(part.sessionID, activity);
          break;
        }
        case 'session.idle': {
          if (!p.sessionID || !(await roots.has(p.sessionID))) break;
          const res = await client.session.messages({ path: { id: p.sessionID }, query: { limit: 20 } });
          await tellText(p.sessionID);
          await proxy.turnEnded(p.sessionID, lastAssistantText(res?.data));
          break;
        }
        case 'permission.asked':
        case 'permission.updated': {
          const { sessionID, id } = p;
          if (!sessionID || !id || !(await roots.has(sessionID))) break;
          const named = [p.permission, p.type, (p.tool as { name?: unknown } | null | undefined)?.name];
          const tool = named.find((name) => typeof name === 'string' && name) as string | undefined;
          // Not awaited: OpenCode goes on with other events while this one waits.
          void proxy
            .permission(sessionID, id, { tool: tool ?? 'tool', input: v1Card(p) }, (allow) =>
              client.postSessionIdPermissionsPermissionId({
                path: { id: sessionID, permissionID: id },
                body: { response: allow ? 'once' : 'reject' },
              }),
            )
            .catch(failed('permission'));
          break;
        }
        case 'permission.replied':
          proxy.replied(p.permissionID ?? p.id ?? '');
          break;
      }
    };

    return {
      event: async ({ event }: { event?: { type?: string; properties?: unknown } }) => {
        try {
          const properties = decodeV1(event?.properties ?? {});
          if (Option.isSome(properties)) await handle(event?.type, properties.value);
        } catch (e) {
          failed(event?.type ?? 'event')(e);
        }
      },
    };
  },

  // V2: payloads sit under `data`, or `properties` in some versions.
  setup(ctx: V2Context) {
    const proxy = makeProxy((sessionID, text) => ctx.session.prompt({ sessionID, text }), extension);
    const roots = makeRoots(async (sessionID) => (await ctx.session.get({ sessionID }))?.parentID);
    const ac = new AbortController();
    const texts = new Map<string, string>();
    const toolNames = new Map<string, { readonly sessionID: string; readonly name: string }>();
    const chains = new Map<string, Promise<void>>();
    const pendingTools = new Map<
      string,
      Set<{ readonly timer: ReturnType<typeof setTimeout>; readonly run: () => Promise<void> }>
    >();

    const clearToolNames = (sessionID: string) => {
      if (!sessionID) return;
      for (const [toolId, entry] of toolNames) {
        if (entry.sessionID === sessionID) toolNames.delete(toolId);
      }
    };

    const enqueue = (id: string, task: () => Promise<void>, onError: (e: unknown) => void): void => {
      const guarded = () => (ac.signal.aborted ? Promise.resolve() : task());
      if (!id) {
        void guarded().catch(onError);
        return;
      }
      const prev = chains.get(id) ?? Promise.resolve();
      const next = prev.then(guarded).catch(onError);
      const settled = next.finally(() => {
        if (chains.get(id) === settled) chains.delete(id);
      });
      chains.set(id, settled);
    };

    const flushPendingTools = async (id: string, emit: boolean) => {
      const queued = pendingTools.get(id);
      if (!queued) return;
      pendingTools.delete(id);
      for (const item of queued) {
        clearTimeout(item.timer);
        if (emit) await item.run();
      }
    };

    const handle = async (type: string, d: typeof V2Data.Type) => {
      const id = d.sessionID ?? d.info?.id ?? d.id ?? '';
      switch (type) {
        case 'session.created':
          if (id && roots.started(id, d.info?.parentID ?? d.parentID)) await proxy.open(id);
          break;
        case 'session.deleted':
          roots.forget(id);
          texts.delete(id);
          clearToolNames(id);
          await flushPendingTools(id, false);
          proxy.close(id);
          break;
        case 'session.text.ended':
          if (!(await roots.has(id))) break;
          texts.set(id, d.text ?? '');
          await proxy.did(id, { kind: 'text', text: d.text ?? '' });
          break;
        case 'session.reasoning.ended':
          if (!(await roots.has(id))) break;
          await proxy.did(id, { kind: 'reasoning', form: 'full', text: d.text ?? '' });
          break;
        // The name comes first, and then, once the call is complete, `session.tool.called`,
        // which OpenCode sends just ahead of the end of the text before it. So the name
        // is told a moment later, to come after that text.
        case 'session.tool.input.started':
          if (d.id && d.name) toolNames.set(d.id, { sessionID: d.sessionID ?? '', name: d.name });
          break;
        case 'session.tool.called':
        case 'session.tool.failed': {
          const name = toolNames.get(d.id ?? '')?.name;
          toolNames.delete(d.id ?? '');
          if (!name || !(await roots.has(id))) break;
          const set = pendingTools.get(id) ?? new Set();
          pendingTools.set(id, set);
          const run = () => proxy.did(id, { kind: 'tool', name }).catch(failed(type));
          const item: { readonly timer: ReturnType<typeof setTimeout>; readonly run: () => Promise<void> } = {
            run,
            timer: setTimeout(() => {
              set.delete(item);
              if (!set.size) pendingTools.delete(id);
              void run();
            }, TOOL_AFTER_TEXT_MS),
          };
          item.timer.unref?.();
          set.add(item);
          break;
        }
        case 'session.execution.succeeded':
          if (!(await roots.has(id))) break;
          await flushPendingTools(id, true);
          await proxy.turnEnded(id, texts.get(id));
          texts.delete(id);
          break;
        case 'session.execution.failed':
        case 'session.execution.interrupted':
          clearToolNames(id);
          await flushPendingTools(id, false);
          texts.delete(id);
          break;
        case 'permission.asked': {
          const request = d.id;
          if (!request || !d.sessionID || !(await roots.has(d.sessionID))) break;
          const sessionID = d.sessionID;
          // Not awaited: a question may wait a minute for its answer, and the answer
          // given on OpenCode's own screen arrives as the next event on this stream.
          void proxy
            .permission(sessionID, request, { tool: d.action || 'tool', input: v2Card(d) }, (allow) =>
              ctx.permission.reply({ sessionID, requestID: request, decision: allow ? 'once' : 'reject' }),
            )
            .catch(failed('permission'));
          break;
        }
      }
    };

    void (async () => {
      const types = [
        'session.created',
        'session.deleted',
        'session.text.ended',
        'session.reasoning.ended',
        'session.tool.input.started',
        'session.tool.called',
        'session.tool.failed',
        'session.execution.succeeded',
        'session.execution.failed',
        'session.execution.interrupted',
        'permission.asked',
        'permission.replied',
      ];
      for await (const e of ctx.event.subscribe({ signal: ac.signal, types })) {
        const data = decodeV2(e.data ?? e.properties ?? {});
        if (Option.isNone(data)) continue;
        const d = data.value;
        // `permission.replied` must abort an in-flight permission card immediately without
        // waiting behind queued session events.
        if (e.type === 'permission.replied') {
          proxy.replied(d.requestID ?? '');
          continue;
        }
        const id = d.sessionID ?? d.info?.id ?? d.id ?? '';
        enqueue(id, () => handle(e.type, d), failed(e.type));
      }
    })().catch((e) => {
      if (!ac.signal.aborted) failed('event stream')(e);
    });
    return () => {
      ac.abort();
      toolNames.clear();
      for (const set of pendingTools.values()) {
        for (const item of set) clearTimeout(item.timer);
      }
      pendingTools.clear();
    };
  },
});

export default opencodeProxy();
