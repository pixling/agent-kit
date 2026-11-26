// Runs the built hook script against the fake CLI, the way a host would
// (`npm test` builds first).
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetOrder, randomPick } from '../src/core/Conversation.ts';
import { entryId } from '../src/runtimes/ReceiverHub.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'plugins/pixling-proxy/scripts/hook.mjs');
const FAKE = path.join(root, 'test/fake-pixling.mjs');

const ENSURED = { exit: 0, result: { state: 'onDesk', resident: {} } };

function run(
  host: string,
  event: string,
  payload: object,
  scenario: object,
  env: Record<string, string> = {},
  hook = HOOK,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-test-'));
  const log = path.join(dir, 'calls.jsonl');
  const scen = path.join(dir, 'scenario.json');
  fs.writeFileSync(log, '');
  fs.writeFileSync(scen, JSON.stringify({ 'inbox receive': { exit: 5, error: { code: 'rejected' } }, ...scenario }));
  const res = spawnSync(process.execPath, [hook, host, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      PIXLING_CLI: FAKE,
      FAKE_LOG: log,
      FAKE_SCENARIO: scen,
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      XDG_CONFIG_HOME: path.join(dir, 'config'),
      PIXLING_PROXY_LANGUAGE: 'en',
      // The receiver daemon a session-start spawns follows the test runner and exits with it.
      CLAUDE_PID: '',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      PIXLING_PROXY_CODEX_QUEUE: '0',
      ...env,
    },
  });
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { ...res, calls, json: res.stdout ? JSON.parse(res.stdout) : null };
}

const sid = 'b3c1d2e4-0000-4000-8000-000000000001';

test('stop shows the final reply on the resident', () => {
  const r = run('claude-code', 'stop', { session_id: sid, last_assistant_message: 'Tests pass.' }, {});
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  const send = r.calls.find((c) => c[0] === 'message');
  assert.ok(send, 'message send called');
  assert.equal(send[send.indexOf('--to') + 1], `client:claude-code/${sid}`);
  assert.equal(send[send.indexOf('--text') + 1], 'Tests pass.');
});

test('a reply that starts with a dash still arrives', () => {
  const reply = '- first point\n- second point';
  const r = run('claude-code', 'stop', { session_id: sid, last_assistant_message: reply }, {});
  assert.equal(r.status, 0);
  assert.deepEqual(
    r.calls.filter((c) => c[0] === 'refused'),
    [],
  );
  const send = r.calls.find((c) => c[0] === 'message');
  assert.equal(send[send.indexOf('--text') + 1], reply);
});

test('stop clips a long reply', () => {
  const long = 'あ'.repeat(5000);
  const r = run('codex', 'stop', { session_id: sid, turn_id: 't', last_assistant_message: long }, {});
  const send = r.calls.find((c) => c[0] === 'message');
  const text = send[send.indexOf('--text') + 1];
  assert.ok(Array.from(text).length <= 4000);
  assert.ok(text.endsWith('あ…'));
  assert.deepEqual(r.json, {});
});

test('session-start binds the resident and tells the agent its pair', () => {
  const r = run('claude-code', 'session-start', { session_id: sid, source: 'startup' }, { 'resident ensure': ENSURED });
  assert.equal(r.status, 0);
  const ensure = r.calls.find((c) => c[0] === 'resident' && c[1] === 'ensure');
  assert.equal(ensure[ensure.indexOf('--namespace') + 1], 'claude-code');
  assert.equal(ensure[ensure.indexOf('--asset-id') + 1], 'No.1');
  const ctx = r.json.hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, new RegExp(`client:claude-code/${sid}`));
});

test('session-start stays quiet when the user put the resident away', () => {
  const r = run(
    'claude-code',
    'session-start',
    { session_id: sid },
    {
      'resident ensure': { exit: 0, result: { state: 'stowed', resident: null } },
    },
  );
  assert.deepEqual(r.json, {});
});

test('permission: allow on the resident allows the tool', () => {
  const r = run(
    'claude-code',
    'permission',
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'npm test' } },
    {
      'question ask': { exit: 0, result: { promptID: 'p1', state: 'answered', selectedChoiceID: 'allow' } },
    },
  );
  assert.deepEqual(r.json, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  const ask = r.calls.find((c) => c[0] === 'question');
  assert.match(ask[ask.indexOf('--detail') + 1], /npm test/);
});

