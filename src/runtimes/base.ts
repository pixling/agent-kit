// What every runtime shares: the desk, the settings and the diagnostic log.
import { Cause, Clock, Effect, Layer, Logger, Predicate } from 'effect';
import { loadConfig } from '../core/config.ts';
import { type CurrentSession, ProxyConfig, type SessionStore } from '../core/services.ts';
import { Desk } from '../pixling/Desk.ts';
import { log } from './log.ts';
import { alive } from './process.ts';
import type { SessionLocks } from './SessionFiles.ts';

// Writes to the diagnostic log, never to stdout, which belongs to the host.
export const DiagnosticLog = Logger.layer([Logger.make(({ message }) => log([message].flat().join(' ')))]);

export const ProxyBase = Layer.mergeAll(
  Desk.layer,
  DiagnosticLog,
  Layer.sync(ProxyConfig)(() => ProxyConfig.of(loadConfig())),
);

// What a plugin adds to each session, on top of the proxy itself: services the
// session's programs read, such as how the resident reacts (core's Expression).
export type SessionExtension = Layer.Layer<
  never,
  never,
  CurrentSession | SessionStore | SessionLocks | ProxyConfig | Desk
>;

const HOST_CHECK = '15 seconds';
// A session whose host is not known (ps failed or took too long) is taken for gone once
// nothing happened in it for as long as a waiter waits for the user (6 h).
const QUIET_MS = 6 * 3600 * 1000;

// Ends once the host process exits, or, without its pid, once the session went quiet:
// `lastActive` is when it last did anything (0: unknown, as when its cache cannot be
// written; then from when this started).
export const hostGone = (pid: number, lastActive: () => number): Effect.Effect<void> =>
  pid
    ? Effect.gen(function* () {
        while (alive(pid)) yield* Effect.sleep(HOST_CHECK);
      })
    : Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        for (;;) {
          const quietFor = (yield* Clock.currentTimeMillis) - Math.max(started, lastActive());
          if (quietFor >= QUIET_MS) return;
          yield* Effect.sleep(QUIET_MS - quietFor);
        }
      });

// The kind of failure, or a defect's stack. A failure's message can quote what the
// host sent, and message bodies are never logged.
export const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  if (Predicate.isTagged(failure, 'SchemaError')) return 'SchemaError';
  return failure instanceof Error ? (failure.stack ?? failure.name) : 'unknown failure';
};
