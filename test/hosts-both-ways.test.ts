// Each in-process host from its built package, as a host would load it: what the agent
// writes reaches its own resident, and what the user writes reaches its own session.
// Each scenario runs in its own process, with receivers and all (`npm test` builds first).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every session finds one message waiting: its reader takes it once, by claim.
const INBOX = {
  'inbox receive': { exit: 3, error: { code: 'unavailable' } },
  'inbox wait': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
  'inbox watch': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
  'inbox read': { exit: 0, result: { kind: 'message', sequence: 1, text: 'hello from the user' } },
};

const runHost = (host: string, scenario: object = INBOX, env: Record<string, string> = {}, cwd = root) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-both-ways-'));
  const log = path.join(dir, 'calls.jsonl');
  const scen = path.join(dir, 'scenario.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(log, '');
  fs.writeFileSync(scen, JSON.stringify(scenario));
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';\nconst report = (o) => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(o));\n${host}`,
    ],
    {
      encoding: 'utf8',
      cwd,
      timeout: 25_000,
      env: {
        ...process.env,
        PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
        FAKE_LOG: log,
        FAKE_SCENARIO: scen,
        XDG_CACHE_HOME: path.join(dir, 'cache'),
        XDG_CONFIG_HOME: path.join(dir, 'config'),
        PIXLING_PROXY_LANGUAGE: 'en',
        ...env,
      },
    },
  );
  assert.equal(res.status, 0, `${res.signal ?? ''} ${res.stderr}`);
  assert.equal(res.stdout, '', 'nothing on the host console');
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const value = (c: string[], name: string) => c[c.indexOf(name) + 1];
  return {
    report: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null,
    calls,
    sent: calls.filter((c) => c[0] === 'message').map((c) => [value(c, '--to'), value(c, '--text')]),
    received: [...new Set(calls.filter((c) => c[1] === 'receive').map((c) => value(c, '--key')))],
    ensured: [...new Set(calls.filter((c) => c[1] === 'ensure').map((c) => value(c, '--key')))],
    cancelled: calls.filter((c) => c[0] === 'question' && c[1] === 'cancel').length,
    asked: calls.filter((c) => c[0] === 'question' && c[1] === 'ask'),
  };
};

const pkg = (name: string) => JSON.stringify(path.join(root, `packages/${name}/dist/index.mjs`));