test('permission: a typed answer denies and passes the text to the agent', () => {
  const r = run(
    'codex',
    'permission',
    { session_id: sid, turn_id: 't', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
    {
      'question ask': {
        exit: 0,
        result: {
          promptID: 'p1',
          state: 'answered',
          selectedChoiceID: 'deny-with-message',
          enteredText: 'use make clean',
        },
      },
    },
  );
  assert.deepEqual(r.json.hookSpecificOutput.decision, { behavior: 'deny', message: 'use make clean' });
});

test('permission: a tool that asks the user itself never becomes a card', () => {
  for (const tool_name of ['AskUserQuestion', 'ExitPlanMode']) {
    const r = run(
      'claude-code',
      'permission',
      { session_id: sid, tool_name, tool_input: { questions: [] } },
      { 'question ask': { exit: 0, result: { promptID: 'p', state: 'answered', selectedChoiceID: 'allow' } } },
    );
    assert.deepEqual(r.json, {});
    assert.deepEqual(
      r.calls.filter((c) => c[0] === 'question'),
      [],
    );
  }
});

test('permission: pending, then answered through question result', () => {
  const r = run(
    'claude-code',
    'permission',
    { session_id: sid, tool_name: 'Edit', tool_input: { file_path: '/x' } },
    {
      'question ask': { exit: 0, result: { promptID: 'p1', state: 'pending' } },
      'question result': {
        exit: 0,
        result: { question: { promptID: 'p1', state: 'answered', selectedChoiceID: 'deny' } },
      },
    },
  );
  assert.deepEqual(r.json.hookSpecificOutput.decision, { behavior: 'deny' });
});

test('permission: no answer in time cancels the card and lets the host ask', () => {
  const r = run(
    'claude-code',
    'permission',
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' } },
    {
      'question ask': { exit: 0, result: { promptID: 'p1', state: 'pending' } },
      'question result': { exit: 0, result: { question: { promptID: 'p1', state: 'pending' } } },
    },
    { PIXLING_PROXY_PERMISSION_WAIT_MS: '1' },
  );
  assert.deepEqual(r.json, {});
  assert.ok(r.calls.some((c) => c[0] === 'question' && c[1] === 'cancel'));
});

const INBOX = {
  'inbox watch': {
    exit: 0,
    result: {
      messages: [
        { messageID: 'm1', sequence: 3, kind: 'message' },
        { messageID: 'm2', sequence: 4, kind: 'message' },
      ],
    },
  },
  'inbox read': [
    { exit: 0, result: { messageID: 'm1', sequence: 3, kind: 'message', text: 'also update the docs' } },
    { exit: 0, result: { messageID: 'm2', sequence: 4, kind: 'closed', text: '' } },
  ],
};

test('prompt hands unread messages to the agent as context', () => {
  const r = run('codex', 'prompt', { session_id: sid, turn_id: 't', prompt: 'go' }, INBOX);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(r.json.hookSpecificOutput.additionalContext, /also update the docs/);
});

test('Claude Code: prompt hands unread messages to the agent as context', () => {
  const r = run('claude-code', 'prompt', { session_id: sid, prompt: 'go' }, INBOX);
  assert.equal(r.status, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const message = r.json.hookSpecificOutput.additionalContext;
  assert.match(message, /also update the docs/);
  // Says who it came through, and that nothing more needs fetching or calling.
  assert.ok(message.includes(`client:claude-code/${sid}`));
  assert.match(message, /all the messages they typed/);
  assert.match(message, /no tool needed/);
});

test('Claude Code: prompt says nothing when the inbox is empty, or Pixling is missing', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-bound-'));
  const env = { XDG_CACHE_HOME: cache, PIXLING_PROXY_RECEIVE: '0' };
  run('claude-code', 'session-start', { session_id: sid }, { 'resident ensure': ENSURED }, env);
  assert.deepEqual(run('claude-code', 'prompt', { session_id: sid }, {}, env).json, {});
  const missing = run('claude-code', 'prompt', { session_id: sid }, {}, { PIXLING_CLI: '/nonexistent/pixling' });
  assert.equal(missing.status, 0);
  assert.deepEqual(missing.json, {});
});

test('wait wakes Claude Code with exit 2 when the user writes', () => {
  const r = run(
    'claude-code',
    'wait',
    { session_id: sid },
    {
      'resident ensure': ENSURED,
      'inbox wait': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
      ...INBOX,
    },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /also update the docs/);
});

test('wait never holds up a non-interactive run (claude -p)', () => {
  const r = run('claude-code', 'wait', { session_id: sid }, {}, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 0);
});

test('wait never blocks a Codex hook', () => {
  const r = run('codex', 'wait', { session_id: sid, turn_id: 't' }, {});
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 0);
});

test('a missing Pixling CLI never gets in the way', () => {
  const r = run(
    'claude-code',
    'stop',
    { session_id: sid, last_assistant_message: 'hi' },
    {},
    { PIXLING_CLI: '/nonexistent/pixling' },
  );
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
});

test('an unknown host or broken payload is ignored', () => {
  assert.deepEqual(run('nope', 'stop', { session_id: sid }, {}).json, {});
  const res = spawnSync(process.execPath, [HOOK, 'claude-code', 'stop'], {
    input: 'not json',
    encoding: 'utf8',
    // Its own log: a test never writes to the real one.
    env: { ...process.env, XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-test-')) },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '{}');
});

test('two waiters started together hand a message to the agent once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-test-'));
  const scen = path.join(dir, 'scenario.json');
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  fs.writeFileSync(
    scen,
    JSON.stringify({
      'resident ensure': ENSURED,
      'inbox wait': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
      'inbox watch': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } },
      'inbox read': { exit: 0, result: { messageID: 'm1', sequence: 3, kind: 'message', text: 'once only' } },
    }),
  );
  const env = {
    ...process.env,
    PIXLING_CLI: FAKE,
    FAKE_LOG: path.join(dir, 'calls.jsonl'),
    FAKE_SCENARIO: scen,
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_PID: '',
  };
  const one = () =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [HOOK, 'claude-code', 'wait'], { env });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
      child.stdin.end(JSON.stringify({ session_id: sid }));
    });
  const results = await Promise.all([one(), one(), one()]);
  assert.equal(results.filter((r) => r.code === 2).length, 1);
  assert.equal(results.filter((r) => /once only/.test(r.err)).length, 1);
});

test('asset list: a session gets one pick, and an unknown one falls through to the next', () => {
  const keys = Array.from({ length: 40 }, (_, i) => `session-${i}`);
  const firsts = new Set(keys.map((k) => assetOrder(['No.1', 'No.2', 'No.7'], k)[0]));
  assert.equal(firsts.size, 3, 'sessions spread over every asset');
  assert.deepEqual(assetOrder(['No.1', 'No.2'], 'k'), assetOrder(['No.1', 'No.2'], 'k'), 'stable for a key');
  assert.deepEqual(assetOrder('No.5', 'k'), ['No.5']);

  const r = run(
    'claude-code',
    'session-start',
    { session_id: sid },
    {
      'resident ensure': [
        { exit: 4, error: { code: 'rejected', detail: 'targetNotFound' } },
        { exit: 0, result: { state: 'onDesk' } },
      ],
    },
    { PIXLING_PROXY_ASSET: 'No.999, No.2' },
  );
  const tried = r.calls.filter((c) => c[1] === 'ensure').map((c) => c[c.indexOf('--asset-id') + 1]);
  assert.equal(tried.length, 2);
  assert.deepEqual(new Set(tried), new Set(['No.999', 'No.2']));
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('asset random: a session gets one resident from the whole zukan, objects left out', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `pack/r${i}`);
  const picks = new Set(Array.from({ length: 200 }, (_, i) => randomPick(ids, `session-${i}`)));
  assert.ok(picks.size > 20, 'sessions spread over the zukan');
  assert.equal(randomPick(ids, 'k'), randomPick(ids, 'k'), 'stable for a key');
  assert.equal(randomPick([], 'k'), undefined);

  const r = run(
    'claude-code',
    'session-start',
    { session_id: sid },
    {
      zukan: [
        {
          exit: 0,
          result: {
            entries: [
              { id: 'pack/chair', kind: 'object' },
              { id: 'pack/a', kind: 'resident' },
            ],
            nextOffset: 2,
          },
        },
        { exit: 0, result: { entries: [{ id: 'pack/b', kind: 'resident' }], nextOffset: null } },
      ],
    },
    { PIXLING_PROXY_ASSET: 'Random' },
  );
  const pages = r.calls.filter((c) => c[0] === 'zukan').map((c) => c[c.indexOf('--offset') + 1]);
  assert.deepEqual(pages, ['0', '2']);
  const tried = r.calls.filter((c) => c[1] === 'ensure').map((c) => c[c.indexOf('--asset-id') + 1]);
  assert.equal(tried.length, 1);
  assert.equal(tried[0], randomPick(['pack/a', 'pack/b'], sid));
});

