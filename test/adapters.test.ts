// Each host's payloads, transcript lines and outputs, which stop at its adapter.
import { assert, describe, it } from '@effect/vitest';
import { Effect, type Layer } from 'effect';
import { Antigravity } from '../src/adapters/antigravity/index.ts';
import { ClaudeCode } from '../src/adapters/claude-code/index.ts';
import { Codex, isExecRun } from '../src/adapters/codex/index.ts';
import { HookHost } from '../src/runtimes/hook/HookHost.ts';

const withHost = (layer: Layer.Layer<HookHost>, check: (host: HookHost['Service']) => Effect.Effect<void, unknown>) =>
  Effect.flatMap(HookHost, check).pipe(Effect.provide(layer));

const refuses = (host: HookHost['Service'], payloads: ReadonlyArray<unknown>) =>
  Effect.forEach(payloads, (payload) =>
    Effect.exit(host.payload(payload)).pipe(Effect.map((exit) => assert.strictEqual(exit._tag, 'Failure'))),
  ).pipe(Effect.asVoid);

describe('Claude Code', () => {
  it.effect('reads a payload in the proxy words, ignoring what it does not use', () =>
    withHost(ClaudeCode, (host) =>
      Effect.gen(function* () {
        const input = yield* host.payload({
          session_id: 's',
          last_assistant_message: 'hi',
          transcript_path: '/t.jsonl',
          stop_hook_active: true,
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_use_id: 'u',
          agent_id: 'a',
          unknown_field: 1,
        });
        assert.strictEqual(input.sessionId, 's');
        assert.strictEqual(input.finalText, 'hi');
        assert.strictEqual(input.transcriptPath, '/t.jsonl');
        assert.strictEqual(input.turnContinued, true);
        assert.strictEqual(input.toolName, 'Bash');
        assert.deepStrictEqual(input.toolInput, { command: 'ls' });
        assert.strictEqual(input.toolUseId, 'u');
        assert.isTrue(input.inSubagent);
      }),
    ),
  );

  it.effect('refuses a payload without a session', () =>
    withHost(ClaudeCode, (host) => refuses(host, [{}, { session_id: '' }, { sessionId: 's' }, null])),
  );

  it.effect('reads main-thread text from its transcript', () =>
    withHost(ClaudeCode, (host) =>
      Effect.sync(() => {
        const row = (extra: object) => ({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi' }] },
          ...extra,
        });
        assert.deepStrictEqual(host.activitiesOf(row({})), [{ kind: 'text', text: 'hi' }]);
        assert.deepStrictEqual(host.activitiesOf(row({ isSidechain: true })), []);
        assert.deepStrictEqual(host.activitiesOf({ type: 'user', message: { content: [] } }), []);
        assert.deepStrictEqual(host.activitiesOf(null), []);
        const thinking = (text: string) => ({
          type: 'assistant',
          message: { content: [{ type: 'thinking', thinking: text, signature: 's' }] },
        });
        assert.deepStrictEqual(host.activitiesOf(thinking('why')), [
          { kind: 'reasoning', form: 'summary', text: 'why' },
        ]);
        // Most thinking blocks keep only a signature.
        assert.deepStrictEqual(host.activitiesOf(thinking('')), []);
      }),
    ),
  );

  it.effect('writes in its own format, and wakes with stderr', () =>
    withHost(ClaudeCode, (host) =>
      Effect.sync(() => {
        assert.deepStrictEqual(host.tell('user', 'hello').stdout, {
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hello' },
        });
        assert.deepStrictEqual(host.permission({ decision: 'deny', message: 'no' }).stdout, {
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } },
        });
        assert.strictEqual(host.wakesFromWait?.('hello').wake, 'hello');
      }),
    ),
  );
});

describe('Codex', () => {
  it.effect('reads its session file, and has no wait hook', () =>
    withHost(Codex, (host) =>
      Effect.sync(() => {
        const row = (role: string) => ({
          type: 'response_item',
          payload: { type: 'message', role, content: [{ type: 'output_text', text: 'hi' }] },
        });
        assert.deepStrictEqual(host.activitiesOf(row('assistant')), [{ kind: 'text', text: 'hi' }]);
        assert.deepStrictEqual(host.activitiesOf(row('user')), []);
        assert.deepStrictEqual(host.activitiesOf({ type: 'event_msg', payload: { type: 'agent_message' } }), []);
        const reasoning = (summary: unknown) => ({
          type: 'response_item',
          payload: { type: 'reasoning', summary, encrypted_content: 'x' },
        });
        assert.deepStrictEqual(host.activitiesOf(reasoning([{ type: 'summary_text', text: 'why' }])), [
          { kind: 'reasoning', form: 'summary', text: 'why' },
        ]);
        assert.deepStrictEqual(host.activitiesOf(reasoning([])), []);
        assert.isUndefined(host.wakesFromWait);
        assert.isTrue(host.waitsForHooks);
      }),
    ),
  );

  it.effect('continues a turn by blocking its end', () =>
    withHost(Codex, (host) =>
      Effect.sync(() => {
        assert.deepStrictEqual(host.resume('go on').stdout, { decision: 'block', reason: 'go on' });
      }),
    ),
  );
});

describe('Antigravity', () => {
  it.effect('reads its camelCase payload', () =>
    withHost(Antigravity, (host) =>
      Effect.gen(function* () {
        const input = yield* host.payload({
          conversationId: 'c',
          transcriptPath: '/t.jsonl',
          terminationReason: 'NO_TOOL_CALL',
          executionNum: 1,
          toolCall: { name: 'run_command', args: { CommandLine: 'ls' } },
        });
        assert.strictEqual(input.sessionId, 'c');
        assert.strictEqual(input.reason, 'NO_TOOL_CALL');
        assert.strictEqual(input.toolName, 'run_command');
        assert.isTrue(input.turnContinued);
      }),
    ),
  );

  it.effect('reads only the model steps of its transcript', () =>
    withHost(Antigravity, (host) =>
      Effect.sync(() => {
        const row = { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'hi' };
        assert.deepStrictEqual(host.activitiesOf(row), [{ kind: 'text', text: 'hi' }]);
        assert.deepStrictEqual(host.activitiesOf({ ...row, source: 'USER_EXPLICIT' }), []);
        assert.deepStrictEqual(host.activitiesOf({ ...row, thinking: 'why' }), [
          { kind: 'reasoning', form: 'full', text: 'why' },
          { kind: 'text', text: 'hi' },
        ]);
      }),
    ),
  );

  it.effect('never leaves a tool call without a decision, and injects steps', () =>
    withHost(Antigravity, (host) =>
      Effect.sync(() => {
        assert.deepStrictEqual(host.passTool.stdout, { decision: 'ask' });
        assert.deepStrictEqual(host.tell('user', 'hello').stdout, { injectSteps: [{ userMessage: 'hello' }] });
      }),
    ),
  );
});

describe('isExecRun', () => {
  it.each([
    ['codex exec fix it', true],
    ['/usr/local/bin/codex e fix it', true],
    ['codex -m gpt exec fix', true],
    ['codex -C /some/dir exec fix', true],
    ['codex -a never exec fix', true],
    ['codex --sandbox read-only --json exec fix', true],
    ['codex', false],
    ['codex --model exec', false],
    ['codex resume', false],
    ['codex fix the exec bug', false],
    ['node exec.js', false],
    ['', false],
  ])('%s: %s', (line, expected) => {
    assert.strictEqual(isExecRun(line), expected);
  });
});
