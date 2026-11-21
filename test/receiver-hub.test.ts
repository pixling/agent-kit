// The shared receiver hub holds any number of sessions with one Node process and one
// multiplexed `pixling inbox receive --multiplex` child, expires idle or dead-host
// sessions, and exits cleanly when empty.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryExpiredReason, entryId } from '../src/runtimes/ReceiverHub.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubScript = path.join(root, 'plugins/pixling-proxy/scripts/receiver-daemon.mjs');

const waitFor = async (predicate: () => boolean, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
};

test('entryExpiredReason expires dead host pids and idle sessions even with a live host pid', () => {
  const now = 10_000_000;
  assert.equal(
    entryExpiredReason(
      { namespace: 'antigravity', key: 's1', hostPid: 42, idleCloseMs: 6 * 3600_000, registeredAt: now - 1000 },
      now,
      () => false,
      () => now - 1000,
    ),
    'hostExited',
  );
  assert.equal(
    entryExpiredReason(
      { namespace: 'antigravity', key: 's2', hostPid: 42, idleCloseMs: 3600_000, registeredAt: now - 4000_000 },
      now,
      () => true,
      () => now - 4000_000,
    ),
    'idle',
  );
  assert.equal(
    entryExpiredReason(
      { namespace: 'antigravity', key: 's3', hostPid: 42, idleCloseMs: 3600_000, registeredAt: now - 4000_000 },
      now,
      () => true,
      () => now - 100_000,
    ),
    null,
  );
  assert.equal(
    entryExpiredReason(
      { namespace: 'antigravity', key: 's4', hostPid: 42, idleCloseMs: 0, registeredAt: now - 10_000_000 },
      now,
      () => true,
      () => 0,
    ),
    null,
  );
});

test('the shared hub multiplexes multiple sessions over one pixling child and exits when empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-hub-test-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ 'inbox receive': { hold: true } }));

  const entryPath = (ns: string, key: string) => path.join(entriesDir, `${entryId(ns, key)}.json`);
  const writeEntry = (key: string) =>
    fs.writeFileSync(
      entryPath('antigravity', key),
      JSON.stringify({
        namespace: 'antigravity',
        key,
        hostPid: process.pid,
        idleCloseMs: 3600_000,
        registeredAt: Date.now(),
      }),
    );

  writeEntry('ses_a');
  writeEntry('ses_b');

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  const readCalls = () =>
    fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

  try {
    await waitFor(() => {
      const logged = readCalls();
      const keys = logged.filter((c) => c[1] === 'receive' && !c.includes('--remove')).map((c) => c[5]);
      return keys.includes('ses_a') && keys.includes('ses_b');
    });
    // Only one multiplexed `pixling inbox receive --multiplex` process was spawned.
    const muxSpawns = readCalls().filter((c) => c[1] === 'receive-multiplex');
    assert.equal(muxSpawns.length, 1);

    // Removing ses_a sends a remove command without stopping ses_b.
    fs.rmSync(entryPath('antigravity', 'ses_a'));
    await waitFor(() => readCalls().some((c) => c.includes('--remove') && c.includes('ses_a')));

    // Removing the last entry lets the hub exit cleanly on its own.
    fs.rmSync(entryPath('antigravity', 'ses_b'));
    const code = await new Promise<number | null>((resolve) => hub.once('exit', (c) => resolve(c)));
    assert.equal(code, 0);
  } finally {
    if (hub.exitCode === null) hub.kill('SIGTERM');
  }
}, 20_000);

test('the shared hub falls back to per-key inbox receive if CLI rejects --multiplex with exit 64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-hub-fallback-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox receive --multiplex': { exit: 64 },
      'inbox receive': { exit: 0, result: {} },
    }),
  );

  fs.writeFileSync(
    path.join(entriesDir, `${entryId('claude-code', 'legacy-1')}.json`),
    JSON.stringify({
      namespace: 'claude-code',
      key: 'legacy-1',
      hostPid: process.pid,
      idleCloseMs: 3600_000,
      registeredAt: Date.now(),
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    const code = await new Promise<number | null>((resolve) => hub.once('exit', (c) => resolve(c)));
    assert.equal(code, 0);
    const logged = fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(logged.some((c) => c[0] === 'inbox' && c[1] === 'receive-multiplex'));
    assert.ok(logged.some((c) => c[0] === 'inbox' && c[1] === 'receive' && c.includes('legacy-1')));
  } finally {
    if (hub.exitCode === null) hub.kill('SIGTERM');
  }
}, 20_000);

test('the shared hub expires dead-host entries on reconcile and cleans up entry files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-hub-expire-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ 'inbox receive': { hold: true } }));

  const deadFile = path.join(entriesDir, `${entryId('antigravity', 'dead-1')}.json`);
  fs.writeFileSync(
    deadFile,
    JSON.stringify({
      namespace: 'antigravity',
      key: 'dead-1',
      hostPid: 999_999,
      idleCloseMs: 3600_000,
      registeredAt: Date.now(),
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    const code = await new Promise<number | null>((resolve) => hub.once('exit', (c) => resolve(c)));
    assert.equal(code, 0);
    assert.equal(fs.existsSync(deadFile), false);
    assert.equal(fs.readFileSync(calls, 'utf8').trim(), '');
  } finally {
    if (hub.exitCode === null) hub.kill('SIGTERM');
  }
}, 20_000);

test('the shared hub restarts a crashed multiplex child and re-adds active sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-hub-restart-'));
  const cache = path.join(dir, 'cache');
  const entriesDir = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  const runsFile = path.join(dir, 'runs');
  const fakeCli = path.join(dir, 'pixling');
  // First multiplex spawn crashes with exit 1; second holds normally.
  fs.writeFileSync(
    fakeCli,
    `#!/bin/sh
n=$(wc -c < ${JSON.stringify(runsFile)} 2>/dev/null || echo 0)
printf x >> ${JSON.stringify(runsFile)}
if [ "$n" -eq 0 ]; then exit 1; fi
exec ${JSON.stringify(path.join(root, 'test/fake-pixling.mjs'))} "$@"
`,
    { mode: 0o755 },
  );
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ 'inbox receive': { hold: true } }));

  const entryFile = path.join(entriesDir, `${entryId('antigravity', 'survive-1')}.json`);
  fs.writeFileSync(
    entryFile,
    JSON.stringify({
      namespace: 'antigravity',
      key: 'survive-1',
      hostPid: process.pid,
      idleCloseMs: 3600_000,
      registeredAt: Date.now(),
    }),
  );

  const hub = spawn(process.execPath, [hubScript, '--hub'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PIXLING_CLI: fakeCli,
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });

  try {
    await waitFor(() => fs.readFileSync(calls, 'utf8').includes('survive-1'), 10_000);
    fs.rmSync(entryFile);
    const code = await new Promise<number | null>((resolve) => hub.once('exit', (c) => resolve(c)));
    assert.equal(code, 0);
  } finally {
    if (hub.exitCode === null) hub.kill('SIGTERM');
  }
}, 20_000);