test('asset random: an unreadable zukan falls through to the next in the list', () => {
  const r = run(
    'claude-code',
    'session-start',
    { session_id: sid },
    { zukan: { exit: 5, error: { code: 'rejected' } } },
    { PIXLING_PROXY_ASSET: 'random, No.3' },
  );
  const tried = r.calls.filter((c) => c[1] === 'ensure').map((c) => c[c.indexOf('--asset-id') + 1]);
  assert.ok(tried.includes('No.3'));
  assert.ok(!tried.includes('random'));
});

test('session-start waits out a resident another hook is still creating', () => {
  const r = run(
    'claude-code',
    'session-start',
    { session_id: sid },
    {
      'resident ensure': [
        { exit: 0, result: { state: 'unavailable', resident: null } },
        { exit: 0, result: { state: 'unavailable', resident: null } },
        { exit: 0, result: { state: 'onDesk', resident: {} } },
      ],
    },
  );
  assert.equal(r.json.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(r.calls.filter((c) => c[1] === 'ensure').length, 3);
});

test('a non-interactive run (claude -p) gets no resident', () => {
  const r = run(
    'claude-code',
    'stop',
    { session_id: sid, last_assistant_message: 'done' },
    {},
    { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
  );
  assert.deepEqual(r.json, {});
  assert.equal(r.calls.length, 0);
  const on = run(
    'claude-code',
    'stop',
    { session_id: sid, last_assistant_message: 'done' },
    {},
    {
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      XDG_CONFIG_HOME: writeConfig({ unattended: true }),
    },
  );
  assert.ok(on.calls.some((c) => c[0] === 'message'));
});

test('a late answer stays unread, and the agent is told to read it itself', () => {
  const r = run(
    'codex',
    'prompt',
    { session_id: sid, turn_id: 't', prompt: 'go' },
    { 'inbox watch': { exit: 0, result: { messages: [{ messageID: 'p9', sequence: 5, kind: 'answer' }] } } },
  );
  const message = r.json.hookSpecificOutput.additionalContext;
  assert.match(message, /answered your question `p9`/);
  assert.match(message, /pixling_inbox_read/);
  assert.match(message, /messageID `p9`/);
  assert.doesNotMatch(message, /The user wrote to you/);
  assert.ok(!r.calls.some((c) => c[0] === 'inbox' && c[1] === 'read'), 'the answer is left for the agent');
});

function writeConfig(cfg: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-config-'));
  fs.mkdirSync(path.join(dir, 'pixling'));
  fs.writeFileSync(path.join(dir, 'pixling', 'proxy.json'), JSON.stringify(cfg));
  return dir;
}

test('session-start and wait started together both bind without error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-test-'));
  const scen = path.join(dir, 'scenario.json');
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  fs.writeFileSync(
    scen,
    JSON.stringify({
      'resident ensure': ENSURED,
      'inbox receive': { exit: 5, error: { code: 'rejected' } },
      'inbox wait': { exit: 0, result: { messages: [] } },
    }),
  );
  const env = {
    ...process.env,
    PIXLING_CLI: FAKE,
    FAKE_LOG: path.join(dir, 'calls.jsonl'),
    FAKE_SCENARIO: scen,
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    PIXLING_PROXY_DEBUG: path.join(dir, 'proxy.log'),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_PID: '',
  };
  const one = (event: string) =>
    new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [HOOK, 'claude-code', event], { env });
      child.on('close', () => resolve());
      child.stdin.end(JSON.stringify({ session_id: sid }));
    });
  await Promise.all(Array.from({ length: 4 }, (_, i) => one(i % 2 ? 'wait' : 'session-start')));
  const logged = fs.existsSync(env.PIXLING_PROXY_DEBUG) ? fs.readFileSync(env.PIXLING_PROXY_DEBUG, 'utf8') : '';
  assert.doesNotMatch(logged, /error/);
});

// Narration: one content block per transcript line, as Claude Code writes it.
const row = (type: string, content: object[], extra: object = {}) =>
  JSON.stringify({ type, message: { content }, ...extra }) + '\n';
const said = (text: string, extra: object = {}) => row('assistant', [{ type: 'text', text }], extra);

function showRun(cache: string, event: string, payload: object) {
  return run(
    'claude-code',
    event,
    { session_id: sid, ...payload },
    { 'resident ensure': ENSURED },
    {
      XDG_CACHE_HOME: cache,
    },
  );
}
const sent = (r: { calls: string[][] }) =>
  r.calls.filter((c) => c[0] === 'message').map((c) => c[c.indexOf('--text') + 1]);

test('shows the text before each tool call once, and the final reply once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, said('from an earlier session'));
  showRun(cache, 'session-start', { transcript_path: transcript });

  fs.appendFileSync(
    transcript,
    row('user', [{ type: 'text', text: 'go' }]) +
      row('assistant', [{ type: 'thinking', thinking: 'hmm' }]) +
      said('Looking at the hooks first.') +
      row('assistant', [{ type: 'tool_use', name: 'Bash' }]) +
      said('a subagent', { isSidechain: true }),
  );
  assert.deepEqual(sent(showRun(cache, 'before-tool', { transcript_path: transcript })), [
    'Looking at the hooks first.',
  ]);
  // A second hook at the same point shows nothing new.
  assert.deepEqual(sent(showRun(cache, 'before-tool', { transcript_path: transcript })), []);
  // A subagent's tool call reads nothing (and does not move the cursor).
  fs.appendFileSync(transcript, said('Still the main thread.'));
  assert.deepEqual(sent(showRun(cache, 'before-tool', { transcript_path: transcript, agent_id: 'a1' })), []);
  assert.deepEqual(sent(showRun(cache, 'before-tool', { transcript_path: transcript })), ['Still the main thread.']);

  // Stop before the transcript has the final reply: it comes from the payload...
  fs.appendFileSync(transcript, said('Found it.') + '{"type":"assistant","mess');
  const stop = showRun(cache, 'stop', { transcript_path: transcript, last_assistant_message: 'All done.' });
  assert.deepEqual(sent(stop), ['Found it.', 'All done.']);
  // ...and is not shown again when its line turns up.
  fs.writeFileSync(transcript, fs.readFileSync(transcript, 'utf8').replace(/\{"type":"assistant","mess$/, ''));
  fs.appendFileSync(transcript, said('All done.') + said('Next turn.'));
  assert.deepEqual(sent(showRun(cache, 'before-tool', { transcript_path: transcript })), ['Next turn.']);
});

test('Stop does not repeat a final reply the transcript already showed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  showRun(cache, 'session-start', { transcript_path: transcript });
  fs.appendFileSync(transcript, said('Same.'));
  const stop = showRun(cache, 'stop', { transcript_path: transcript, last_assistant_message: 'Same.' });
  assert.deepEqual(sent(stop), ['Same.']);
});

test('texts off: only the final reply, and long texts end with … only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, said('between tools'));
  const long = 'x'.repeat(5000);
  const r = run(
    'claude-code',
    'stop',
    { session_id: sid, transcript_path: transcript, last_assistant_message: long },
    {},
    { PIXLING_PROXY_TEXT: '0' },
  );
  const [text] = sent(r);
  assert.equal(sent(r).length, 1);
  assert.equal(Array.from(text).length, 4000);
  assert.ok(text.endsWith('x…'));
});

