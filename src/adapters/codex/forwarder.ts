// Waits for what the user writes to Codex residents and queues it into each Codex
// session with `codex queue`, which starts a turn when the session is idle.
//
// Two modes:
//   codex-forwarder.mjs --hub
//     Shared hub for every active Codex session on this Mac: one Node process and one
//     multiplexed `pixling --json inbox wait --multiplex` child (falling back cleanly to
//     per-session `pixling inbox wait` inside this same Node process on older CLIs).
//   codex-forwarder.mjs <namespace> <key> <hostPid|0> <threadId>
//     Single-session mode kept for direct callers and legacy locks.
import { type ChildProcess as NodeChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Fiber, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { relay } from '../../core/Conversation.ts';
import { CurrentSession } from '../../core/services.ts';
import { type Relayed, userMessageForAgent } from '../../core/text.ts';
import { cliPath } from '../../pixling/cli.ts';
import { Desk, type Pair } from '../../pixling/Desk.ts';
import { hostGone, ProxyBase } from '../../runtimes/base.ts';
import { DaemonsLive } from '../../runtimes/Daemons.ts';
import { log } from '../../runtimes/log.ts';
import {
  entryExpiredReason,
  FORWARDER_HUB_DIR,
  FORWARDER_HUB_LOCK,
  type HubEntry,
  hubEntriesDir,
  pairKey,
  readHubEntries,
  removeHubEntry,
} from '../../runtimes/ReceiverHub.ts';
import { deskLocks, lastActive, SessionLocks, sessionFiles } from '../../runtimes/SessionFiles.ts';
import { FORWARDER } from './index.ts';

const QUEUE_TIMEOUT = '30 seconds';
const SWEEP_MS = 15_000;
const EMPTY_EXIT_GRACE_MS = 250;
const MULTIPLEX_RESTART_MIN_MS = 500;
const MULTIPLEX_RESTART_MAX_MS = 15_000;
const QUICK_EXIT_MS = 5_000;

const makeQueue = (threadId: string) => (texts: ReadonlyArray<Relayed>) =>
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

const runSingleSession = (namespace: string, key: string, hostPid: string, threadId: string) => {
  const session = DaemonsLive.pipe(Layer.provideMerge(sessionFiles({ namespace, key, author: 'Codex' })));
  relay(makeQueue(threadId)).pipe(
    Effect.raceFirst(hostGone(Number(hostPid) || 0, lastActive(namespace, key))),
    Effect.ensuring(SessionLocks.use((locks) => locks.unlock(FORWARDER.lock))),
    Effect.provide(Layer.mergeAll(session, NodeServices.layer).pipe(Layer.provideMerge(ProxyBase))),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
};

// Shared `pixling --json inbox wait --multiplex` child controller. One CLI process
// subscribes to Darwin notifications for all Codex sessions; falls back to Desk.wait
// on older CLIs that reject `--multiplex` with exit code 64.
interface MultiplexWaitEvent {
  readonly event?: string;
  readonly namespace?: string;
  readonly key?: string;
}

type WaitOutcome = 'arrived' | 'ended' | 'retry';

class WaitMultiplexer {
  private child: NodeChildProcess | null = null;
  private unsupported = false;
  private restartBackoff = MULTIPLEX_RESTART_MIN_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly waiters = new Map<
    string,
    {
      readonly pair: Pair;
      readonly since: number;
      sent: boolean;
      resolve: (outcome: WaitOutcome) => void;
    }
  >();

  get isUnsupported(): boolean {
    return this.unsupported;
  }

  private writeLine(payload: Record<string, unknown>): boolean {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || child.killed || child.exitCode !== null || !stdin || stdin.destroyed || stdin.writableEnded) {
      return false;
    }
    try {
      stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private dropBrokenChild(child: NodeChildProcess, startedAt: number): void {
    if (this.child !== child) return;
    this.child = null;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
    const hadWaiters = this.waiters.size > 0;
    this.failAllWaiters('retry');
    if (!this.stopped && hadWaiters) this.scheduleRestart(startedAt);
  }

  private ensureChild(): void {
    if (this.stopped || this.unsupported || this.child || this.restartTimer || this.waiters.size === 0) return;
    const startedAt = Date.now();
    const child = spawn(cliPath(), ['--json', 'inbox', 'wait', '--multiplex'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    });
    this.child = child;
    let stdoutBuf = '';
    child.stdin?.on('error', () => {
      this.dropBrokenChild(child, startedAt);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (this.child !== child) return;
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) this.handleLine(line);
        nl = stdoutBuf.indexOf('\n');
      }
    });
    child.on('error', (err) => {
      log(`codex forwarder wait multiplex failed to start: ${err.message}`);
      this.dropBrokenChild(child, startedAt);
    });
    child.on('exit', (code) => {
      if (code === 64) {
        if (!this.unsupported) {
          this.unsupported = true;
          log('codex forwarder: CLI does not support inbox wait --multiplex; falling back to per-session inbox wait');
        }
        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
          this.restartTimer = null;
        }
        if (this.child === child) this.child = null;
        this.failAllWaiters('retry');
        return;
      }
      if (this.child !== child) return;
      this.child = null;
      const hadWaiters = this.waiters.size > 0;
      this.failAllWaiters('retry');
      if (!this.stopped && hadWaiters) this.scheduleRestart(startedAt);
    });
    for (const waiter of this.waiters.values()) {
      if (!waiter.sent) {
        waiter.sent = this.writeLine({
          op: 'add',
          namespace: waiter.pair.namespace,
          key: waiter.pair.key,
          since: waiter.since,
        });
        if (!waiter.sent) {
          this.dropBrokenChild(child, startedAt);
          return;
        }
      }
    }
  }

  private scheduleRestart(startedAt: number): void {
    if (this.stopped || this.unsupported || this.restartTimer) return;
    if (Date.now() - startedAt >= QUICK_EXIT_MS) this.restartBackoff = MULTIPLEX_RESTART_MIN_MS;
    const delay = this.restartBackoff;
    this.restartBackoff = Math.min(this.restartBackoff * 2, MULTIPLEX_RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensureChild();
    }, delay);
    this.restartTimer.unref();
  }

  private handleLine(line: string): void {
    let parsed: MultiplexWaitEvent;
    try {
      parsed = JSON.parse(line) as MultiplexWaitEvent;
    } catch {
      return;
    }
    if (typeof parsed.namespace !== 'string' || typeof parsed.key !== 'string') return;
    const id = pairKey(parsed.namespace, parsed.key);
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    if (parsed.event === 'arrived') {
      this.waiters.delete(id);
      waiter.resolve('arrived');
    } else if (parsed.event === 'ended') {
      this.waiters.delete(id);
      waiter.resolve('ended');
    }
  }

  private failAllWaiters(outcome: WaitOutcome): void {
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of pending) waiter.resolve(outcome);
  }

  wait(pair: Pair, since: number, timeoutMs: number): Effect.Effect<boolean> {
    return Effect.callback<boolean>((resume) => {
      const id = pairKey(pair.namespace, pair.key);
      let done = false;
      const finish = (outcome: WaitOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resume(Effect.succeed(outcome === 'arrived'));
      };
      const timer = setTimeout(() => {
        if (this.waiters.get(id) === entry) {
          this.waiters.delete(id);
          this.writeLine({ op: 'remove', namespace: pair.namespace, key: pair.key });
        }
        finish('ended');
      }, timeoutMs);
      timer.unref();

      const prev = this.waiters.get(id);
      if (prev) prev.resolve('retry');
      const entry = { pair, since, sent: false, resolve: finish };
      this.waiters.set(id, entry);
      this.ensureChild();
      if (this.child && !entry.sent) {
        entry.sent = this.writeLine({ op: 'add', namespace: pair.namespace, key: pair.key, since });
        if (!entry.sent) {
          this.dropBrokenChild(this.child, Date.now());
        }
      }
      return Effect.sync(() => {
        done = true;
        clearTimeout(timer);
        if (this.waiters.get(id) === entry) {
          this.waiters.delete(id);
          this.writeLine({ op: 'remove', namespace: pair.namespace, key: pair.key });
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.failAllWaiters('ended');
    if (this.child) {
      try {
        this.child.stdin?.end();
        this.child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
      this.child = null;
    }
  }
}

interface TrackedForwarder {
  entry: HubEntry;
  threadId: string;
  fiber: Fiber.Fiber<void, never> | null;
}

const runHub = () => {
  const dir = hubEntriesDir(FORWARDER_HUB_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hubLocks = deskLocks();
  const mux = new WaitMultiplexer();
  const tracked = new Map<string, TrackedForwarder>();
  let watcher: fs.FSWatcher | null = null;
  let emptyTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  const baseLayer = Layer.mergeAll(ProxyBase, NodeServices.layer);
  const hubBaseLayer = Layer.effect(
    Desk,
    Effect.map(Desk, (desk) =>
      Desk.of({
        ...desk,
        wait: (pair, options) =>
          mux.isUnsupported ? desk.wait(pair, options) : mux.wait(pair, options.since, options.timeoutMs),
      }),
    ),
  ).pipe(Layer.provideMerge(baseLayer));

  // Register state before `Effect.runFork`: Effect runs synchronously up to the first
  // async boundary, so an already-stowed session finishes `Effect.ensuring` before
  // `runFork` returns. Identity matching (`tracked.get(id) === state`) prevents a
  // stopped fiber's late teardown from touching a freshly re-registered session.
  const startTracked = (entry: HubEntry, threadId: string) => {
    const id = pairKey(entry.namespace, entry.key);
    const state: TrackedForwarder = { entry, threadId, fiber: null };
    tracked.set(id, state);
    const sessionLayer = DaemonsLive.pipe(
      Layer.provideMerge(sessionFiles({ namespace: entry.namespace, key: entry.key, author: 'Codex' })),
      Layer.provideMerge(hubBaseLayer),
    );
    const program = relay(makeQueue(threadId)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (tracked.get(id) === state && !shuttingDown) {
            tracked.delete(id);
            Effect.runSync(removeHubEntry(entry.namespace, entry.key, FORWARDER_HUB_DIR));
            scheduleEmptyCheck();
          }
        }),
      ),
      Effect.provide(sessionLayer),
      Effect.catchCause(() => Effect.void),
    );
    const fiber = Effect.runFork(program);
    if (tracked.get(id) === state) state.fiber = fiber;
  };

  const stopTracked = (id: string) => {
    const state = tracked.get(id);
    if (!state) return;
    tracked.delete(id);
    if (state.fiber) Effect.runFork(Fiber.interrupt(state.fiber));
  };

  const scheduleEmptyCheck = () => {
    if (shuttingDown || tracked.size > 0 || emptyTimer) return;
    emptyTimer = setTimeout(() => {
      emptyTimer = null;
      reconcile();
      if (tracked.size > 0 || shuttingDown) return;
      Effect.runSync(hubLocks.unlock(FORWARDER_HUB_LOCK));
      if (readHubEntries(FORWARDER_HUB_DIR).length > 0 && Effect.runSync(hubLocks.lock(FORWARDER_HUB_LOCK))) {
        reconcile();
        return;
      }
      shutdown(0);
    }, EMPTY_EXIT_GRACE_MS);
    emptyTimer.unref();
  };

  const reconcile = () => {
    if (shuttingDown) return;
    const now = Date.now();
    const entries = readHubEntries(FORWARDER_HUB_DIR);
    const seen = new Set<string>();
    for (const entry of entries) {
      const id = pairKey(entry.namespace, entry.key);
      const threadId = entry.extra?.[0];
      const expired = !threadId ? 'missingThread' : entryExpiredReason(entry, now);
      if (expired) {
        log(`codex forwarder hub retiring ${entry.namespace}/${entry.key} (${expired})`);
        Effect.runSync(removeHubEntry(entry.namespace, entry.key, FORWARDER_HUB_DIR));
        stopTracked(id);
        continue;
      }
      seen.add(id);
      const existing = tracked.get(id);
      if (existing && existing.threadId === threadId) {
        existing.entry = entry;
      } else {
        if (existing) stopTracked(id);
        startTracked(entry, threadId!);
      }
    }
    for (const id of tracked.keys()) {
      if (!seen.has(id)) stopTracked(id);
    }
    if (tracked.size > 0) {
      if (emptyTimer) {
        clearTimeout(emptyTimer);
        emptyTimer = null;
      }
    } else {
      scheduleEmptyCheck();
    }
  };

  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweepTimer);
    if (emptyTimer) clearTimeout(emptyTimer);
    watcher?.close();
    watcher = null;
    for (const id of tracked.keys()) stopTracked(id);
    mux.stop();
    Effect.runSync(hubLocks.unlock(FORWARDER_HUB_LOCK));
    process.exit(code);
  };

  const sweepTimer = setInterval(reconcile, SWEEP_MS);
  try {
    watcher = fs.watch(dir, () => reconcile());
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    // Fallback to sweep timer if fs.watch fails.
  }

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  reconcile();
};

if (process.argv[2] === '--hub') {
  runHub();
} else {
  const [namespace, key, hostPid, threadId] = process.argv.slice(2);
  runSingleSession(namespace, key, hostPid, threadId);
}
