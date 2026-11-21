// Starts and stops the proxy's background processes. Their scripts are built next
// to the module that bundles this one.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Effect, Layer } from 'effect';
import { CurrentSession, ProxyConfig, Receiver, SessionStore } from '../core/services.ts';
import { log } from './log.ts';
import { nodeRuntime } from './process.ts';
import { HUB_LOCK, RECEIVER_HUB_DIR, registerHubEntry, removeHubEntry } from './ReceiverHub.ts';
import { deskLocks, SessionLocks } from './SessionFiles.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// A background process: either per-session (held through a session lock) or shared
// across every session on this Mac via a desk-scoped hub registry.
export interface Daemon {
  readonly lock: string;
  readonly script: string;
  readonly hub?: { readonly dir: string; readonly lock: string };
}

// Keeps the inbox open so the user can type to the resident.
export const RECEIVER: Daemon = {
  lock: 'receiver',
  script: 'receiver-daemon.mjs',
  hub: { dir: RECEIVER_HUB_DIR, lock: HUB_LOCK },
};

export class Daemons extends Context.Service<
  Daemons,
  {
    start(
      daemon: Daemon,
      options: {
        // The host process; the daemon exits with it.
        readonly hostPid: number | null;
        // Outlive the caller. A hook exits right away, so its daemons are detached;
        // a plugin living in the host process keeps them as plain children.
        readonly detached?: boolean;
        // Arguments after <namespace> <key> <hostPid>.
        readonly extra?: ReadonlyArray<string>;
      },
    ): Effect.Effect<void>;
    stop(daemon: Daemon): Effect.Effect<void>;
  }
>()('pixling-proxy/runtimes/Daemons') {}

// A daemon outlives the program that starts it and answers to nobody but its lock,
// so this is a plain fire-and-forget `spawn`, with no handle to keep.
const DaemonsOnly = Layer.effect(Daemons)(
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    const store = yield* SessionStore;
    const locks = yield* SessionLocks;
    const config = yield* ProxyConfig;
    return Daemons.of({
      start: Effect.fn('Daemons.start')(function* (daemon, { hostPid, detached = true, extra = [] }) {
        if (!config.receive || (yield* store.isStowed)) return;
        if (daemon.hub) {
          yield* registerHubEntry(
            {
              namespace: session.namespace,
              key: session.key,
              hostPid: hostPid ?? 0,
              // Live in-process plugins (`detached: false`) own their own idleCloseMs timers;
              // hook hosts (`detached: true`) rely on the hub to expire quiet sessions.
              idleCloseMs: detached ? config.idleCloseMs : 0,
              registeredAt: Date.now(),
              ...(extra.length ? { extra } : {}),
            },
            daemon.hub.dir,
          );
          const hubLocks = deskLocks();
          if (yield* hubLocks.lock(daemon.hub.lock)) {
            const child = yield* Effect.sync(() => {
              const child = spawn(nodeRuntime(), [path.join(here, daemon.script), '--hub'], {
                detached: true,
                stdio: 'ignore',
                env: process.env,
              });
              child.on('error', (e) => log(`${daemon.hub!.lock} failed to start: ${e.message}`));
              child.unref();
              return child;
            });
            if (!child.pid) return yield* hubLocks.unlock(daemon.hub.lock);
            yield* hubLocks.handOver(daemon.hub.lock, child.pid);
            yield* Effect.logInfo(`${session.selector} ${daemon.hub.lock} started ${child.pid}`);
          }
          return;
        }
        if (!(yield* locks.lock(daemon.lock))) return;
        const child = yield* Effect.sync(() => {
          const child = spawn(
            nodeRuntime(),
            [path.join(here, daemon.script), session.namespace, session.key, String(hostPid ?? 0), ...extra],
            { detached, stdio: 'ignore', env: process.env },
          );
          // No Node.js on PATH: no daemon, but the host carries on.
          child.on('error', (e) => log(`${session.selector} ${daemon.lock} failed to start: ${e.message}`));
          if (detached) child.unref();
          return child;
        });
        if (!child.pid) return yield* locks.unlock(daemon.lock);
        yield* locks.handOver(daemon.lock, child.pid);
        yield* Effect.logInfo(`${session.selector} ${daemon.lock} started ${child.pid} host=${hostPid ?? 0}`);
      }),
      stop: Effect.fn('Daemons.stop')(function* (daemon) {
        if (daemon.hub) {
          yield* removeHubEntry(session.namespace, session.key, daemon.hub.dir);
        }
        const pid = yield* locks.stopHolder(daemon.lock);
        if (pid) yield* Effect.logInfo(`${session.selector} stopping ${daemon.lock} ${pid}`);
      }),
    });
  }),
);

export const DaemonsLive = Layer.provideMerge(
  Layer.effect(Receiver)(Effect.map(Daemons, (daemons) => Receiver.of({ stop: daemons.stop(RECEIVER) }))),
  DaemonsOnly,
);