test('tool calls come from the payload, with what was written before them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const env = { XDG_CACHE_HOME: cache, PIXLING_PROXY_TOOLS: 'all' };
  const hook = (event: string, payload: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript, ...payload },
      { 'resident ensure': ENSURED },
      env,
    );
  hook('session-start', {});
  // The transcript has no line for the call yet: the name is not read from there.
  fs.appendFileSync(transcript, said('Running the tests.'));
  assert.deepEqual(sent(hook('before-tool', { tool_name: 'Bash' })), ['Running the tests.\n\n`Bash`']);
  const quiet = hook('before-tool', { tool_name: 'Read' });
  assert.deepEqual(sent(quiet), ['`Read`']);
  const send = quiet.calls.find((c) => c[0] === 'message')!;
  assert.equal(send[send.indexOf('--action') + 1], 'none');
  assert.ok(!JSON.stringify(quiet.calls).includes('secret'));
});

test('everyMs holds what happens between tool calls, and Stop shows all of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const env = { XDG_CACHE_HOME: cache, PIXLING_PROXY_TOOLS: 'all', PIXLING_PROXY_EVERY_MS: '3600000' };
  const hook = (event: string, payload: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript, ...payload },
      { 'resident ensure': ENSURED },
      env,
    );
  hook('session-start', {});
  fs.appendFileSync(transcript, said('First.'));
  assert.deepEqual(sent(hook('before-tool', { tool_name: 'Bash' })), ['First.\n\n`Bash`']);
  fs.appendFileSync(transcript, said('Second.'));
  assert.deepEqual(sent(hook('before-tool', { tool_name: 'Bash' })), []);
  assert.deepEqual(sent(hook('before-tool', { tool_name: 'Bash' })), []);
  assert.deepEqual(sent(hook('stop', { last_assistant_message: 'Done.' })), ['Second.\n\n`Bash` ×2', 'Done.']);
});

test('a text that did not reach the resident shows at the next chance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const hook = (event: string, scenario: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript },
      { 'resident ensure': ENSURED, ...scenario },
      { XDG_CACHE_HOME: cache },
    );
  hook('session-start', {});
  fs.appendFileSync(transcript, said('Not lost.'));
  const refused = { 'message send': { exit: 1, error: { code: 'unavailable' } } };
  const first = hook('before-tool', refused);
  const second = hook('before-tool', {});
  assert.deepEqual(sent(first), ['Not lost.']);
  assert.deepEqual(sent(second), ['Not lost.']);
  assert.equal(
    first.calls.find((c) => c[0] === 'message')!.at(-1),
    second.calls.find((c) => c[0] === 'message')!.at(-1),
    'the same request id, in case the first one landed after all',
  );
});

test('Stop shows the reply while another hook holds the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const lockDir = path.join(cache, 'pixling-proxy', 'claude-code', sid);
  fs.mkdirSync(lockDir, { recursive: true });
  // This test's own runner stays alive through the hook, and stands in for that hook.
  fs.writeFileSync(path.join(lockDir, 'reader.lock'), String(process.pid));
  const r = run(
    'claude-code',
    'stop',
    { session_id: sid, transcript_path: path.join(dir, 't.jsonl'), last_assistant_message: 'Still here.' },
    {},
    { XDG_CACHE_HOME: cache },
  );
  assert.deepEqual(sent(r), ['Still here.']);
}, 15_000);

test('two calls in a row that say the same thing are two messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TOOLS: 'all', PIXLING_PROXY_TEXT: '0' };
  const hook = (event: string, payload: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript, ...payload },
      { 'resident ensure': ENSURED },
      env,
    );
  hook('session-start', {});
  const ids = [1, 2].map(() => {
    const send = hook('before-tool', { tool_name: 'Read' }).calls.find((c) => c[0] === 'message')!;
    return send[send.indexOf('--request-id') + 1];
  });
  assert.notEqual(ids[0], ids[1]);
});

test('a compaction does not skip what waits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const hook = (event: string, payload: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript, ...payload },
      { 'resident ensure': ENSURED },
      { XDG_CACHE_HOME: path.join(dir, 'cache') },
    );
  hook('session-start', {});
  fs.appendFileSync(transcript, said('Before the compaction.'));
  hook('session-start', { source: 'compact' });
  assert.deepEqual(sent(hook('before-tool', {})), ['Before the compaction.']);
});

test('the next turn may end in the same words, even ahead of its line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const hook = (event: string, payload: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript, ...payload },
      { 'resident ensure': ENSURED },
      { XDG_CACHE_HOME: path.join(dir, 'cache') },
    );
  hook('session-start', {});
  assert.deepEqual(sent(hook('stop', { last_assistant_message: 'Done.' })), ['Done.']);
  fs.appendFileSync(transcript, said('Done.'));
  hook('prompt', {});
  assert.deepEqual(sent(hook('stop', { last_assistant_message: 'Done.' })), ['Done.']);
});

