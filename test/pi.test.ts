// Drives the pi extension with a fake ExtensionAPI and the fake CLI.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-pi-test-'));
const log = path.join(dir, 'calls.jsonl');
const scen = path.join(dir, 'scenario.json');
fs.writeFileSync(log, '');
fs.writeFileSync(scen, JSON.stringify({ 'resident ensure': { exit: 0, result: { state: 'onDesk' } } }));
Object.assign(process.env, {
  PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
  FAKE_LOG: log,
  FAKE_SCENARIO: scen,
  XDG_CACHE_HOME: path.join(dir, 'cache'),
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  PIXLING_PROXY_RECEIVE: '0',
  PIXLING_PROXY_LANGUAGE: 'en',
});

const { default: extension } = await import('../src/adapters/pi/index.ts');
const calls = () =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// pi waits for its handlers, so they return before Pixling has answered.
const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(done(), 'in time');
};

type Handler = (ev: any, ctx: any) => unknown;

function load() {
  const handlers = new Map<string, Handler>();
  extension({ on: (name: string, fn: Handler) => handlers.set(name, fn), sendUserMessage: () => {} } as any);
  const ctx = (mode: string, id: string) => ({ mode, isIdle: () => true, sessionManager: { getSessionId: () => id } });
  return { emit: (name: string, ev: object, c: object) => handlers.get(name)!(ev, c), ctx };
}

test('a print run gets no resident', async () => {
  const { emit, ctx } = load();
  await emit('session_start', { reason: 'startup' }, ctx('print', 'pi-print'));
  assert.equal(calls().filter((c) => c[1] === 'ensure').length, 0);
});

test('an interactive session binds a resident and shows the settled reply', async () => {
  const { emit, ctx } = load();
  const c = ctx('tui', 'pi-tui');
  assert.equal(await emit('session_start', { reason: 'startup' }, c), undefined);
  await until(() => calls().some((x) => x[1] === 'ensure'));
  const ensure = calls().find((x) => x[1] === 'ensure');
  assert.equal(ensure[ensure.indexOf('--namespace') + 1], 'pi');
  assert.equal(ensure[ensure.indexOf('--key') + 1], 'pi-tui');
  await emit(
    'agent_end',
    {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      ],
    },
    c,
  );
  await emit('agent_settled', { aborted: false }, c);
  await until(() => calls().some((x) => x[0] === 'message'));
  const send = calls().find((x) => x[0] === 'message');
  assert.equal(send[send.indexOf('--text') + 1], 'Done.');
  await emit('session_shutdown', { reason: 'quit' }, c);
});

test('each assistant message shows as it ends, and the reply is not repeated', async () => {
  const { emit, ctx } = load();
  const c = ctx('tui', 'pi-messages');
  await emit('session_start', { reason: 'startup' }, c);
  const before = calls().length;
  const text = (t: string) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
  await emit('message_end', { message: { role: 'user', content: 'go' } }, c);
  await emit('message_end', { message: text('Reading the config first.') }, c);
  await emit('message_end', { message: text('All set.') }, c);
  await emit('agent_end', { messages: [text('Reading the config first.'), text('All set.')] }, c);
  await emit('agent_settled', { aborted: false }, c);
  const sentNow = () =>
    calls()
      .slice(before)
      .filter((x) => x[0] === 'message')
      .map((x) => x[x.indexOf('--text') + 1]);
  await until(() => sentNow().length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sent = sentNow();
  assert.deepEqual(sent, ['Reading the config first.', 'All set.']);
  await emit('session_shutdown', { reason: 'quit' }, c);
});
