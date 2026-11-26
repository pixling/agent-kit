import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vite-plus/test';
import { entryId, FORWARDER_HUB_DIR } from '../src/runtimes/ReceiverHub.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubScript = path.join(root, 'plugins/pixling-proxy/scripts/codex-forwarder.mjs');
const fakeCli = path.join(root, 'test/fake-pixling.mjs');

const waitFor = async (predicate: () => boolean, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`timed out waiting after ${timeoutMs}ms`);
};

const readLog = (file: string): string[][] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];

const exited = (child: ReturnType<typeof spawn>, timeoutMs = 8_000) =>
  new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

const makeCodexStub = (dir: string): { bin: string; log: string } => {
  const bin = path.join(dir, 'codex');
  const log = path.join(dir, 'queued.log');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  return { bin, log };
};

test('codex forwarder hub multiplexes two Codex threads through one inbox wait --multiplex child and exits cleanly when empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-hub-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codex = makeCodexStub(dir);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox wait k1': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
        { hold: true },
      ],
      'inbox wait k2': [
        { exit: 0, result: { messages: [{ messageID: 'm2', sequence: 3, kind: 'message' }] } },
        { hold: true },
      ],
      'inbox watch k1': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
      'inbox watch k2': { exit: 0, result: { messages: [{ messageID: 'm2', sequence: 3, kind: 'message' }] } },
      'inbox read': { exit: 0, result: { kind: 'message', sequence: 2, text: 'hello from desk' } },
    }),
  );

  const file1 = path.join(entriesDir, `${entryId('codex', 'k1')}.json`);
  const file2 = path.join(entriesDir, `${entryId('codex', 'k2')}.json`);
  fs.writeFileSync(
    file1,
    JSON.stringify({
      namespace: 'codex',
      key: 'k1',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-1'],
    }),
  );
  fs.writeFileSync(
    file2,
    JSON.stringify({
      namespace: 'codex',
      key: 'k2',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-2'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codex.bin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    await waitFor(() => {
      if (!fs.existsSync(codex.log)) return false;
      const text = fs.readFileSync(codex.log, 'utf8');
      return text.includes('--thread thread-1') && text.includes('--thread thread-2');
    });

    const muxSpawns = readLog(calls).filter((a) => a[0] === 'inbox' && a[1] === 'wait-multiplex');
    assert.equal(muxSpawns.length, 1, 'must spawn a single multiplexed inbox wait CLI for both threads');

    fs.rmSync(file1);
    fs.rmSync(file2);
    const code = await exited(hub);
    assert.equal(code, 0);
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('codex forwarder hub retires entries that exceed idleCloseMs even while hostPid is alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-idle-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codex = makeCodexStub(dir);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(scenario, JSON.stringify({ 'inbox wait': { hold: true } }));

  const staleFile = path.join(entriesDir, `${entryId('codex', 'stale')}.json`);
  fs.writeFileSync(
    staleFile,
    JSON.stringify({
      namespace: 'codex',
      key: 'stale',
      hostPid: process.pid,
      idleCloseMs: 1_000,
      registeredAt: Date.now() - 5_000,
      extra: ['thread-stale'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codex.bin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    const code = await exited(hub);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(staleFile), false, 'expired idle entry must be removed from disk');
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('codex forwarder hub immediately removes an already-stowed entry and exits cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-stowed-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  const sessionDir = path.join(cache, 'pixling-proxy', 'codex', 'stowed-k');
  fs.mkdirSync(entriesDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'stowed.json'), 'true');
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codex = makeCodexStub(dir);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(scenario, JSON.stringify({ 'inbox wait': { hold: true } }));

  const entryFile = path.join(entriesDir, `${entryId('codex', 'stowed-k')}.json`);
  fs.writeFileSync(
    entryFile,
    JSON.stringify({
      namespace: 'codex',
      key: 'stowed-k',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-stowed'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codex.bin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    const code = await exited(hub);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(entryFile), false, 'already-stowed entry must be removed from disk');
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('codex forwarder hub restarts wait --multiplex after a non-64 crash and delivers messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-restart-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codex = makeCodexStub(dir);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox wait --multiplex': [{ exit: 1 }, { exit: 0 }],
      'inbox wait k-crash': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
        { hold: true },
      ],
      'inbox watch k-crash': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
      'inbox read': { exit: 0, result: { kind: 'message', sequence: 2, text: 'after restart' } },
    }),
  );

  const entryFile = path.join(entriesDir, `${entryId('codex', 'k-crash')}.json`);
  fs.writeFileSync(
    entryFile,
    JSON.stringify({
      namespace: 'codex',
      key: 'k-crash',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-crash'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codex.bin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    await waitFor(
      () => fs.existsSync(codex.log) && fs.readFileSync(codex.log, 'utf8').includes('--thread thread-crash'),
    );
    const muxSpawns = readLog(calls).filter((a) => a[0] === 'inbox' && a[1] === 'wait-multiplex');
    assert.ok(muxSpawns.length >= 2, 'must restart wait --multiplex after a non-64 crash');
    fs.rmSync(entryFile);
    assert.equal(await exited(hub), 0);
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('codex forwarder hub falls back to per-session inbox wait when CLI rejects --multiplex with exit 64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-fallback-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codex = makeCodexStub(dir);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox wait --multiplex': { exit: 64 },
      'inbox wait': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
        { exit: 0, result: { messages: [] } },
      ],
      'inbox watch': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
        { exit: 0, result: { messages: [] } },
      ],
      'inbox read': { exit: 0, result: { kind: 'message', sequence: 2, text: 'fallback message' } },
    }),
  );

  const file = path.join(entriesDir, `${entryId('codex', 'fb')}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      namespace: 'codex',
      key: 'fb',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-fb'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codex.bin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    await waitFor(() => fs.existsSync(codex.log) && fs.readFileSync(codex.log, 'utf8').includes('--thread thread-fb'));
    const logged = readLog(calls);
    const muxAttempts = logged.filter((a) => a[0] === 'inbox' && a[1] === 'wait-multiplex');
    const waitCalls = logged.filter((a) => a[0] === 'inbox' && a[1] === 'wait');
    assert.equal(muxAttempts.length, 1, 'should try wait --multiplex once before falling back');
    assert.ok(waitCalls.length >= 1, 'should fall back to single-key inbox wait after exit 64');
    fs.rmSync(file);
    assert.equal(await exited(hub), 0);
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('codex forwarder hub retires a thread permanently when codex queue reports no rollout found', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-gone-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codexBin = path.join(dir, 'codex');
  fs.writeFileSync(
    codexBin,
    `#!/bin/sh\necho "Error: failed to queue session message: no rollout found for thread id thread-gone" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox wait k-gone': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
        { hold: true },
      ],
      'inbox watch k-gone': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 2, kind: 'message' }] } },
      'inbox read': { exit: 0, result: { kind: 'message', sequence: 2, text: 'hello?' } },
    }),
  );

  const file = path.join(entriesDir, `${entryId('codex', 'k-gone')}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      namespace: 'codex',
      key: 'k-gone',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-gone'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codexBin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    const code = await exited(hub);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(file), false, 'deleted-thread entry must be removed from disk');
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('codex forwarder hub retires a thread when wait --multiplex ends with notBound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-fwd-notbound-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', FORWARDER_HUB_DIR, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  const codex = makeCodexStub(dir);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox wait k-nb': { exit: 5, error: { code: 'notBound', detail: 'notBound' } },
    }),
  );

  const file = path.join(entriesDir, `${entryId('codex', 'k-nb')}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      namespace: 'codex',
      key: 'k-nb',
      hostPid: process.pid,
      idleCloseMs: 60_000,
      registeredAt: Date.now(),
      extra: ['thread-nb'],
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_BIN: codex.bin,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    const code = await exited(hub);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(file), false, 'notBound entry must be removed from disk');
  } finally {
    try {
      hub.kill('SIGKILL');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
