// Keeps `pixling inbox receive` held so the user can type to their resident(s).
//
// Hub mode (default):
//   receiver-daemon.mjs --hub
//   One shared process per Mac holds every active session registered under
//   ~/.cache/pixling-proxy/.receiver-hub/entries/ over one multiplexed
//   `pixling --json inbox receive --multiplex` child (falling back cleanly to
//   per-key `pixling inbox receive` children if an older CLI rejects --multiplex).
//   Exits automatically once no entries remain.
//
// Single-session mode (direct / legacy invocation):
//   receiver-daemon.mjs <namespace> <key> <hostPid|0>
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { NodeRuntime } from '@effect/platform-node';
import { Clock, Effect, Layer } from 'effect';
import { cliPath } from '../pixling/cli.ts';
import { Desk, type HoldEnd } from '../pixling/Desk.ts';
import { hostGone, ProxyBase } from '../runtimes/base.ts';
import { RECEIVER } from '../runtimes/Daemons.ts';
import { log } from '../runtimes/log.ts';
import {
  entryExpiredReason,
  HUB_LOCK,
  type HubEntry,
  hubEntriesDir,
  pairKey,
  readHubEntries,
  removeHubEntry,
} from '../runtimes/ReceiverHub.ts';
import { deskLocks, lastActive, SessionLocks, sessionFiles } from '../runtimes/SessionFiles.ts';

// While a new resident may still be appearing, "not bound" is worth another try.
const APPEARING_MS = 30_000;
// A hold that lasted this long was healthy: retries start over.
const HEALTHY_MS = 60_000;
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const SWEEP_MS = 15_000;
const EMPTY_EXIT_GRACE_MS = 250;
const HOLD_ENDS: Record<number, HoldEnd> = { 0: 'closed', 64: 'invalid', 5: 'notBound' };

