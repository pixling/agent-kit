// Waits for what the user writes to the resident and queues it into the Codex
// session with `codex queue`, which starts a turn when the session is idle. Started
// at session start; ends with Codex (see hostGone).
//
// usage: codex-forwarder.mjs <namespace> <key> <hostPid|0> <threadId>
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { relay } from '../../core/Conversation.ts';
import { CurrentSession } from '../../core/services.ts';
import { type Relayed, userMessageForAgent } from '../../core/text.ts';
import { DaemonsLive } from '../../runtimes/Daemons.ts';
import { hostGone, ProxyBase } from '../../runtimes/base.ts';
import { lastActive, SessionLocks, sessionFiles } from '../../runtimes/SessionFiles.ts';
import { FORWARDER } from './index.ts';

const [namespace, key, hostPid, threadId] = process.argv.slice(2);
const QUEUE_TIMEOUT = '30 seconds';

const queue = (texts: ReadonlyArray<Relayed>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const session = yield* CurrentSession;
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(
          process.env.CODEX_BIN || 'codex',
          ['queue', '--thread', threadId, '--message', userMessageForAgent(texts, session)],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        ),
      )
      .pipe(Effect.timeout(QUEUE_TIMEOUT));
    if (Number(code) !== 0) return yield* Effect.fail(new Error('codex queue refused'));
  });

const session = DaemonsLive.pipe(Layer.provideMerge(sessionFiles({ namespace, key, author: 'Codex' })));

relay(queue).pipe(
  Effect.raceFirst(hostGone(Number(hostPid) || 0, lastActive(namespace, key))),
  Effect.ensuring(SessionLocks.use((locks) => locks.unlock(FORWARDER.lock))),
  Effect.provide(Layer.mergeAll(session, NodeServices.layer).pipe(Layer.provideMerge(ProxyBase))),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
