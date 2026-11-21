// The packages, which live in the host process, with emote settings: the built pi one, with a fake
// ExtensionAPI, the fake CLI and a judge served from this process (`npm test` builds first).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glowStylesFor, lit, NO_TRAITS, reactionFor } from '../src/extensions/emote/reactions.ts';
import { isDeepStrictEqual } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-emote-live-test-'));
const log = path.join(dir, 'calls.jsonl');
const scen = path.join(dir, 'scenario.json');
fs.writeFileSync(log, '');
fs.writeFileSync(scen, JSON.stringify({ 'resident ensure': { exit: 0, result: { state: 'onDesk' } } }));

const said: string[] = [];
const judge = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    said.push(JSON.parse(body).state.said);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers: { react: { probability: 0.9 }, mood: { choice: 'asking' } } }));
  });
});
await new Promise<void>((resolve) => judge.listen(0, '127.0.0.1', resolve));
judge.unref();
fs.mkdirSync(path.join(dir, 'config/pixling'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'config/pixling/proxy.json'),
  JSON.stringify({
    emote: { endpoint: `http://127.0.0.1:${(judge.address() as AddressInfo).port}/v4/ai`, apiKey: 'k' },
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

const { default: extension } = await import(path.join(root, 'packages/pi/dist/index.mjs'));
const calls = () =>
  fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);

const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(done(), 'in time');
};

type Handler = (ev: any, ctx: any) => unknown;

test('@pixling/pi-proxy with emote settings: the reply arrives still, and the resident reacts to it', async () => {
  const handlers = new Map<string, Handler>();
  extension({ on: (name: string, fn: Handler) => handlers.set(name, fn), sendUserMessage: () => {} });
  const emit = (name: string, ev: object) => handlers.get(name)!(ev, c);
  const c = { mode: 'tui', isIdle: () => true, sessionManager: { getSessionId: () => 'pi-reacts' } };
  await emit('session_start', { reason: 'startup' });
  await until(() => calls().some((x) => x[1] === 'ensure'));
  await emit('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Which one?' }] }] });
  await emit('agent_settled', { aborted: false });
  await until(() => calls().some((x) => x[0] === 'sequence' && x[1] === 'start'));
  const send = calls().find((x) => x[0] === 'message')!;
  assert.equal(send[send.indexOf('--text') + 1], 'Which one?');
  assert.equal(send[send.indexOf('--action') + 1], 'none');
  const run = calls().find((x) => x[0] === 'sequence' && x[1] === 'start')!;
  assert.equal(run[run.indexOf('--to') + 1], 'client:pi/pi-reacts');
  const steps = JSON.parse(run[run.indexOf('--steps') + 1]);
  // The asking reaction, lit in one of its styles picked at random.
  assert.ok(
    glowStylesFor('asking').some((style) => isDeepStrictEqual(steps, lit(reactionFor('asking', NO_TRAITS, 0)!, style))),
  );
  assert.deepEqual(said, ['Which one?']);
  await emit('session_shutdown', { reason: 'quit' });
});

// OpenCode and dsh carry the extension too: with emote settings, the resident each
// creates starts with its motion on, which only the extension asks for.
const createdWithMotion = (namespace: string) =>
  calls().some(
    (c) =>
      c[1] === 'ensure' &&
      c[c.indexOf('--namespace') + 1] === namespace &&
      c.includes('--initial') &&
      JSON.parse(c[c.indexOf('--initial') + 1]).settings?.motionEnabled === true,
  );

test('@pixling/opencode-proxy with emote settings: the resident it creates moves', async () => {
  const { default: opencode } = await import(path.join(root, 'packages/opencode/dist/index.mjs'));
  const client = { session: { messages: async () => ({ data: [] }), promptAsync: async () => {} } };
  const hooks = await opencode.server({ client });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_reacts' } } } });
  await until(() => createdWithMotion('opencode'));
});

test('@pixling/dsh-proxy with emote settings: the resident it creates moves', async () => {
  // A test run has no interactive dsh app, which counts as unattended.
  process.env.PIXLING_PROXY_UNATTENDED = '1';
  try {
    const dsh = await import(path.join(root, 'packages/dsh/dist/index.mjs'));
    const handlers = new Map<string, Handler>();
    dsh.apply({ plugin: () => {}, on: (name: string, fn: Handler) => handlers.set(name, fn), effect: () => {} });
    handlers.get('session/event')!({ id: 'dsh-reacts', header: {} }, { type: 'turn/start', data: {} });
    await until(() => createdWithMotion('dsh'));
  } finally {
    delete process.env.PIXLING_PROXY_UNATTENDED;
  }
});

// A host may treat every function a plugin module exports as a plugin.
test('each package exports its plugin and nothing else', async () => {
  for (const [dir, names] of [
    ['opencode', ['default']],
    ['pi', ['default']],
    ['dsh', ['apply', 'inject', 'name']],
  ] as const) {
    const exported = Object.keys(await import(path.join(root, `packages/${dir}/dist/index.mjs`))).sort();
    assert.deepEqual(exported, [...names], dir);
  }
});
