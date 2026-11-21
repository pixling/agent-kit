// pixling-proxy for DeepSeek Harness (dsh), as a Cordis plugin. Experimental:
// dsh is in developer preview and says its APIs will break.
//
// Each root session (not subagents) gets a resident once it starts a turn:
//   assistant/message each assistant message shows as it ends
//   tool/call        a tool call starts
//   turn/end         the final assistant text shows, unless it just did
//   approval/request asked on the resident while the dsh UI asks too; the first answer wins
//   relay            what the user writes steers the session (an idle one starts a turn)
//
// Steering needs the session controller of an interactive app (Web, Desktop).
// Without one (headless, SDK, ACP) nobody is there to type, so sessions get no
// resident unless `unattended` is set, and then only replies show.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Option, Schema } from 'effect';
import { log } from '../../runtimes/log.ts';
import type { SessionExtension } from '../../runtimes/base.ts';
import { makeLive } from '../../runtimes/live/index.ts';

// The parts of dsh this plugin uses.
interface DshAgent {
  session: unknown;
  steer(message: unknown): void;
}

interface Controller {
  agents: { get(id: string): DshAgent | undefined; withoutInitiator<T>(fn: () => Promise<T>): Promise<T> };
  sessions: { flush(session: unknown): Promise<void> };
  sessionController: { resolveAgent(id: string): Promise<{ agent: DshAgent } | { error: unknown }> };
}

interface DshSession {
  id: string | number;
  header?: { parentSession?: unknown };
}

interface SessionEvent {
  type: string;
  data?: unknown;
}

// The parts of an event this plugin reads. Anything else about them may change.
const AssistantMessage = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.Unknown) })),
  }),
});
const ToolCall = Schema.Struct({ name: Schema.String });
const TurnEnd = Schema.Struct({ reason: Schema.Struct({ kind: Schema.String }) });
const decodeMessage = Schema.decodeUnknownOption(AssistantMessage);
const decodeToolCall = Schema.decodeUnknownOption(ToolCall);
const decodeTurnEnd = Schema.decodeUnknownOption(TurnEnd);