const runHub = (): void => {
  const dir = hubEntriesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  interface Tracked {
    entry: HubEntry;
    held: boolean;
    startedAt: number;
    backoffMs: number;
    retryTimer: ReturnType<typeof setTimeout> | null;
    fallbackChild: ChildProcess | null;
  }

  const tracked = new Map<string, Tracked>();
  let multiplexChild: ChildProcess | null = null;
  let multiplexRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let multiplexBackoffMs = BACKOFF_MS;
  let multiplexBuffer = '';
  let multiplexUnsupported = false;
  let emptyTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let watcher: fs.FSWatcher | null = null;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer);
  };

  const dropEntryFile = (namespace: string, key: string) => {
    Effect.runSync(removeHubEntry(namespace, key));
  };

  const writeMultiplex = (command: { op: 'add' | 'remove'; namespace: string; key: string }): boolean => {
    const child = multiplexChild;
    if (!child || !child.stdin || child.stdin.destroyed || child.killed || child.exitCode !== null) return false;
    try {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const handleHoldEnded = (id: string, end: HoldEnd) => {
    const state = tracked.get(id);
    if (!state || shuttingDown) return;
    state.held = false;
    state.fallbackChild = null;
    const now = Date.now();
    const { namespace, key, registeredAt } = state.entry;
    log(`receiver ${namespace}/${key} inbox receive ended: ${end}`);
    if (end === 'closed' || end === 'invalid' || (end === 'notBound' && now - registeredAt > APPEARING_MS)) {
      clearTimer(state.retryTimer);
      tracked.delete(id);
      dropEntryFile(namespace, key);
      maybeScheduleEmptyExit();
      return;
    }
    if (now - state.startedAt > HEALTHY_MS) state.backoffMs = BACKOFF_MS;
    const delay = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
    clearTimer(state.retryTimer);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (tracked.has(id) && !shuttingDown) startHold(id);
    }, delay);
  };

  const startFallbackChild = (id: string, state: Tracked) => {
    if (state.fallbackChild || shuttingDown) return;
    state.held = true;
    state.startedAt = Date.now();
    const { namespace, key } = state.entry;
    const child = spawn(cliPath(), ['--json', 'inbox', 'receive', `--namespace=${namespace}`, `--key=${key}`], {
      stdio: 'ignore',
      env: process.env,
    });
    state.fallbackChild = child;
    child.on('error', () => {
      if (state.fallbackChild === child) handleHoldEnded(id, 'retry');
    });
    child.on('exit', (code) => {
      if (state.fallbackChild === child) handleHoldEnded(id, HOLD_ENDS[code ?? -1] ?? 'retry');
    });
  };

  const ensureMultiplexChild = (): boolean => {
    if (multiplexUnsupported || shuttingDown) return false;
    if (multiplexChild && !multiplexChild.killed && multiplexChild.exitCode === null) return true;
    if (multiplexRestartTimer) return false;
    const startedAt = Date.now();
    const child = spawn(cliPath(), ['--json', 'inbox', 'receive', '--multiplex'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    });
    multiplexChild = child;
    multiplexBuffer = '';
    child.stdin?.on('error', () => {
      // EPIPE if child exited (e.g. exit 64 or crash) while writing; exit handler recovers.
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      multiplexBuffer += chunk;
      let nl = multiplexBuffer.indexOf('\n');
      while (nl >= 0) {
        const line = multiplexBuffer.slice(0, nl).trim();
        multiplexBuffer = multiplexBuffer.slice(nl + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as { event?: string; namespace?: string; key?: string; end?: string };
            if (
              event.event === 'ended' &&
              typeof event.namespace === 'string' &&
              typeof event.key === 'string' &&
              (event.end === 'closed' || event.end === 'invalid' || event.end === 'notBound' || event.end === 'retry')
            ) {
              handleHoldEnded(pairKey(event.namespace, event.key), event.end);
            }
          } catch {
            // Ignore non-event lines.
          }
        }
        nl = multiplexBuffer.indexOf('\n');
      }
    });
    child.on('error', (err) => {
      log(`receiver hub multiplex spawn failed: ${err.message}`);
      if (multiplexChild !== child) return;
      multiplexChild = null;
      for (const state of tracked.values()) state.held = false;
      scheduleMultiplexRestart(startedAt);
    });
    child.on('exit', (code) => {
      if (multiplexChild !== child) return;
      multiplexChild = null;
      if (shuttingDown) return;
      if (code === 64) {
        log('receiver hub: CLI does not support --multiplex, falling back to per-key children');
        multiplexUnsupported = true;
        for (const [id, state] of tracked) {
          state.held = false;
          startHold(id);
        }
        return;
      }
      log(`receiver hub multiplex exited (${code ?? 'signal'})`);
      for (const state of tracked.values()) state.held = false;
      scheduleMultiplexRestart(startedAt);
    });
    return true;
  };

  const scheduleMultiplexRestart = (startedAt: number) => {
    if (shuttingDown || multiplexRestartTimer || tracked.size === 0) return;
    if (Date.now() - startedAt > HEALTHY_MS) multiplexBackoffMs = BACKOFF_MS;
    const delay = multiplexBackoffMs;
    multiplexBackoffMs = Math.min(multiplexBackoffMs * 2, BACKOFF_MAX_MS);
    multiplexRestartTimer = setTimeout(() => {
      multiplexRestartTimer = null;
      if (shuttingDown || tracked.size === 0) return;
      if (ensureMultiplexChild()) {
        for (const [id, state] of tracked) {
          if (!state.held && !state.retryTimer) startHold(id);
        }
      }
    }, delay);
  };

  const startHold = (id: string) => {
    const state = tracked.get(id);
    if (!state || state.held || shuttingDown) return;
    if (multiplexUnsupported) {
      startFallbackChild(id, state);
      return;
    }
    if (!ensureMultiplexChild()) return;
    state.held = true;
    state.startedAt = Date.now();
    if (!writeMultiplex({ op: 'add', namespace: state.entry.namespace, key: state.entry.key })) {
      state.held = false;
    }
  };

  const stopHold = (id: string) => {
    const state = tracked.get(id);
    if (!state) return;
    clearTimer(state.retryTimer);
    state.retryTimer = null;
    if (state.fallbackChild) {
      const child = state.fallbackChild;
      state.fallbackChild = null;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    } else if (state.held) {
      writeMultiplex({ op: 'remove', namespace: state.entry.namespace, key: state.entry.key });
    }
    tracked.delete(id);
  };

  const maybeScheduleEmptyExit = () => {
    if (shuttingDown) return;
    if (tracked.size > 0) {
      clearTimer(emptyTimer);
      emptyTimer = null;
      return;
    }
    if (emptyTimer) return;
    emptyTimer = setTimeout(() => {
      emptyTimer = null;
      reconcile();
      if (tracked.size > 0) return;
      // Release HUB_LOCK before exiting, then re-check entries so a concurrent
      // registration that saw the lock held cannot be stranded without a hub.
      const hubLocks = deskLocks();
      Effect.runSync(hubLocks.unlock(HUB_LOCK));
      if (readHubEntries().length > 0 && Effect.runSync(hubLocks.lock(HUB_LOCK))) {
        reconcile();
        return;
      }
      shutdown(0);
    }, EMPTY_EXIT_GRACE_MS);
  };

  const reconcile = () => {
    if (shuttingDown) return;
    const now = Date.now();
    const diskEntries = readHubEntries();
    const desired = new Map<string, HubEntry>();
    for (const entry of diskEntries) {
      const expired = entryExpiredReason(entry, now);
      if (expired) {
        log(`receiver ${entry.namespace}/${entry.key} expired (${expired})`);
        dropEntryFile(entry.namespace, entry.key);
        continue;
      }
      desired.set(pairKey(entry.namespace, entry.key), entry);
    }

    for (const id of tracked.keys()) {
      if (!desired.has(id)) stopHold(id);
    }

    for (const [id, entry] of desired) {
      const existing = tracked.get(id);
      if (existing) {
        existing.entry = entry;
        if (!existing.held && !existing.retryTimer) startHold(id);
      } else {
        tracked.set(id, {
          entry,
          held: false,
          startedAt: 0,
          backoffMs: BACKOFF_MS,
          retryTimer: null,
          fallbackChild: null,
        });
        startHold(id);
      }
    }
    maybeScheduleEmptyExit();
  };

  const shutdown = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimer(emptyTimer);
    clearTimer(multiplexRestartTimer);
    clearInterval(sweepTimer);
    watcher?.close();
    for (const id of tracked.keys()) stopHold(id);
    if (multiplexChild) {
      const child = multiplexChild;
      multiplexChild = null;
      try {
        child.stdin?.end();
        child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    }
    Effect.runSync(deskLocks().unlock(HUB_LOCK));
    log(`receiver hub exiting (pid ${process.pid})`);
    process.exit(exitCode);
  };

  log(`receiver hub started (pid ${process.pid})`);
  try {
    watcher = fs.watch(dir, () => reconcile());
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    // Periodic sweep still drives reconciliation.
  }
  const sweepTimer = setInterval(reconcile, SWEEP_MS);
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  reconcile();
};

const runSingleSession = (namespace: string, key: string, hostPidArg: string | undefined): void => {
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
};

if (process.argv[2] === '--hub') {
  runHub();
} else {
  const [namespace = '', key = '', hostPidArg] = process.argv.slice(2);
  runSingleSession(namespace, key, hostPidArg);
}
