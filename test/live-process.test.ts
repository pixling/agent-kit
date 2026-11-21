// A plugin in a real host process: its console is the host's screen, the host must
// be able to exit once its sessions close, and a closing session still shows its
// last reply (`npm test` builds first).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a live session stays off the host console, shows its last reply, and lets the host exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-live-test-'));
  const scenario = path.join(dir, 'scenario.json');
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'resident ensure': { exit: 0, result: { state: 'onDesk' } },
      'inbox receive': { exit: 3, error: { code: 'unavailable' } },
      'inbox wait': { exit: 0, result: { messages: [] } },
    }),
  );
  const host = `
    const { default: extension } = await import(${JSON.stringify(path.join(root, 'packages/pi/dist/index.mjs'))});
    const handlers = {};
    extension({ on: (name, fn) => (handlers[name] = fn), sendUserMessage() {} });
    const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getSessionId: () => 'console' } };
    await handlers.session_start({ reason: 'startup' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // A short run ends right after its last reply: that reply must still arrive.
    void handlers.message_end({ message: { role: 'assistant', content: 'Thinking aloud.' } }, ctx);
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', host], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });
  assert.equal(res.status, 0, `exited by itself (signal ${res.signal})`);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
  assert.ok(fs.readFileSync(calls, 'utf8').includes('Thinking aloud.'));
}, 30_000);

// A session's replies and receiver are its own, however many sessions the host runs.
test('two sessions of one host each talk through their own resident', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-live-test-'));
  const scenario = path.join(dir, 'scenario.json');
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'resident ensure': { exit: 0, result: { state: 'onDesk' } },
      'inbox receive': { exit: 3, error: { code: 'unavailable' } },
      'inbox wait': { exit: 0, result: { messages: [] } },
    }),
  );
  const host = `
    const { default: plugin } = await import(${JSON.stringify(path.join(root, 'packages/opencode/dist/index.mjs'))});
    const hooks = await plugin.server({
      client: {
        session: {
          messages: async () => ({ data: [] }),
          promptAsync: async () => {},
        },
      },
    });
    const created = (id) => hooks.event({ event: { type: 'session.created', properties: { info: { id } } } });
    const said = (sessionID, id, text) =>
      hooks.event({
        event: {
          type: 'message.part.updated',
          properties: { part: { id, sessionID, type: 'text', text, time: { start: 1, end: 2 } } },
        },
      });
    await created('ses_a');
    await created('ses_b');
    await said('ses_a', 'p1', 'reply of A');
    await said('ses_b', 'p2', 'reply of B');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', host], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
      FAKE_LOG: calls,
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  });
  assert.equal(res.status, 0, res.stderr);
  const logged = fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  const value = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const sent = logged.filter((c) => c[0] === 'message').map((c) => [value(c, '--to'), value(c, '--text')]);
  assert.deepEqual(sent.sort(), [
    ['client:opencode/ses_a', 'reply of A'],
    ['client:opencode/ses_b', 'reply of B'],
  ]);
  const received = new Set(logged.filter((c) => c[1] === 'receive').map((c) => value(c, '--key')));
  assert.deepEqual([...received].sort(), ['ses_a', 'ses_b']);
}, 30_000);

// What a daemon leaves behind: nothing another session could mistake for it.
const receiverFixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-live-test-'));
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ 'inbox receive': { exit: 0, result: {} } }));
  const sessionDir = path.join(dir, 'cache/pixling-proxy/test/k');
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    dir,
    lock: path.join(sessionDir, 'receiver.lock'),
    script: path.join(root, 'plugins/pixling-proxy/scripts/receiver-daemon.mjs'),
    env: {
      ...process.env,
      PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
      FAKE_LOG: path.join(dir, 'calls.jsonl'),
      FAKE_SCENARIO: scenario,
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      XDG_CONFIG_HOME: path.join(dir, 'config'),
    },
  };
};

const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

test('a receiver frees its lock when the user puts the resident away', async () => {
  const { lock, script, env } = receiverFixture();
  // Stopped before it runs, so that the lock can be written with its pid first.
  const child = spawn(
    process.execPath,
    ['--import', 'data:text/javascript,await new Promise((r)=>setTimeout(r,300))', script, 'test', 'k', '0'],
    {
      stdio: 'ignore',
      env,
    },
  );
  fs.writeFileSync(lock, `${child.pid} x`);
  await exited(child);
  assert.equal(fs.existsSync(lock), false);
}, 30_000);

test('a receiver frees its lock when it is stopped', async () => {
  const { dir, lock, script, env } = receiverFixture();
  const hanging = path.join(dir, 'pixling');
  fs.writeFileSync(hanging, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const child = spawn(process.execPath, [script, 'test', 'k', '0'], {
    stdio: 'ignore',
    env: { ...env, PIXLING_CLI: hanging },
  });
  fs.writeFileSync(lock, `${child.pid} x`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  child.kill('SIGTERM');
  await exited(child);
  assert.equal(fs.existsSync(lock), false);
}, 30_000);

// The user's message survives a host that refuses it for a while.
test('the Codex forwarder queues a message again until codex takes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-forwarder-test-'));
  const scenario = path.join(dir, 'scenario.json');
  const calls = path.join(dir, 'calls.jsonl');
  const queued = path.join(dir, 'queued.log');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      'inbox wait': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
        { exit: 0, result: { messages: [] } },
      ],
      'inbox watch': [
        { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
        { exit: 0, result: { messages: [] } },
      ],
      'inbox read': { exit: 0, result: { kind: 'message', sequence: 1, text: '- first point' } },
    }),
  );
  const codex = path.join(dir, 'codex');
  const tries = path.join(dir, 'tries');
  const triesSoFar = () => (fs.existsSync(tries) ? fs.readFileSync(tries, 'utf8').length : 0);
  // Refuses the first attempt, takes the second.
  fs.writeFileSync(
    codex,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(queued)}\nprintf x >> ${JSON.stringify(tries)}\n[ "$(wc -c < ${JSON.stringify(tries)})" -ge 2 ]\n`,
    { mode: 0o755 },
  );
  const child = spawn(
    process.execPath,
    [path.join(root, 'plugins/pixling-proxy/scripts/codex-forwarder.mjs'), 'codex', 'k', '0', 'thread-1'],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        CODEX_BIN: codex,
        PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
        FAKE_LOG: calls,
        FAKE_SCENARIO: scenario,
        XDG_CACHE_HOME: path.join(dir, 'cache'),
        XDG_CONFIG_HOME: path.join(dir, 'config'),
      },
    },
  );
  try {
    for (let i = 0; i < 100 && triesSoFar() < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Long enough for a third attempt, if a taken message were queued again.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(triesSoFar(), 2);
    const attempts = fs.readFileSync(queued, 'utf8').trim();
    assert.match(attempts, /--thread thread-1/);
    assert.ok(attempts.includes('- first point'));
    const told = fs
      .readFileSync(calls, 'utf8')
      .split('\n')
      .filter((line) => line.includes('has not reached the agent'));
    assert.equal(told.length, 1);
  } finally {
    child.kill('SIGTERM');
  }
}, 30_000);