interface ApprovalRequest {
  agent?: { session?: DshSession };
  toolName: string;
  reason?: string;
  displayReason?: { en: string; [locale: string]: string };
  signal?: AbortSignal;
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

interface Context {
  plugin(plugin: { name: string; inject: string[]; apply: (ctx: Controller) => void }): void;
  on(name: 'session/event', fn: (session: DshSession, ev: SessionEvent) => void): void;
  on(name: 'approval/request', fn: (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => unknown): void;
  effect(fn: () => () => void): void;
}

const NAME = 'pixling-proxy';

// The plugin, with what `extension` adds to every session (src/bin passes the emote
// extension; the adapter knows nothing of it).
export const dshProxy = (extension?: SessionExtension) => ({
  name: NAME,
  inject: ['agents', 'sessions'],
  apply: (ctx: Context) => applyAs(ctx, NAME, extension),
});

export const { name, inject, apply } = dshProxy();

// Not `apply` itself: cordis passes the plugin's config as its second argument.
function applyAs(ctx: Context, name: string, extension: SessionExtension | undefined): void {
  // Set once the interactive app's session controller is up.
  let controller: Controller | null = null;
  ctx.plugin({
    name: `${name}-steer`,
    inject: ['agents', 'sessions', 'sessionController'],
    apply: (c) => {
      controller = c;
    },
  });

  const live = makeLive(
    {
      namespace: 'dsh',
      author: 'dsh',
      deliver: (id, text) => steer(controller, id, text),
    },
    extension,
  );
  const texts = new Map<string, string>(); // session id → assistant text of the current turn

  ctx.on('session/event', (session, ev) => {
    if (session.header?.parentSession) return; // a subagent
    const id = String(session.id);
    switch (ev.type) {
      case 'turn/start':
        texts.set(id, '');
        if (controller || live.config.unattended) void live.start(id, { listen: controller !== null });
        break;
      case 'assistant/message': {
        void live.observe(id, { kind: 'reasoning', form: 'full', text: blocksOf(ev.data, 'reasoning') });
        const text = blocksOf(ev.data, 'text');
        if (text) {
          texts.set(id, text);
          void live.observe(id, { kind: 'text', text });
        }
        break;
      }
      case 'tool/call': {
        const call = decodeToolCall(ev.data);
        if (Option.isSome(call)) void live.observe(id, { kind: 'tool', name: call.value.name });
        break;
      }
      case 'turn/end': {
        if (Option.exists(decodeTurnEnd(ev.data), (end) => end.reason.kind === 'completed')) {
          void live.finish(id, texts.get(id));
        }
        texts.delete(id);
        break;
      }
    }
  });

  // Ask on the resident without holding back the dsh UI: both ask, the first
  // answer wins and the other question is withdrawn.
  ctx.on('approval/request', async (req, next) => {
    const session = req.agent?.session;
    const id = session && !session.header?.parentSession ? String(session.id) : undefined;
    if (!id || !live.has(id)) return next();
    const residentDone = new AbortController();
    const uiDone = new AbortController();
    req.signal?.addEventListener('abort', () => residentDone.abort(), { once: true });
    // The UI shows its card for as long as the request's signal lives; give it one
    // that also ends when the resident answers first.
    withSignal(req, req.signal ? AbortSignal.any([req.signal, uiDone.signal]) : uiDone.signal);
    const reason = req.displayReason?.[live.config.language] ?? req.displayReason?.en ?? req.reason;
    const onResident = live
      .permission(id, { tool: req.toolName, input: reason }, residentDone.signal)
      .then((answer): ApprovalOutcome | null =>
        answer ? (answer.decision === 'allow' ? 'allowed-once' : 'rejected') : null,
      );
    type Answer = { outcome: ApprovalOutcome; from: 'ui' | 'resident' };
    const fromUi: Promise<Answer> = next().then((outcome) => ({ outcome, from: 'ui' }));
    const fromResident: Promise<Answer> = onResident.then((outcome) =>
      outcome ? { outcome, from: 'resident' } : fromUi,
    );
    const first = await Promise.race([fromUi, fromResident]);
    if (first.from === 'ui') residentDone.abort();
    else uiDone.abort();
    return first.outcome;
  });

  ctx.effect(() => () => live.closeAll());
}

interface DshLlm {
  createUserMessage(message: { content: { type: 'text'; text: string }[]; source: { kind: 'user' } }): unknown;
}

// Hands the user's message to the session: an idle one starts a turn, a running
// one reads it at its next step.
async function steer(controller: Controller | null, id: string, text: string): Promise<void> {
  if (!controller) return;
  const llm = await dshImport('@deepseek-ai/dsh-llm');
  await controller.agents.withoutInitiator(async () => {
    let agent = controller.agents.get(id);
    if (!agent) {
      const resolved = await controller.sessionController.resolveAgent(id);
      if ('error' in resolved) throw resolved.error;
      agent = resolved.agent;
    }
    agent.steer(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await controller.sessions.flush(agent.session);
  });
  log(`client:dsh/${id} steered`);
}

// Swaps the request's signal before it reaches the next answerer.
function withSignal(req: ApprovalRequest, signal: AbortSignal): void {
  try {
    Object.defineProperty(req, 'signal', { value: signal, configurable: true, enumerable: true });
  } catch {
    // A frozen request keeps its own signal: the UI card then stays until answered.
  }
}

function blocksOf(data: unknown, type: 'text' | 'reasoning'): string {
  const event = decodeMessage(data);
  if (Option.isNone(event)) return '';
  return event.value.message.content
    .flatMap((c) => (c.type === type && typeof c.text === 'string' ? [c.text] : []))
    .join('\n')
    .trim();
}

// A package of the running dsh. The plugin may be loaded by path, away from
// dsh's own node_modules, so resolve from dsh's entry as well.
async function dshImport(spec: string): Promise<DshLlm> {
  try {
    return await import(spec);
  } catch {
    for (const base of [process.argv[1], `${process.cwd()}/package.json`]) {
      if (!base) continue;
      try {
        return await import(pathToFileURL(createRequire(base).resolve(spec)).href);
      } catch {
        // Try the next base.
      }
    }
    throw new Error(`pixling-proxy: cannot resolve ${spec} from the running dsh`);
  }
}
