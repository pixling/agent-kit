// Starts and stops the proxy's background processes. Their scripts are built next
// to the module that bundles this one.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Effect, Layer } from 'effect';
import { CurrentSession, ProxyConfig, Receiver, SessionStore } from '../core/services.ts';
import { log } from './log.ts';
import { nodeRuntime } from './process.ts';
import { SessionLocks } from './SessionFiles.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// A background process, one of each kind per session, held through a session lock.
export interface Daemon {
  readonly lock: string;
  readonly script: string;
}

// Keeps the inbox open so the user can type to the resident.
export const RECEIVER: Daemon = { lock: 'receiver', script: 'receiver-daemon.mjs' };

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
        if (!config.receive || (yield* store.isStowed) || !(yield* locks.lock(daemon.lock))) return;
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