test('the same reply in the next turn is a new message, whatever waited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, '');
  const hook = (event: string, payload: object) =>
    run(
      'claude-code',
      event,
      { session_id: sid, transcript_path: transcript, ...payload },
      { 'resident ensure': ENSURED },
      { XDG_CACHE_HOME: path.join(dir, 'cache') },
    );
  hook('session-start', {});
  const ids = [1, 2].map(() => {
    hook('prompt', {});
    const send = hook('stop', { last_assistant_message: 'Done.' }).calls.find((c) => c[0] === 'message')!;
    return send[send.indexOf('--request-id') + 1];
  });
  assert.notEqual(ids[0], ids[1]);
});

test('reads a Codex session file too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-show-'));
  const cache = path.join(dir, 'cache');
  const transcript = path.join(dir, 'rollout.jsonl');
  const item = (role: string, phase: string, text: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        phase,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    }) + '\n';
  fs.writeFileSync(transcript, item('assistant', 'final_answer', 'old turn'));
  const env = { XDG_CACHE_HOME: cache };
  run(
    'codex',
    'session-start',
    { session_id: sid, turn_id: 't', transcript_path: transcript },
    { 'resident ensure': ENSURED },
    env,
  );
  fs.appendFileSync(
    transcript,
    item('user', '', 'go') +
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Checking the tests.' } }) +
      '\n' +
      item('assistant', 'commentary', 'Checking the tests.'),
  );
  // The hook hands narration to a detached copy; run that copy directly here.
  const r = run('codex', 'before-tool-now', { sessionId: sid, transcriptPath: transcript }, {}, env);
  assert.deepEqual(sent(r), ['Checking the tests.']);
  const quick = run('codex', 'before-tool', { session_id: sid, turn_id: 't', transcript_path: transcript }, {}, env);
  assert.deepEqual(quick.json, {});
  assert.equal(quick.status, 0);
});

// Antigravity: camelCase payloads, one transcript line per step, text handed over as injected steps.
test('antigravity: binds on SessionStart, narrates from its transcript, and shows the reply once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache') };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  const step = (type: string, content: string, source = 'MODEL') => JSON.stringify({ type, source, content }) + '\n';
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir] };
  fs.writeFileSync(transcript, step('PLANNER_RESPONSE', 'old turn') + step('USER_INPUT', 'go', 'USER_EXPLICIT'));

  const start = run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);
  const ensure = start.calls.find((c) => c[0] === 'resident' && c[1] === 'ensure');
  assert.equal(ensure[ensure.indexOf('--namespace') + 1], 'antigravity');
  assert.match(start.json.injectSteps[0].systemMessage.systemMessage, new RegExp(`client:antigravity/${sid}`));

  fs.appendFileSync(transcript, step('PLANNER_RESPONSE', 'Listing the files.'));
  const tool = { ...base, toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }, stepIdx: 3 };
  // The hook hands narration to a detached copy (checked at the end); run that copy directly here.
  const now = run('antigravity', 'before-tool-now', { sessionId: sid, transcriptPath: transcript }, {}, env);
  assert.deepEqual(sent(now), ['Listing the files.']);

  fs.appendFileSync(transcript, step('GENERIC', 'README.md') + step('PLANNER_RESPONSE', 'Done: one file.'));
  const stop = run('antigravity', 'stop', { ...base, terminationReason: 'NO_TOOL_CALL', executionNum: 0 }, {}, env);
  assert.deepEqual(sent(stop), ['Done: one file.']);
  assert.deepEqual(stop.json, {});

  // Antigravity waits for its hooks: the hook returns at once, leaving the call to agy's own check.
  const quick = run('antigravity', 'before-tool', tool, {}, env);
  assert.deepEqual(quick.json, { decision: 'ask' });
  assert.equal(quick.status, 0);
});

test('antigravity: what the user wrote goes in before the next model call', () => {
  const r = run('antigravity', 'prompt', { conversationId: sid, invocationNum: 1 }, INBOX);
  assert.match(r.json.injectSteps[0].userMessage, /also update the docs/);
});

test('antigravity: post-invocation holds open after a reply and continues with a userMessage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-post-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '1000' };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'All set.' }) + '\n',
  );
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir] };

  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);
  const r = run(
    'antigravity',
    'post-invocation',
    { ...base, invocationNum: 0 },
    { 'inbox wait': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } }, ...INBOX },
    env,
  );
  assert.deepEqual(sent(r), ['All set.']);
  assert.equal(r.json.terminationBehavior, 'force_continue');
  assert.match(r.json.injectSteps[0].userMessage, /also update the docs/);
});

test('antigravity: post-invocation skips tool steps, and trailing stop does not repeat the reply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-tool-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '50' };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir] };

  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);

  // Tool step in progress: post-invocation returns immediately without showing or waiting.
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: '', tool_calls: [{ name: 'run_command' }] }) +
      '\n' +
      JSON.stringify({ type: 'GENERIC', source: 'MODEL', content: 'ok' }) +
      '\n',
  );
  const mid = run('antigravity', 'post-invocation', { ...base, invocationNum: 0 }, {}, env);
  assert.deepEqual(mid.json, {});
  assert.deepEqual(sent(mid), []);

  // Final reply with no user message arriving: post-invocation shows it once, trailing stop stays quiet.
  fs.appendFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Finished.' }) + '\n',
  );
  const end = run(
    'antigravity',
    'post-invocation',
    { ...base, invocationNum: 1 },
    { 'inbox wait': { exit: 0, result: { messages: [] } } },
    env,
  );
  assert.deepEqual(sent(end), ['Finished.']);
  assert.deepEqual(end.json, {});

  const trailingStop = run(
    'antigravity',
    'stop',
    { ...base, terminationReason: 'NO_TOOL_CALL', executionNum: 0 },
    {},
    env,
  );
  assert.deepEqual(sent(trailingStop), []);
  assert.deepEqual(trailingStop.json, {});
});

test('antigravity: turnEndWaitMs=0 disables post-invocation holding and leaves the reply to stop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-off-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '0' };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Idle reply.' }) + '\n',
  );
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir] };

  const post = run('antigravity', 'post-invocation', { ...base, invocationNum: 0 }, {}, env);
  assert.deepEqual(post.json, {});
  assert.deepEqual(sent(post), []);

  const stop = run('antigravity', 'stop', { ...base, terminationReason: 'NO_TOOL_CALL', executionNum: 0 }, {}, env);
  assert.deepEqual(sent(stop), ['Idle reply.']);
  assert.deepEqual(stop.json, {});
});

