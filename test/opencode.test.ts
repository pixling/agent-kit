// Drives the OpenCode plugin (V1 API) with a fake client and the fake CLI.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-opencode-test-'));
const log = path.join(dir, 'calls.jsonl');
const scen = path.join(dir, 'scenario.json');
fs.writeFileSync(log, '');
fs.writeFileSync(
  scen,
  JSON.stringify({
    'resident ensure': { exit: 0, result: { state: 'onDesk' } },
    'inbox receive': { exit: 5, error: { code: 'rejected' } },
    'question ask': { exit: 0, result: { promptID: 'p1', state: 'answered', selectedChoiceID: 'allow' } },
  }),
);
Object.assign(process.env, {
  PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
  FAKE_LOG: log,
  FAKE_SCENARIO: scen,
  XDG_CACHE_HOME: path.join(dir, 'cache'),
  XDG_CONFIG_HOME: path.join(dir, 'config'),
  PIXLING_PROXY_RECEIVE: '0',
  PIXLING_PROXY_LANGUAGE: 'en',
});

const { default: plugin } = await import('../src/adapters/opencode/index.ts');
const calls = () =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const replies: unknown[] = [];
const client = {
  session: {
    messages: async () => ({
      data: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'fix it' }] },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'Fixed ' },
            { type: 'text', text: 'the bug.' },
            { type: 'text', text: 'x', synthetic: true },
          ],
        },
      ],
    }),
    promptAsync: async () => {},
  },
  postSessionIdPermissionsPermissionId: async (req: unknown) => replies.push(req),
};
const hooks = await plugin.server({ client });

test('only root sessions get a resident', async () => {
  await hooks.event({
    event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_root' } } },
  });
  assert.equal(calls().filter((c) => c[1] === 'ensure').length, 0);
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_root' } } } });
  const ensure = calls().find((c) => c[1] === 'ensure');
  assert.equal(ensure[ensure.indexOf('--namespace') + 1], 'opencode');
  assert.equal(ensure[ensure.indexOf('--key') + 1], 'ses_root');
});

test('session.idle shows the last assistant text', async () => {
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_root' } } });
  const send = calls().find((c) => c[0] === 'message');
  assert.equal(send[send.indexOf('--text') + 1], 'Fixed the bug.');
});

test('a permission answered on the resident is replied to OpenCode', async () => {
  await hooks.event({
    event: {
      type: 'permission.updated',
      properties: { id: 'perm_1', sessionID: 'ses_root', type: 'bash', pattern: 'npm test' },
    },
  });
  // It does not hold up OpenCode's other events while it waits.
  for (let i = 0; i < 200 && !replies.length; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(replies.at(-1), { path: { id: 'ses_root', permissionID: 'perm_1' }, body: { response: 'once' } });
});

test('text parts in a row show once, as one text, and session.idle does not repeat them', async () => {
  const before = calls().length;
  const part = (id: string, text: string, end?: number) => ({
    event: {
      type: 'message.part.updated',
      properties: { part: { id, sessionID: 'ses_root', type: 'text', text, time: { start: 1, end } } },
    },
  });
  await hooks.event(part('prt_1', 'Fixed '));
  await hooks.event(part('prt_1', 'Fixed ', 2));
  await hooks.event(part('prt_1', 'Fixed ', 2));
  await hooks.event(part('prt_2', 'the bug.', 3));
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_root' } } });
  const sent = calls()
    .slice(before)
    .filter((c) => c[0] === 'message')
    .map((c) => c[c.indexOf('--text') + 1]);
  assert.deepEqual(sent, ['Fixed the bug.']);
});

test('a client call that fails never reaches OpenCode', async () => {
  const failing = await plugin.server({
    client: { ...client, session: { ...client.session, messages: () => Promise.reject(new Error('down')) } },
  });
  await failing.event({ event: { type: 'session.created', properties: { info: { id: 'ses_failing' } } } });
  await failing.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_failing' } } });
  // A payload without what it should carry.
  await failing.event({ event: { type: 'session.created', properties: {} } });
});
