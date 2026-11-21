// Drives the dsh plugin with a fake Cordis context and the fake CLI.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-dsh-test-'));
const log = path.join(dir, 'calls.jsonl');
const scen = path.join(dir, 'scenario.json');
fs.writeFileSync(log, '');
const scenario = (questionResult: object) =>
  fs.writeFileSync(
    scen,
    JSON.stringify({
      'resident ensure': { exit: 0, result: { state: 'onDesk' } },
      'question ask': { exit: 0, result: { promptID: 'p1', state: 'pending' } },
      'question result': { exit: 0, result: { question: questionResult } },
    }),
  );
scenario({ promptID: 'p1', state: 'answered', selectedChoiceID: 'allow' });
Object.assign(process.env, {
  PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
  FAKE_LOG: log,
  FAKE_SCENARIO: scen,
  XDG_CACHE_HOME: path.join(dir, 'cache'),
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  PIXLING_PROXY_RECEIVE: '0',
  PIXLING_PROXY_LANGUAGE: 'en',
  PIXLING_PROXY_UNATTENDED: '1',
});

const plugin = await import('../src/adapters/dsh/index.ts');
const calls = () =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const sent = () =>
  calls()
    .filter((c) => c[0] === 'message')
    .map((c) => c[c.indexOf('--text') + 1]);

const handlers = new Map<string, (...args: any[]) => any>();
plugin.apply({
  plugin: () => {},
  on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
  effect: () => {},
} as any);
const session = { id: 'dsh-1', header: {} };
const emit = (type: string, data?: object, s: object = session) => handlers.get('session/event')!(s, { type, data });
// Until the plugin has gone quiet: under load, a call to the CLI can take a while.
// The relay polls the inbox on its own, so that does not count.
const settled = async () => {
  const count = () => calls().filter((c) => c[0] !== 'inbox').length;
  let seen = -1;
  for (let i = 0; i < 10 && seen !== count(); i++) {
    seen = count();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};
const textMessage = (text: string) => ({ message: { content: [{ type: 'text', text }] } });

test('a subagent gets no resident, a root session does', async () => {
  emit('turn/start', {}, { id: 'dsh-child', header: { parentSession: {} } });
  await settled();
  assert.equal(calls().filter((c) => c[1] === 'ensure').length, 0);
  emit('turn/start');
  await settled();
  assert.equal(calls().filter((c) => c[1] === 'ensure').length, 1);
});

test('each message shows as it ends, and the reply is not repeated', async () => {
  emit('assistant/message', textMessage('Reading it.'));
  emit('assistant/message', textMessage('All done.'));
  await settled();
  emit('turn/end', { reason: { kind: 'completed' } });
  await settled();
  assert.deepEqual(sent(), ['Reading it.', 'All done.']);
});

test('approval: the resident answers first and the UI card is released', async () => {
  let signal: AbortSignal | undefined;
  const req: any = { agent: { session }, toolName: 'Bash', reason: 'ls' };
  const outcome = await handlers.get('approval/request')!(req, () => {
    signal = req.signal;
    return new Promise((resolve) => signal!.addEventListener('abort', () => resolve('cancelled')));
  });
  assert.equal(outcome, 'allowed-once');
  assert.equal(signal?.aborted, true);
});

test('approval: the UI answers first and the question is withdrawn', async () => {
  scenario({ promptID: 'p1', state: 'pending' });
  const req: any = { agent: { session }, toolName: 'Bash', reason: 'ls' };
  const outcome = await handlers.get('approval/request')!(req, async () => {
    await settled();
    return 'rejected';
  });
  assert.equal(outcome, 'rejected');
  await settled();
  assert.ok(calls().some((c) => c[0] === 'question' && c[1] === 'cancel'));
});

test('a session nobody listens to leaves approval to the UI', async () => {
  const req: any = { agent: { session: { id: 'other', header: {} } }, toolName: 'Bash' };
  assert.equal(await handlers.get('approval/request')!(req, async () => 'allowed-once'), 'allowed-once');
});