test('antigravity: subagent sessions never bind a resident or hold open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-sub-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '60000' };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] sender=parent-1 content=work' }) +
      '\n' +
      JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Sub done.' }) +
      '\n',
  );
  const subPayload = { conversationId: 'sub-conv-1', transcriptPath: transcript, lastUserInput: '' };

  for (const event of ['session-start', 'prompt', 'post-invocation', 'stop']) {
    const r = run('antigravity', event, subPayload, { 'resident ensure': ENSURED, ...INBOX }, env);
    assert.equal(r.status, 0);
    assert.deepEqual(r.json, {});
    assert.deepEqual(r.calls, []);
  }
  const tool = run(
    'antigravity',
    'before-tool',
    { ...subPayload, toolCall: { name: 'send_message', args: {} } },
    {},
    env,
  );
  assert.deepEqual(tool.json, { decision: 'ask' });
  assert.deepEqual(tool.calls, []);
});

test('antigravity: post-invocation skips waiting when undelivered messages are already queued', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-prequeue-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '60000' };
  const logsDir = path.join(dir, '.system_generated', 'logs');
  const undeliveredDir = path.join(dir, '.system_generated', 'messages', 'undelivered');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(undeliveredDir, { recursive: true });
  const transcript = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Waiting on tests.' }) + '\n',
  );
  fs.writeFileSync(path.join(undeliveredDir, 'task-done-1'), '');
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir], lastUserInput: 'run tests' };

  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);
  const started = Date.now();
  const r = run('antigravity', 'post-invocation', { ...base, invocationNum: 0 }, {}, env);
  assert.equal(r.status, 0);
  assert.deepEqual(sent(r), ['Waiting on tests.']);
  assert.deepEqual(r.json, {});
  assert.equal(
    r.calls.some((c) => c[0] === 'inbox' && c[1] === 'wait'),
    false,
    'never spawns inbox wait when undelivered messages are already present',
  );
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

test('antigravity: post-invocation aborts inbox wait as soon as an undelivered message arrives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-arrive-'));
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(
    cli,
    `#!/bin/sh\ncase "$*" in *"inbox wait"*) exec sleep 300;; esac\nexec ${JSON.stringify(FAKE)} "$@"\n`,
    { mode: 0o755 },
  );
  const logsDir = path.join(dir, '.system_generated', 'logs');
  const undeliveredDir = path.join(dir, '.system_generated', 'messages', 'undelivered');
  fs.mkdirSync(logsDir, { recursive: true });
  const transcript = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Running background task.' }) + '\n',
  );
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir], lastUserInput: 'go' };
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '60000' };
  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);

  const scenario = path.join(dir, 'scenario.json');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(scenario, JSON.stringify({ 'resident ensure': ENSURED }));
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK, 'antigravity', 'post-invocation'], {
    env: { ...process.env, ...env, PIXLING_CLI: cli, FAKE_SCENARIO: scenario, FAKE_LOG: log },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stdin.end(JSON.stringify({ ...base, invocationNum: 0 }));

  // Create `messages/undelivered/<id>` once the hook is waiting.
  const timer = setTimeout(() => {
    fs.mkdirSync(undeliveredDir, { recursive: true });
    fs.writeFileSync(path.join(undeliveredDir, 'task-finished'), '');
  }, 300);

  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {});
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
}, 15_000);

test('antigravity: post-invocation skips waiting when the resident is disconnected or stowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-disc-pre-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '60000' };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Done.' }) + '\n');
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir], lastUserInput: 'hi' };
  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);

  const unavailable = { exit: 5, error: { code: 'unavailable', detail: 'Pixling is not running' } };
  const r = run(
    'antigravity',
    'post-invocation',
    { ...base, invocationNum: 0 },
    { 'message send': unavailable, 'resident ensure': unavailable },
    env,
  );
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  assert.equal(
    r.calls.some((c) => c[0] === 'inbox' && c[1] === 'wait'),
    false,
    'does not wait when Pixling is unreachable',
  );
});

test('antigravity: post-invocation aborts inbox wait when the resident disconnects during the wait', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-disc-mid-'));
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(
    cli,
    `#!/bin/sh\ncase "$*" in *"inbox wait"*) exec sleep 300;; esac\nexec ${JSON.stringify(FAKE)} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    PIXLING_PROXY_TURN_END_WAIT_MS: '60000',
    PIXLING_PROXY_DESK_CHECK_MS: '100',
    PIXLING_CLI: cli,
  };
  const transcript = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Waiting.' }) + '\n',
  );
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir], lastUserInput: 'hi' };
  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);

  const started = Date.now();
  const r = run(
    'antigravity',
    'post-invocation',
    { ...base, invocationNum: 0 },
    { 'resident ensure': [ENSURED, { exit: 0, result: { state: 'stowed' } }] },
    env,
  );
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
}, 15_000);

test('antigravity: post-invocation finishes reading a resident reply even if undelivered arrives mid-read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-proxy-agy-midread-'));
  const logsDir = path.join(dir, '.system_generated', 'logs');
  const undeliveredDir = path.join(dir, '.system_generated', 'messages', 'undelivered');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(undeliveredDir, { recursive: true });
  const transcript = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Ready.' }) + '\n');
  // Fake CLI that writes an undelivered file while `inbox read` is in flight: the read
  // must not be cut short once `inbox wait` has already signaled an arrival.
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2).filter((a) => a !== '--json');
if (args[0] === 'inbox' && args[1] === 'read') {
  fs.writeFileSync(path.join(${JSON.stringify(undeliveredDir)}, 'late-task'), '');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
const r = spawnSync(process.execPath, [${JSON.stringify(FAKE)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
    { mode: 0o755 },
  );
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '60000', PIXLING_CLI: cli };
  const base = { conversationId: sid, transcriptPath: transcript, workspacePaths: [dir], lastUserInput: 'go' };
  run('antigravity', 'session-start', base, { 'resident ensure': ENSURED }, env);

  const r = run(
    'antigravity',
    'post-invocation',
    { ...base, invocationNum: 0 },
    { 'inbox wait': { exit: 0, result: { messages: [{ messageID: 'm1', sequence: 3, kind: 'message' }] } }, ...INBOX },
    env,
  );
  assert.equal(r.status, 0);
  assert.equal(r.json.terminationBehavior, 'force_continue');
  assert.match(r.json.injectSteps[0].userMessage, /also update the docs/);
}, 15_000);

test('antigravity: PreToolUse never denies a tool call, even with nothing to do', () => {
  const tool = { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } };
  // No conversation id (nothing to bind), and narration off.
  assert.deepEqual(run('antigravity', 'before-tool', tool, {}).json, { decision: 'ask' });
  const off = run('antigravity', 'before-tool', { conversationId: sid, ...tool }, {}, { PIXLING_PROXY_TEXT: '0' });
  assert.deepEqual(off.json, { decision: 'ask' });
});

// What must never happen: a hook holding up its host.
const stubborn = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-stubborn-'));
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(cli, `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`, {
    mode: 0o755,
  });
  return cli;
};

test('a CLI that hangs and ignores SIGTERM cannot hold a hook past its budget', () => {
  const started = Date.now();
  const r = run('claude-code', 'prompt', { session_id: sid }, {}, { PIXLING_CLI: stubborn() });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  // The prompt's optional part (3 s), and a second to kill the CLI.
  assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started} ms; the user waits for this hook`);
}, 20_000);