// An OpenCode 2.x host: events go in through an async iterable, as `setup` reads them.
const V2 = `
  const { default: plugin } = await import(${pkg('opencode')});
  const queue = []; let wake = () => {};
  const emit = (type, data) => { queue.push({ type, data }); wake(); };
  const prompts = []; const replies = [];
  let parents = {};
  const ctx = {
    session: {
      prompt: async (req) => { prompts.push(req); },
      get: async ({ sessionID }) => ({ id: sessionID, parentID: parents[sessionID] }),
    },
    permission: { reply: async (req) => { replies.push(req); } },
    event: {
      subscribe: ({ signal }) => (async function* () {
        while (!signal.aborted) {
          while (queue.length) yield queue.shift();
          await new Promise((r) => { wake = r; setTimeout(r, 50); });
        }
      })(),
    },
  };
  const stop = plugin.setup(ctx);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

test('OpenCode 2.x: two sessions, each with its own resident, replies and messages', () => {
  const r = runHost(`${V2}
    emit('session.created', { sessionID: 'ses_a' });
    emit('session.created', { sessionID: 'ses_b' });
    await sleep(800);
    emit('session.text.ended', { sessionID: 'ses_a', text: 'reply of A' });
    emit('session.text.ended', { sessionID: 'ses_b', text: 'reply of B' });
    emit('session.execution.succeeded', { sessionID: 'ses_a' });
    emit('session.execution.succeeded', { sessionID: 'ses_b' });
    await sleep(2500);
    report({ prompts });
    stop();
    process.exit(0);
  `);
  assert.deepEqual(r.sent.sort(), [
    ['client:opencode/ses_a', 'reply of A'],
    ['client:opencode/ses_b', 'reply of B'],
  ]);
  assert.deepEqual(r.received.sort(), ['ses_a', 'ses_b']);
  const prompts = r.report.prompts as { sessionID: string; text: string }[];
  assert.deepEqual(prompts.map((p) => p.sessionID).sort(), ['ses_a', 'ses_b']);
  for (const p of prompts) {
    assert.match(p.text, /hello from the user/);
    assert.ok(p.text.includes(`client:opencode/${p.sessionID}`));
  }
}, 30_000);

test('OpenCode 2.x: a tool call shows its name, after the text OpenCode ends just behind it', () => {
  const r = runHost(
    `${V2}
    emit('session.created', { sessionID: 'ses_a' });
    await sleep(800);
    emit('session.tool.input.started', { sessionID: 'ses_a', id: 'c1', name: 'shell' });
    emit('session.reasoning.ended', { sessionID: 'ses_a', text: 'because' });
    emit('session.tool.called', { sessionID: 'ses_a', id: 'c1', input: { command: 'cat secret' } });
    emit('session.text.ended', { sessionID: 'ses_a', text: 'Listing now' });
    await sleep(1200);
    emit('session.text.ended', { sessionID: 'ses_a', text: 'Done' });
    emit('session.execution.succeeded', { sessionID: 'ses_a' });
    await sleep(1200);
    stop();
    process.exit(0);
  `,
    INBOX,
    { PIXLING_PROXY_TOOLS: 'all', PIXLING_PROXY_REASONING: 'all' },
  );
  const said = r.sent.map(([, text]: string[]) => text);
  assert.deepEqual(said, ['> because', 'Listing now', '`shell`', 'Done']);
  assert.ok(!JSON.stringify(r.sent).includes('secret'));
}, 30_000);

test('OpenCode 2.x: a text that waited and went out as the reply does not show again', () => {
  const refused = { exit: 1, error: { code: 'unavailable' } };
  const r = runHost(
    `${V2}
    emit('session.created', { sessionID: 'ses_a' });
    await sleep(800);
    emit('session.text.ended', { sessionID: 'ses_a', text: 'Final' });
    await sleep(600);
    emit('session.execution.succeeded', { sessionID: 'ses_a' });
    await sleep(800);
    emit('session.text.ended', { sessionID: 'ses_a', text: 'Next' });
    await sleep(800);
    stop();
    process.exit(0);
  `,
    { ...INBOX, 'message send': [refused, refused, { exit: 0, result: { receipts: [{ outcome: 'spoke' }] } }] },
  );
  assert.deepEqual(
    r.sent.map(([, text]: string[]) => text),
    ['Final', 'Final', 'Final', 'Next'],
  );
}, 30_000);

test('OpenCode 2.x: a subagent gets no resident, seen starting or not', () => {
  const r = runHost(`${V2}
    parents = { ses_old_child: 'ses_parent' };
    emit('session.created', { sessionID: 'ses_child', parentID: 'ses_parent' });
    emit('session.text.ended', { sessionID: 'ses_child', text: 'from the subagent' });
    emit('session.text.ended', { sessionID: 'ses_old_child', text: 'from an older subagent' });
    emit('session.text.ended', { sessionID: 'ses_old_root', text: 'from a session older than this server' });
    await sleep(1500);
    stop();
    process.exit(0);
  `);
  assert.deepEqual(r.ensured, ['ses_old_root']);
  assert.deepEqual(r.sent, [['client:opencode/ses_old_root', 'from a session older than this server']]);
}, 30_000);

const PENDING = {
  ...INBOX,
  'question ask': { exit: 0, result: { promptID: 'p1', state: 'pending' } },
  'question result': { exit: 0, result: { question: { promptID: 'p1', state: 'pending' } } },
};

test('OpenCode 2.x: answered on its own screen, the card is withdrawn and not answered', () => {
  const r = runHost(
    `${V2}
    emit('session.created', { sessionID: 'ses_a' });
    await sleep(500);
    emit('permission.asked', { id: 'per_1', sessionID: 'ses_a', action: 'shell', resources: ['npm test'] });
    await sleep(800);
    emit('permission.replied', { sessionID: 'ses_a', requestID: 'per_1', reply: 'once' });
    await sleep(800);
    report({ replies });
    stop();
    process.exit(0);
  `,
    PENDING,
  );
  assert.equal(r.asked.length, 1);
  assert.ok(r.asked[0][r.asked[0].indexOf('--detail') + 1].includes('npm test'));
  assert.equal(r.cancelled, 1);
  assert.deepEqual(r.report.replies, []);
}, 30_000);

test('OpenCode 2.x: answered on the resident, OpenCode gets the answer', () => {
  const r = runHost(
    `${V2}
    emit('session.created', { sessionID: 'ses_a' });
    await sleep(500);
    emit('permission.asked', { id: 'per_1', sessionID: 'ses_a', action: 'shell', resources: ['npm test'] });
    await sleep(1200);
    report({ replies });
    stop();
    process.exit(0);
  `,
    { ...INBOX, 'question ask': { exit: 0, result: { promptID: 'p1', state: 'answered', selectedChoiceID: 'allow' } } },
  );
  assert.deepEqual(r.report.replies, [{ sessionID: 'ses_a', requestID: 'per_1', decision: 'once' }]);
}, 30_000);

test('OpenCode 2.x: a session that closes withdraws what it was asking', () => {
  const r = runHost(
    `${V2}
    emit('session.created', { sessionID: 'ses_a' });
    await sleep(500);
    emit('permission.asked', { id: 'per_1', sessionID: 'ses_a', action: 'shell', resources: ['npm test'] });
    await sleep(800);
    emit('session.deleted', { sessionID: 'ses_a' });
    await sleep(800);
    stop();
    process.exit(0);
  `,
    PENDING,
  );
  assert.equal(r.cancelled, 1);
}, 30_000);

test('OpenCode 2.x: a stream that fails stays with the plugin', () => {
  runHost(`
    const { default: plugin } = await import(${pkg('opencode')});
    process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e); process.exit(1); });
    plugin.setup({ event: { subscribe: () => (async function* () { throw new Error('down'); })() } });
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  `);
}, 30_000);

test('OpenCode 1.x: a session from before a restart is looked up, and a replied card withdrawn', () => {
  const r = runHost(
    `
    const { default: plugin } = await import(${pkg('opencode')});
    const prompts = [];
    const hooks = await plugin.server({
      client: {
        session: {
          get: async ({ path }) => ({ data: { id: path.id, parentID: path.id === 'ses_child' ? 'ses_root' : undefined } }),
          messages: async () => ({ data: [] }),
          promptAsync: async (req) => { prompts.push(req.path.id); },
        },
        postSessionIdPermissionsPermissionId: async () => { throw new Error('should not answer'); },
      },
    });
    const part = (sessionID, id) => hooks.event({ event: { type: 'message.part.updated', properties: { part: { id, sessionID, type: 'text', text: 'said by ' + sessionID, time: { end: 2 } } } } });
    await part('ses_child', 'p1');
    await part('ses_old', 'p2');
    await hooks.event({ event: { type: 'permission.updated', properties: { id: 'per_1', sessionID: 'ses_old', type: 'bash', metadata: {}, pattern: 'npm test' } } });
    await new Promise((r) => setTimeout(r, 800));
    await hooks.event({ event: { type: 'permission.replied', properties: { sessionID: 'ses_old', permissionID: 'per_1', response: 'once' } } });
    await new Promise((r) => setTimeout(r, 1500));
    report({ prompts });
    process.exit(0);
  `,
    PENDING,
  );
  assert.deepEqual(r.sent, [['client:opencode/ses_old', 'said by ses_old']]);
  assert.ok(r.asked[0][r.asked[0].indexOf('--detail') + 1].includes('npm test'), 'an empty metadata hides nothing');
  assert.equal(r.cancelled, 1);
  assert.deepEqual([...new Set(r.report.prompts)], ['ses_old']);
}, 30_000);

const DSH = `
  const plugin = await import(${pkg('dsh')});
  const handlers = new Map(); const steered = [];
  const agent = (id) => ({ session: { id }, steer: (m) => steered.push([id, m]) });
  plugin.apply({
    plugin: ({ apply }) => apply({
      agents: { get: agent, withoutInitiator: (fn) => fn() },
      sessions: { flush: async () => {} },
      sessionController: { resolveAgent: async (id) => ({ agent: agent(id) }) },
    }),
    on: (name, fn) => handlers.set(name, fn),
    effect: () => {},
  });
  const emit = (id, type, data) => handlers.get('session/event')({ id, header: {} }, { type, data });
  const said = (text) => ({ message: { content: [{ type: 'text', text }] } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

// The package of the running dsh that the plugin finds at run time.
const dshHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-dsh-home-'));
  const llm = path.join(home, 'node_modules/@deepseek-ai/dsh-llm');
  fs.mkdirSync(llm, { recursive: true });
  fs.writeFileSync(path.join(home, 'package.json'), '{}');
  fs.writeFileSync(path.join(llm, 'package.json'), '{"name":"@deepseek-ai/dsh-llm","main":"index.js"}');
  fs.writeFileSync(path.join(llm, 'index.js'), 'exports.createUserMessage = (m) => m;');
  return home;
};

test('dsh: two sessions, each with its own resident, receiver and messages', () => {
  const r = runHost(
    `${DSH}
    emit('s-a', 'turn/start'); emit('s-b', 'turn/start');
    await sleep(800);
    emit('s-a', 'assistant/message', said('reply of A'));
    emit('s-b', 'assistant/message', said('reply of B'));
    await sleep(1500);
    report({ steered });
    process.exit(0);
  `,
    INBOX,
    {},
    dshHome(),
  );
  assert.deepEqual(r.sent.sort(), [
    ['client:dsh/s-a', 'reply of A'],
    ['client:dsh/s-b', 'reply of B'],
  ]);
  assert.deepEqual(r.received.sort(), ['s-a', 's-b']);
  const steered = r.report.steered as [string, { content: { text: string }[] }][];
  assert.deepEqual(steered.map(([id]) => id).sort(), ['s-a', 's-b']);
  for (const [id, message] of steered) {
    assert.match(message.content[0].text, /hello from the user/);
    assert.ok(message.content[0].text.includes(`client:dsh/${id}`));
  }
}, 30_000);

test('pi: what the user writes reaches pi', () => {
  const r = runHost(`
    const { default: extension } = await import(${pkg('pi')});
    const handlers = {}; const messages = [];
    extension({ on: (name, fn) => (handlers[name] = fn), sendUserMessage: (m, o) => messages.push([m, o]) });
    const ctx = { mode: 'tui', isIdle: () => false, sessionManager: { getSessionId: () => 'pi-1' } };
    handlers.session_start({ reason: 'startup' }, ctx);
    await new Promise((r) => setTimeout(r, 2000));
    report({ messages });
    process.exit(0);
  `);
  const [message, options] = r.report.messages[0];
  assert.match(message, /hello from the user/);
  assert.deepEqual(options, { deliverAs: 'followUp' });
  assert.deepEqual(r.received, ['pi-1']);
}, 30_000);

test('a host that finds no Pixling connects once it is there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-late-'));
  const r = runHost(
    `${V2}
    emit('session.text.ended', { sessionID: 'ses_a', text: 'before Pixling' });
    await sleep(1200);
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'up'))}, '');
    emit('session.text.ended', { sessionID: 'ses_a', text: 'after Pixling' });
    await sleep(1800);
    stop();
    process.exit(0);
  `,
    { 'resident ensure': { exit: 0, result: { state: 'onDesk' } }, 'inbox receive': { exit: 3, error: { code: 'x' } } },
    {
      PIXLING_CLI: (() => {
        const cli = path.join(dir, 'pixling');
        fs.writeFileSync(
          cli,
          `#!/bin/sh\n[ -e ${JSON.stringify(path.join(dir, 'up'))} ] || exit 69\nexec ${JSON.stringify(path.join(root, 'test/fake-pixling.mjs'))} "$@"\n`,
          { mode: 0o755 },
        );
        return cli;
      })(),
    },
  );
  assert.deepEqual(r.sent, [['client:opencode/ses_a', 'after Pixling']]);
  assert.deepEqual(r.received, ['ses_a']);
}, 30_000);

test('a session left alone stops listening, and starts again with its next activity', () => {
  const r = runHost(
    `${V2}
    emit('session.created', { sessionID: 'ses_a' });
    await sleep(1800);
    const pidsDuring = (await import('node:child_process')).execSync('pgrep -P ' + process.pid + ' -f [r]eceiver-daemon || true').toString().trim();
    await sleep(800);
    const pidsAfter = (await import('node:child_process')).execSync('pgrep -P ' + process.pid + ' -f [r]eceiver-daemon || true').toString().trim();
    emit('session.text.ended', { sessionID: 'ses_a', text: 'back' });
    await sleep(1000);
    report({ pidsDuring, pidsAfter });
    stop();
    process.exit(0);
  `,
    { 'inbox receive': { exit: 3, error: { code: 'x' } } },
    { PIXLING_PROXY_IDLE_CLOSE_MS: '1500' },
  );
  assert.equal(r.report.pidsAfter, '', 'no receiver left once idle');
  assert.deepEqual(r.sent, [['client:opencode/ses_a', 'back']]);
}, 30_000);
