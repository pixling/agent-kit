// Keeps `pixling inbox receive` held for one session so the user can type to the
// resident. Started by the proxy; ends when the user puts the resident away, the
// binding is gone, or the host process exits (see hostGone).
//
// usage: receiver-daemon.mjs <namespace> <key> <hostPid|0>
import { NodeRuntime } from '@effect/platform-node';
import { Clock, Effect, Layer } from 'effect';
import { Desk } from '../pixling/Desk.ts';
import { hostGone, ProxyBase } from '../runtimes/base.ts';
import { RECEIVER } from '../runtimes/Daemons.ts';
import { lastActive, SessionLocks, sessionFiles } from '../runtimes/SessionFiles.ts';

// While a new resident may still be appearing, "not bound" is worth another try.
const APPEARING_MS = 30_000;
// A hold that lasted this long was healthy: retries start over.
const HEALTHY_MS = 60_000;
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

const [namespace, key, hostPidArg] = process.argv.slice(2);
const hostPid = Number(hostPidArg) || 0;
const label = `receiver ${namespace}/${key}`;

const hold = Effect.gen(function* () {
  const desk = yield* Desk;
  const born = yield* Clock.currentTimeMillis;
  let backoff = BACKOFF_MS;
  while (true) {
    const started = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo(`${label} holding (pid ${process.pid}, host ${hostPid})`);
    const end = yield* desk.hold({ namespace, key }).pipe(Effect.orElseSucceed(() => 'retry' as const));
    yield* Effect.logInfo(`${label} inbox receive ended: ${end}`);
    const now = yield* Clock.currentTimeMillis;
    // Anything but these (Pixling restarted, CLI connection off): try again, slowly,
    // while the host is alive.
    if (end === 'closed' || end === 'invalid' || (end === 'notBound' && now - born > APPEARING_MS)) return;
    if (now - started > HEALTHY_MS) backoff = BACKOFF_MS;
    yield* Effect.sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
});

hold.pipe(
  Effect.raceFirst(hostGone(hostPid, lastActive(namespace, key))),
  Effect.ensuring(SessionLocks.use((locks) => locks.unlock(RECEIVER.lock))),
  Effect.provide(Layer.merge(ProxyBase, sessionFiles({ namespace, key, author: '' }))),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
