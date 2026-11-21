// The runtime for plugins that live in the host process: one resident per host
// session, each with its receiver and a relay that hands what the user writes to the
// host until the session closes. Adapters see a plain Promise API, which is what
// host callbacks need; every failure is logged and swallowed, so a host never sees one.
import { randomUUID } from 'node:crypto';
import { Context, Effect, Layer, LayerMap, ManagedRuntime, Ref, Semaphore } from 'effect';
import type { Activity } from '../../core/Activity.ts';
import {
  type PermissionAnswer,
  askPermission,
  ensureResident,
  observed,
  relay,
  showPending,
  turnEnded,
} from '../../core/Conversation.ts';
import { loadConfig } from '../../core/config.ts';
import { ActivitySource, CurrentSession, ProxyConfig, Receiver, type SessionStore } from '../../core/services.ts';
import type { Desk } from '../../pixling/Desk.ts';
import { type Relayed, userMessageForAgent } from '../../core/text.ts';
import { Daemons, DaemonsLive, RECEIVER } from '../Daemons.ts';
import { sessionFiles } from '../SessionFiles.ts';
import { describeFailure, ProxyBase, type SessionExtension } from '../base.ts';

export interface LiveHost {
  readonly namespace: string;
  readonly author: string;
  // Hands the user's message, worded for the agent, to the host session `id`.
  deliver(id: string, message: string): unknown;
  // Told when the session had activity this runtime cannot see by itself.
  active?(id: string): void;
}

class CurrentHost extends Context.Service<CurrentHost, LiveHost>()('pixling-proxy/runtimes/live/CurrentHost') {}

// Starts relaying what the user writes, for as long as the session stays open.
class Listener extends Context.Service<Listener, { readonly listen: Effect.Effect<void> }>()(
  'pixling-proxy/runtimes/live/Listener',
) {}

// Activities kept waiting, the newest ones, should nothing get them to the resident.
const WAITING_MAX = 200;

// A host tells what happens as it happens, so what waits is held here. A permission
// prompt flushes outside the queue of `show`, so a flush takes its turn here too.
const LiveActivities = Layer.effect(ActivitySource)(
  Effect.gen(function* () {
    const waiting = yield* Ref.make<ReadonlyArray<Activity>>([]);
    const stretch = yield* Ref.make(0);
    const run = randomUUID();
    const turn = yield* Semaphore.make(1);
    return ActivitySource.of({
      observe: (activity) => Ref.update(waiting, (items) => [...items, activity].slice(-WAITING_MAX)),
      drain: (show) =>
        turn.withPermits(1)(
          Effect.gen(function* () {
            const items = yield* Ref.get(waiting);
            if (!items.length) return;
            if (yield* show({ items, position: `${run}:${yield* Ref.get(stretch)}` })) {
              yield* Ref.update(waiting, (now) => now.slice(items.length));
              yield* Ref.update(stretch, (n) => n + 1);
            }
          }),
        ),
      // What waits was told before the reply, so its own text can only be there already.
      replied: (text) =>
        Ref.update(waiting, (items) => {
          const at = items.findIndex((item) => item.kind === 'text' && item.text.trim() === text);
          return at < 0 ? items : items.toSpliced(at, 1);
        }),
    });
  }),
);

const LiveListener = (id: string) =>
  Layer.effect(Listener)(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const host = yield* CurrentHost;
      const config = yield* ProxyConfig;
      const daemons = yield* Daemons;
      const context = yield* Effect.context<CurrentSession | SessionStore | ProxyConfig | Desk | Receiver>();
      const session = yield* CurrentSession;
      const deliver = (texts: ReadonlyArray<Relayed>) =>
        Effect.tryPromise(async () => host.deliver(id, userMessageForAgent(texts, session))).pipe(
          Effect.tap(() => Effect.sync(() => host.active?.(id))),
        );
      yield* Effect.addFinalizer(() => daemons.stop(RECEIVER));
      return Listener.of({
        listen: Effect.gen(function* () {
          // The plugin lives as long as the host, so the receiver is a plain child process.
          yield* daemons.start(RECEIVER, { hostPid: process.pid, detached: false });
          if (config.receive) {
            yield* relay(deliver).pipe(
              Effect.provideContext(context),
              Effect.catchCause((cause) => Effect.logInfo(`relay ended: ${describeFailure(cause)}`)),
              Effect.forkIn(scope),
            );
          }
        }),
      });
    }),
  );

// What the plugin adds to every session (see SessionExtension).
class CurrentExtension extends Context.Service<CurrentExtension, SessionExtension>()(
  'pixling-proxy/runtimes/live/CurrentExtension',
) {}

const sessionLayer = (id: string) =>
  Layer.unwrap(
    Effect.map(Effect.all([CurrentHost, CurrentExtension]), ([{ namespace, author }, extension]) =>
      Layer.mergeAll(LiveActivities, LiveListener(id), extension).pipe(
        Layer.provideMerge(DaemonsLive),
        Layer.provideMerge(sessionFiles({ namespace, key: id, author })),
      ),
    ),
  );

class Sessions extends LayerMap.Service<Sessions>()('pixling-proxy/runtimes/live/Sessions', {
  // Fresh: a layer map builds every key with one memo, which would hand all sessions
  // the first session's activities and daemons.
  lookup: (id: string) => Layer.fresh(sessionLayer(id)),
  // A session lives until the host closes it, not until the last call returns.
  idleTimeToLive: 'Infinity',
}) {}

