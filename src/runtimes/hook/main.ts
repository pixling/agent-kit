// The hook runtime: one process, one event. Reads the payload from stdin, writes
// the answer to stdout, and turns every failure into "nothing to do": a missing
// Pixling or a changed payload never gets in the agent's way.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Schema, Stdio, Stream } from 'effect';
import { ProxyConfig } from '../../core/services.ts';
import { describeFailure, ProxyBase, type SessionExtension } from '../base.ts';
import { BUDGET_SECONDS } from './budgets.ts';
import { handleEvent, type HookEvent, idle } from './events.ts';
import type { HookHost, HookOutput } from './HookHost.ts';

const WAKE_EXIT_CODE = 2;

const readPayload = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text);
});

const writeOutput = Effect.fn('hook.writeOutput')(function* ({ stdout, wake }: HookOutput) {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(JSON.stringify(stdout)).pipe(Stream.run(stdio.stdout()));
  if (wake) {
    yield* Stream.make(wake).pipe(Stream.run(stdio.stderr()));
    process.exitCode = WAKE_EXIT_CODE;
  }
});

// The event's budget, and however long the settings hold a turn open on top of it,
// less what starting and loading the program already took (the host's timer started
// with the process; loading blocks the thread, so no timer could fire during it).
const withinBudget =
  (event: HookEvent) =>
  <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.flatMap(ProxyConfig, (config) => {
      const seconds: number | null = BUDGET_SECONDS[event];
      if (seconds === null) return program;
      const budgetMs = seconds * 1000 + (event === 'stop' ? config.turnEndWaitMs : 0);
      return Effect.timeout(program, Math.max(0, budgetMs - process.uptime() * 1000));
    });

export const runHook = (adapter: Layer.Layer<HookHost>, event: HookEvent, extension?: SessionExtension): void =>
  readPayload.pipe(
    Effect.flatMap((raw) => handleEvent(event, raw, extension)),
    withinBudget(event),
    Effect.catchCause((cause) =>
      Effect.logInfo(`error ${event}: ${describeFailure(cause)}`).pipe(Effect.andThen(idle(event))),
    ),
    Effect.flatMap(writeOutput),
    Effect.ignore,
    Effect.provide(Layer.mergeAll(ProxyBase, NodeServices.layer, adapter)),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