// A program that loads slowly (a busy machine just after login), simulated by holding
// back the program's module: what is left of the budget is all the program gets.
const slowLoad = (ms: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-slow-load-'));
  const register = path.join(dir, 'register.mjs');
  fs.writeFileSync(
    register,
    `import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, next) {
    if (/hook-main/.test(url)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
    return next(url, context);
  },
});
`,
  );
  return register;
};

test('loading the program counts against the budget, as it does for the host', () => {
  const started = Date.now();
  const r = run(
    'claude-code',
    'prompt',
    { session_id: sid },
    {},
    {
      PIXLING_CLI: stubborn(),
      NODE_OPTIONS: `--import ${slowLoad(2500)}`,
    },
  );
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  // 2.5 s loading, what is left of the prompt's 3 s, and a second to kill the CLI.
  assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started} ms`);
}, 20_000);

test('a machine slow to start every time still gets what the user typed through the prompt', () => {
  const r = run('claude-code', 'prompt', { session_id: sid }, INBOX, {
    NODE_OPTIONS: `--import ${slowLoad(3500)}`,
  });
  assert.equal(r.status, 0);
  assert.match(r.json?.hookSpecificOutput?.additionalContext ?? '', /also update the docs/);
}, 20_000);

// The fake CLI, with the resident's reactions slow to answer.
const slowReactions = (ms: number) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-slow-reactions-'));
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const [command, sub] = process.argv.slice(2).filter((a) => a !== '--json');
if (command === 'resident' && ['emote', 'status', 'describe'].includes(sub)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
}
const r = spawnSync(process.execPath, [${JSON.stringify(FAKE)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
    { mode: 0o755 },
  );
  return cli;
};

test('a slow reaction to the turn never costs a message the user typed', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-emote-config-'));
  fs.mkdirSync(path.join(config, 'pixling'));
  fs.writeFileSync(
    path.join(config, 'pixling/proxy.json'),
    JSON.stringify({ emote: { apiKey: 'x', endpoint: 'http://127.0.0.1:9/v4/ai' } }),
  );
  const r = run(
    'claude-code',
    'prompt',
    { session_id: sid },
    INBOX,
    { PIXLING_CLI: slowReactions(2500), XDG_CONFIG_HOME: config, NODE_OPTIONS: `--import ${slowLoad(500)}` },
    HOOK,
  );
  assert.equal(r.status, 0);
  assert.ok(
    r.calls.some((c) => c[0] === 'inbox' && c[1] === 'read'),
    'read the inbox',
  );
  assert.match(r.json?.hookSpecificOutput?.additionalContext ?? '', /also update the docs/);
}, 20_000);

test('a hook before a tool call still answers when the CLI hangs', () => {
  const started = Date.now();
  const r = run(
    'antigravity',
    'before-tool',
    { conversationId: sid, toolCall: { name: 'x' } },
    {},
    { PIXLING_CLI: stubborn(), PIXLING_PROXY_TEXT: '0' },
  );
  assert.deepEqual(r.json, { decision: 'ask' });
  assert.ok(Date.now() - started < 10_000);
}, 20_000);

test('a permission card on a CLI that hangs gives up, and leaves it to the host', () => {
  const started = Date.now();
  const r = run(
    'claude-code',
    'permission',
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' } },
    {},
    { PIXLING_CLI: stubborn() },
  );
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  assert.ok(Date.now() - started < 25_000, `took ${Date.now() - started} ms`);
}, 40_000);

test('a waiter whose host is gone ends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-waiter-'));
  const cli = path.join(dir, 'pixling');
  // Answers like the fake CLI, except that an inbox wait never comes back.
  fs.writeFileSync(
    cli,
    `#!/bin/sh\ncase "$*" in *"inbox wait"*) exec sleep 300;; esac\nexec ${JSON.stringify(FAKE)} "$@"\n`,
    { mode: 0o755 },
  );
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const started = Date.now();
  const r = run(
    'claude-code',
    'wait',
    { session_id: sid },
    { 'resident ensure': ENSURED },
    { PIXLING_CLI: cli, CLAUDE_PID: dead.stdout },
  );
  assert.equal(r.status, 0);
  assert.ok(
    r.calls.some((c) => c[1] === 'ensure'),
    'got as far as waiting',
  );
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
}, 30_000);

test('on a Node.js that is too old, a hook answers without loading the proxy', () => {
  const old =
    'data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"20.1.0"}})';
  const answer = (host: string, event: string) =>
    spawnSync(process.execPath, ['--import', old, HOOK, host, event], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, PIXLING_CLI: '/nonexistent' },
    });
  assert.equal(answer('claude-code', 'stop').stdout, '{}');
  assert.equal(answer('antigravity', 'before-tool').stdout, '{"decision":"ask"}');
  assert.equal(answer('antigravity', 'before-tool').status, 0);
});

// Pixling started after the session did.
test('a prompt after Pixling came up connects: binds, starts the receiver and says so', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-late-'));
  const r = run(
    'claude-code',
    'prompt',
    { session_id: sid },
    { 'inbox watch': { exit: 0, result: { messages: [] } } },
    { XDG_CACHE_HOME: cache },
  );
  assert.ok(r.calls.some((c) => c[1] === 'ensure'));
  assert.match(r.json.hookSpecificOutput.additionalContext, /A Pixling resident is bound/);
  const hubLock = path.join(cache, 'pixling-proxy', '.desk', 'receiver-hub.lock');
  const entry = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries', `${entryId('claude-code', sid)}.json`);
  assert.ok(fs.existsSync(entry), 'the session is registered in the receiver hub');
  assert.ok(fs.existsSync(hubLock), 'the shared receiver hub holds its lock');
  process.kill(Number(fs.readFileSync(hubLock, 'utf8').split(' ')[0]), 'SIGTERM');
});

