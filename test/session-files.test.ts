// The session's memory on disk, on a real file system.
import { describe, expect, test } from 'vite-plus/test';
import { Effect } from 'effect';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/services.ts';
import { forgetOldSessions, SessionLocks, sessionFiles } from '../src/runtimes/SessionFiles.ts';
import { startedAt } from '../src/runtimes/process.ts';

const inFreshCache = () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-store-test-'));
  process.env.XDG_CACHE_HOME = cache;
  return { cache, dir: path.join(cache, 'pixling-proxy', 'test', 'k') };
};

const store = <A>(run: (store: typeof SessionStore.Service) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(
    SessionStore.use(run).pipe(Effect.provide(sessionFiles({ namespace: 'test', key: 'k', author: 'T' }))),
  );

const locks = <A>(run: (locks: typeof SessionLocks.Service) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(
    SessionLocks.use(run).pipe(Effect.provide(sessionFiles({ namespace: 'test', key: 'k', author: 'T' }))),
  );

const sleeper = () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  return { pid: child.pid!, stop: () => child.kill('SIGKILL'), child };
};

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('locks', () => {
  test('stopping a lock left with a reused pid leaves that process alone', async () => {
    const { dir } = inFreshCache();
    fs.mkdirSync(dir, { recursive: true });
    const other = sleeper();
    try {
      fs.writeFileSync(path.join(dir, 'receiver.lock'), `${other.pid} Thu Jan  1 00:00:00 1970`);
      expect(await locks((s) => s.stopHolder('receiver'))).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(other.child.exitCode ?? other.child.signalCode).toBeNull();
      expect(running(other.pid)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'receiver.lock'))).toBe(false);
    } finally {
      other.stop();
    }
  });

  test('a lock from before start times were recorded never gets its pid signalled', async () => {
    const { dir } = inFreshCache();
    fs.mkdirSync(dir, { recursive: true });
    const other = sleeper();
    try {
      fs.writeFileSync(path.join(dir, 'receiver.lock'), String(other.pid));
      expect(await locks((s) => s.stopHolder('receiver'))).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(other.child.signalCode).toBeNull();
    } finally {
      other.stop();
    }
  });

  test('the process a lock was handed to does get stopped', async () => {
    inFreshCache();
    const own = sleeper();
    try {
      await locks((s) => s.lock('receiver'));
      await locks((s) => s.handOver('receiver', own.pid));
      expect(await locks((s) => s.stopHolder('receiver'))).toBe(own.pid);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(own.child.signalCode).toBe('SIGTERM');
    } finally {
      own.stop();
    }
  });

  test('a lock whose pid now belongs to another process can be taken over', async () => {
    const { dir } = inFreshCache();
    fs.mkdirSync(dir, { recursive: true });
    const other = sleeper();
    try {
      fs.writeFileSync(path.join(dir, 'receiver.lock'), `${other.pid} Thu Jan  1 00:00:00 1970`);
      expect(await locks((s) => s.lock('receiver'))).toBe(true);
    } finally {
      other.stop();
    }
  });

  test('a lock held by a live process is respected', async () => {
    const { dir } = inFreshCache();
    fs.mkdirSync(dir, { recursive: true });
    const other = sleeper();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.writeFileSync(path.join(dir, 'receiver.lock'), `${other.pid} ${startedAt(other.pid)}`);
      expect(await locks((s) => s.lock('receiver'))).toBe(false);
    } finally {
      other.stop();
    }
  });
});

describe('claims', () => {
  test('one claim per entry', async () => {
    inFreshCache();
    expect(await store((s) => s.claim('m'))).toBe(true);
    expect(await store((s) => s.claim('m'))).toBe(false);
  });

  test('a claim whose process died before reading expires, so the entry is not lost', async () => {
    const { dir } = inFreshCache();
    expect(await store((s) => s.claim('m'))).toBe(true);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(dir, 'claimed', 'm'), old, old);
    expect(await store((s) => s.claim('m'))).toBe(true);
    expect(await store((s) => s.claim('m'))).toBe(false);
  });
});

describe('a cache directory that cannot be written', () => {
  test('costs the memory, never the conversation', async () => {
    const { cache } = inFreshCache();
    // A file where the session directory's parent should be: every write fails.
    fs.writeFileSync(path.join(cache, 'pixling-proxy'), '');
    await store((s) => s.markBound);
    await store((s) => s.setSince(3));
    expect(await store((s) => s.since)).toBe(0);
    expect(await store((s) => s.isStowed)).toBe(false);
    expect(await locks((s) => s.lock('receiver'))).toBe(false);
    expect(await store((s) => s.claim('m'))).toBe(false);
  });
});

describe('what a session remembers', () => {
  test('two values written at the same moment both stay', async () => {
    inFreshCache();
    await Promise.all([store((s) => s.markBound), store((s) => s.setSince(7)), store((s) => s.markStowed)]);
    expect(await store((s) => s.isBound)).toBe(true);
    expect(await store((s) => s.since)).toBe(7);
    expect(await store((s) => s.isStowed)).toBe(true);
  });

  test('reads what an earlier version left in state.json', async () => {
    const { dir } = inFreshCache();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ bound: true, stowed: true, since: 9 }));
    expect(await store((s) => s.isStowed)).toBe(true);
    expect(await store((s) => s.since)).toBe(9);
    await store((s) => s.setSince(10));
    expect(await store((s) => s.since)).toBe(10);
  });

  test('is readable by this user only', async () => {
    const { dir } = inFreshCache();
    await store((s) => s.setSince(1));
    expect(fs.statSync(path.join(dir, 'since.json')).mode & 0o077).toBe(0);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });
});

describe('sessions long gone', () => {
  test('are forgotten, once a day, and the others are not', async () => {
    const { cache } = inFreshCache();
    const base = path.join(cache, 'pixling-proxy');
    const old = path.join(base, 'codex', 'old');
    const recent = path.join(base, 'codex', 'recent');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(recent, { recursive: true });
    const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    await Effect.runPromise(forgetOldSessions);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.statSync(base).mode & 0o077).toBe(0);

    fs.mkdirSync(old);
    fs.utimesSync(old, longAgo, longAgo);
    await Effect.runPromise(forgetOldSessions);
    expect(fs.existsSync(old)).toBe(true);
  });
});

test('a memo is kept per name, read back by another process, and absent until written', async () => {
  inFreshCache();
  expect(await store((s) => s.memo('emote-shown'))).toBeUndefined();
  await store((s) => s.setMemo('emote-shown', { kind: 'read', at: 5 }));
  await store((s) => s.setMemo('emote/odd name', 1));
  expect(await store((s) => s.memo('emote-shown'))).toEqual({ kind: 'read', at: 5 });
  expect(await store((s) => s.memo('emote/odd name'))).toBe(1);
  expect(await store((s) => s.memo('other'))).toBeUndefined();
});