type SessionServices = Layer.Success<ReturnType<typeof sessionLayer>> | Desk | ProxyConfig;

// `extension`: what the plugin adds to every session, such as the emote extension.
export const makeLive = (host: LiveHost, extension: SessionExtension = Layer.empty) => {
  const runtime = ManagedRuntime.make(
    Sessions.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ProxyBase,
          Layer.succeed(CurrentHost)({ ...host, active: (id) => touch(id) }),
          Layer.succeed(CurrentExtension)(extension),
        ),
      ),
    ),
  );
  const open = new Map<string, Promise<void>>();
  // Sessions that found no Pixling. Their next start tries again, since Pixling may
  // start long after a host that lives for days.
  const unreached = new Set<string>();
  const retrying = new Set<string>();
  // What is asking on a session's resident, to withdraw when the session closes.
  const asking = new Map<string, Set<AbortController>>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // What the agent said, still on its way to the resident. A host may not wait for
  // one text before the next, so each session's texts go one at a time, in order; and
  // a session may close right after its last reply (a short run), which must still arrive.
  const showing = new Map<string, Promise<unknown>>();
  const shown = () => Promise.allSettled(showing.values());

  const inSession = <A, E>(
    id: string,
    program: Effect.Effect<A, E, SessionServices>,
    fallback: A,
    signal?: AbortSignal,
  ): Promise<A> =>
    runtime
      .runPromise(
        program.pipe(
          Effect.provide(Sessions.get(id)),
          Effect.catchCause((cause) =>
            Effect.logInfo(`${host.namespace} ${id} failed: ${describeFailure(cause)}`).pipe(Effect.as(fallback)),
          ),
        ),
        signal ? { signal } : undefined,
      )
      // Interrupted: the host got its answer elsewhere, or is shutting down.
      .catch(() => fallback);

  const show = (id: string, program: Effect.Effect<void, never, SessionServices>): Promise<void> => {
    const started = open.get(id);
    if (!started) return Promise.resolve();
    const next = Promise.allSettled([started, showing.get(id)]).then(() => inSession(id, program, undefined));
    showing.set(id, next);
    return next;
  };

  const config = loadConfig();

  // A host may never say a session ended: one left alone stops listening, and holds
  // no process, until something happens in it again.
  const touch = (id: string): void => {
    clearTimeout(idleTimers.get(id));
    if (!config.idleCloseMs || !open.has(id)) return;
    const timer = setTimeout(() => close(id), config.idleCloseMs);
    timer.unref?.();
    idleTimers.set(id, timer);
  };

  const close = (id: string): void => {
    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
    unreached.delete(id);
    retrying.delete(id);
    // What still waits goes first, whatever the time. `show` needs the session open.
    if (open.has(id)) void show(id, showPending({ force: true }));
    if (!open.delete(id)) return;
    for (const asked of asking.get(id) ?? []) asked.abort();
    void shown().then(() => {
      // Started again meanwhile: the session is in use.
      if (open.has(id)) return;
      showing.delete(id);
      return runtime.runPromise(Sessions.invalidate(id)).catch(() => {});
    });
  };

  return {
    // The settings, for hosts that decide from them whether to start a session.
    config,

    // Binds the resident for session `id` (once) and starts listening to it.
    // `listen: false` only shows replies: for runs nobody watches.
    start(id: string, { listen = true } = {}): Promise<void> {
      touch(id);
      const known = open.get(id);
      if (known && (!unreached.has(id) || retrying.has(id))) return known;
      retrying.add(id);
      const started = inSession(
        id,
        Effect.gen(function* () {
          const state = yield* ensureResident();
          retrying.delete(id);
          if (state === null) unreached.add(id);
          else unreached.delete(id);
          if (state !== 'onDesk' || !listen) return;
          const listener = yield* Listener;
          yield* listener.listen;
        }),
        undefined,
      );
      open.set(id, started);
      touch(id);
      return started;
    },

    has: (id: string) => open.has(id),

    // Something the agent did. The settings decide whether and when it shows.
    observe(id: string, activity: Activity): Promise<void> {
      touch(id);
      // Nobody there to read it: days later, it would only be old news.
      if (unreached.has(id)) return Promise.resolve();
      return show(id, observed(activity));
    },

    // The turn's reply, after everything still waiting.
    finish(id: string, text: string | null | undefined): Promise<void> {
      touch(id);
      return show(id, turnEnded(text));
    },

    // A permission prompt, as a question on the resident. Aborting `signal` withdraws it.
    async permission(
      id: string,
      request: { readonly tool: string; readonly input: unknown },
      signal?: AbortSignal,
    ): Promise<PermissionAnswer | null> {
      touch(id);
      await open.get(id);
      if (!open.has(id) || signal?.aborted) return null;
      const asked = new AbortController();
      signal?.addEventListener('abort', () => asked.abort(), { once: true });
      const all = asking.get(id) ?? new Set();
      asking.set(id, all.add(asked));
      try {
        return await inSession(id, askPermission(request), null, asked.signal);
      } finally {
        all.delete(asked);
        if (!all.size) asking.delete(id);
      }
    },

    // Stops listening for session `id`, ending the wait in progress so the host can
    // exit, once what the agent said has been shown. Withdraws what it was asking.
    close,

    closeAll(): void {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      for (const id of open.keys()) void show(id, showPending({ force: true }));
      open.clear();
      void shown().then(() => runtime.dispose().catch(() => {}));
    },
  };
};