test('with Pixling still away, a prompt says nothing', () => {
  const r = run('claude-code', 'prompt', { session_id: sid }, {}, { PIXLING_CLI: '/nonexistent/pixling' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
});

test("session-end stops the session's receiver and frees its lock", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-end-'));
  const env = { XDG_CACHE_HOME: cache };
  run('claude-code', 'session-start', { session_id: sid }, { 'resident ensure': ENSURED }, env);
  const entry = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries', `${entryId('claude-code', sid)}.json`);
  const hubLock = path.join(cache, 'pixling-proxy', '.desk', 'receiver-hub.lock');
  assert.ok(fs.existsSync(entry));
  assert.ok(fs.existsSync(hubLock));
  const r = run('claude-code', 'session-end', { session_id: sid, reason: 'exit' }, {}, env);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  assert.equal(fs.existsSync(entry), false);
});

// A daemon that took its session for gone (host unknown, quiet for hours) ended.
test("a turn's end starts the session's receiver again when it is not running", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-again-'));
  const env = { XDG_CACHE_HOME: cache };
  run('claude-code', 'session-start', { session_id: sid }, { 'resident ensure': ENSURED }, env);
  const entry = path.join(cache, 'pixling-proxy', '.receiver-hub', 'entries', `${entryId('claude-code', sid)}.json`);
  const hubLock = path.join(cache, 'pixling-proxy', '.desk', 'receiver-hub.lock');
  assert.ok(fs.existsSync(entry));
  const first = Number(fs.readFileSync(hubLock, 'utf8').split(' ')[0]);
  run('claude-code', 'session-end', { session_id: sid, reason: 'other' }, {}, env);
  assert.equal(fs.existsSync(entry), false);
  // Stop the hub so we verify stop restarts it too.
  try {
    process.kill(first, 'SIGTERM');
  } catch {
    // Already exited.
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && fs.existsSync(hubLock)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  run('claude-code', 'stop', { session_id: sid, last_assistant_message: 'Done.' }, {}, env);
  assert.ok(fs.existsSync(entry), 'the session is registered again');
  assert.ok(fs.existsSync(hubLock), 'the receiver hub holds its lock again');
  const again = Number(fs.readFileSync(hubLock, 'utf8').split(' ')[0]);
  assert.notEqual(again, first);
  // A running hub is reused.
  run('claude-code', 'stop', { session_id: sid, last_assistant_message: 'Done.' }, {}, env);
  assert.equal(Number(fs.readFileSync(hubLock, 'utf8').split(' ')[0]), again);
  process.kill(again, 'SIGTERM');
});

test('a resident state this proxy does not know is not taken for on the desk', () => {
  const r = run(
    'claude-code',
    'session-start',
    { session_id: sid },
    { 'resident ensure': { exit: 0, result: { state: 'somethingNew' } } },
  );
  assert.deepEqual(r.json, {});
});

test('claude-code: wait stays zero-poll during inbox wait and wakes when a message arrives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-claude-wait-'));
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(
    cli,
    `#!/bin/sh\ncase "$*" in *"inbox wait"*) sleep 0.25;; esac\nexec ${JSON.stringify(FAKE)} "$@"\n`,
    { mode: 0o755 },
  );
  const r = run(
    'claude-code',
    'wait',
    { session_id: sid },
    {
      'resident ensure': [ENSURED, { exit: 5, error: { code: 'unavailable', detail: 'restarting' } }],
      'inbox wait': { exit: 0, result: { messages: [{ messageID: 'm-wake', sequence: 1, kind: 'message' }] } },
      'inbox watch': { exit: 0, result: { messages: [{ messageID: 'm-wake', sequence: 1, kind: 'message' }] } },
      'inbox read': { exit: 0, result: { kind: 'message', sequence: 1, text: 'after restart' } },
    },
    {
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      PIXLING_CLI: cli,
      PIXLING_PROXY_DESK_CHECK_MS: '50',
      CLAUDE_PID: String(process.pid),
    },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /after restart/);
  assert.equal(r.calls.filter((c) => c[0] === 'resident' && c[1] === 'ensure').length, 1);
}, 15_000);

test('codex: stop hold exits mid-wait when the resident disconnects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-codex-hold-disc-'));
  const cli = path.join(dir, 'pixling');
  fs.writeFileSync(
    cli,
    `#!/bin/sh\ncase "$*" in *"inbox wait"*) exec sleep 300;; esac\nexec ${JSON.stringify(FAKE)} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    PIXLING_CLI: cli,
    PIXLING_PROXY_TURN_END_WAIT_MS: '60000',
    PIXLING_PROXY_DESK_CHECK_MS: '100',
  };
  const base = { session_id: sid, last_assistant_message: 'Done.' };
  run('codex', 'session-start', base, { 'resident ensure': ENSURED }, env);
  const started = Date.now();
  const r = run('codex', 'stop', base, { 'resident ensure': [ENSURED, { exit: 0, result: { state: 'stowed' } }] }, env);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
}, 15_000);

test('codex: subagent hooks never bind a resident or start a forwarder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-codex-sub-hook-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache') };
  const rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(
    rollout,
    JSON.stringify({ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { depth: 1 } } } } }) + '\n',
  );
  for (const event of ['session-start', 'prompt', 'before-tool', 'stop']) {
    const r = run(
      'codex',
      event,
      { session_id: 'codex-sub-1', transcript_path: rollout, last_assistant_message: 'Sub done.' },
      { 'resident ensure': ENSURED },
      env,
    );
    assert.equal(r.status, 0);
    assert.deepEqual(r.json, {});
    assert.deepEqual(r.calls, []);
  }
});

test('codex: stop hold skips waiting when the resident is disconnected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-codex-stop-disc-'));
  const env = { XDG_CACHE_HOME: path.join(dir, 'cache'), PIXLING_PROXY_TURN_END_WAIT_MS: '60000' };
  const base = { session_id: sid, last_assistant_message: 'Done.' };
  run('codex', 'session-start', base, { 'resident ensure': ENSURED }, env);
  const unavailable = { exit: 5, error: { code: 'unavailable', detail: 'Pixling is not running' } };
  const r = run('codex', 'stop', base, { 'message send': unavailable, 'resident ensure': unavailable }, env);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, {});
  assert.equal(
    r.calls.some((c) => c[0] === 'inbox' && c[1] === 'wait'),
    false,
  );
});
