// Each host's payloads, transcript lines and outputs, which stop at its adapter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Effect, type Layer, Option } from 'effect';
import {
  Antigravity,
  hasUndeliveredMessages,
  isSubagentSession,
  MAX_HOLD_MS,
  readStepEndedReply,
  resolveHoldMs,
  undeliveredDirOf,
  watchUndelivered,
} from '../src/adapters/antigravity/index.ts';
import { DEFAULTS } from '../src/core/config.ts';
import { ClaudeCode } from '../src/adapters/claude-code/index.ts';
import { Codex, isCodexSubagent, isExecRun } from '../src/adapters/codex/index.ts';
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
        assert.deepStrictEqual(host.continueStep?.('go on').stdout, {
          terminationBehavior: 'force_continue',
          injectSteps: [{ userMessage: 'go on' }],
        });
      }),
    ),
  );

  it.effect('detects a tool-free final reply at step end, and ignores tool steps', () =>
    Effect.sync(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-agy-step-'));
      const file = path.join(dir, 'transcript_full.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Done.' }) + '\n');
      assert.deepStrictEqual(readStepEndedReply(file), { text: 'Done.' });

      fs.writeFileSync(
        file,
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          content: 'Running...',
          tool_calls: [{ name: 'run_command' }],
        }) + '\n',
      );
      assert.strictEqual(readStepEndedReply(file), null);

      fs.appendFileSync(file, JSON.stringify({ type: 'GENERIC', source: 'MODEL', content: 'ok' }) + '\n');
      assert.strictEqual(readStepEndedReply(file), null);
      assert.strictEqual(readStepEndedReply(null), null);
    }),
  );

  it.effect('identifies subagent conversations from payload and transcript head', () =>
    Effect.sync(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-agy-sub-'));
      const subTranscript = path.join(dir, 'sub.jsonl');
      fs.writeFileSync(
        subTranscript,
        JSON.stringify({ type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '[Message] sender=parent-1 content=hi' }) +
          '\n',
      );
      const userTranscript = path.join(dir, 'user.jsonl');
      fs.writeFileSync(
        userTranscript,
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'hi' }) + '\n',
      );

      assert.isTrue(isSubagentSession('', subTranscript));
      assert.isTrue(isSubagentSession('', null));
      assert.isFalse(isSubagentSession('hello', subTranscript));
      assert.isFalse(isSubagentSession('', userTranscript));
      assert.isFalse(isSubagentSession(undefined, null));
    }),
  );

  it.live(
    'resolves undelivered directory and wakes when messages arrive (including dir creation and replacement)',
    () =>
      Effect.gen(function* () {
        const sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-agy-undelivered-'));
        const logsDir = path.join(sysDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const transcript = path.join(logsDir, 'transcript.jsonl');
        fs.writeFileSync(transcript, '');

        const undelivered = undeliveredDirOf(transcript);
        assert.strictEqual(undelivered, path.join(sysDir, 'messages', 'undelivered'));
        assert.strictEqual(undeliveredDirOf(path.join(sysDir, 'transcript.jsonl')), null);
        assert.strictEqual(undeliveredDirOf(null), null);
        assert.isFalse(hasUndeliveredMessages(undelivered!));

        // Watch starting before `messages/` exists; creating `messages/undelivered/<id>` wakes it.
        const createTimer = setTimeout(() => {
          fs.mkdirSync(undelivered!, { recursive: true });
          fs.writeFileSync(path.join(undelivered!, '.DS_Store'), '');
          fs.writeFileSync(path.join(undelivered!, 'msg-1'), '');
        }, 40);
        try {
          const woke = yield* watchUndelivered(transcript).pipe(Effect.timeoutOption('2 seconds'));
          assert.isTrue(Option.isSome(woke));
        } finally {
          clearTimeout(createTimer);
        }
        assert.isTrue(hasUndeliveredMessages(undelivered!));

        // Hidden dotfiles alone do not count as undelivered messages.
        fs.rmSync(path.join(undelivered!, 'msg-1'));
        assert.isFalse(hasUndeliveredMessages(undelivered!));

        // Replacing `messages/undelivered/` (new inode) still wakes when a file arrives later.
        const replaceTimer = setTimeout(() => {
          fs.rmSync(undelivered!, { recursive: true, force: true });
          fs.mkdirSync(undelivered!, { recursive: true });
          setTimeout(() => fs.writeFileSync(path.join(undelivered!, 'msg-replaced'), ''), 40);
        }, 40);
        try {
          const wokeReplaced = yield* watchUndelivered(transcript).pipe(Effect.timeoutOption('2 seconds'));
          assert.isTrue(Option.isSome(wokeReplaced));
        } finally {
          clearTimeout(replaceTimer);
        }

        // Already-queued message resolves immediately.
        const started = Date.now();
        yield* watchUndelivered(transcript);
        assert.isBelow(Date.now() - started, 500);
      }),
  );

  it.effect('defaults to MAX_HOLD_MS unless turnEndWaitMs is set explicitly', () =>
    Effect.sync(() => {
      const prevEnv = process.env.PIXLING_PROXY_TURN_END_WAIT_MS;
      const prevXdg = process.env.XDG_CONFIG_HOME;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-agy-cfg-'));
      try {
        delete process.env.PIXLING_PROXY_TURN_END_WAIT_MS;
        process.env.XDG_CONFIG_HOME = dir;
        const base = { ...DEFAULTS, language: 'en' as const };
        assert.strictEqual(resolveHoldMs(base), MAX_HOLD_MS);

        process.env.PIXLING_PROXY_TURN_END_WAIT_MS = '0';
        assert.strictEqual(resolveHoldMs({ ...base, turnEndWaitMs: 0 }), 0);

        process.env.PIXLING_PROXY_TURN_END_WAIT_MS = '99999999';
        assert.strictEqual(resolveHoldMs({ ...base, turnEndWaitMs: 99_999_999 }), MAX_HOLD_MS);
      } finally {
        if (prevEnv === undefined) delete process.env.PIXLING_PROXY_TURN_END_WAIT_MS;
        else process.env.PIXLING_PROXY_TURN_END_WAIT_MS = prevEnv;
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
      }
    }),
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

describe('isCodexSubagent', () => {
  it('identifies subagents from agent_id and session_meta.payload.source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-codex-sub-'));
    const subRollout = path.join(dir, 'sub.jsonl');
    fs.writeFileSync(
      subRollout,
      JSON.stringify({
        type: 'session_meta',
        payload: { source: { subagent: { thread_spawn: { parent_thread_id: 'p1', depth: 1 } } } },
      }) + '\n',
    );
    const cliRollout = path.join(dir, 'cli.jsonl');
    fs.writeFileSync(cliRollout, JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } }) + '\n');
    const largeSubRollout = path.join(dir, 'large-sub.jsonl');
    fs.writeFileSync(
      largeSubRollout,
      JSON.stringify({
        type: 'session_meta',
        payload: { base_instructions: 'x'.repeat(80 * 1024), source: { subagent: { thread_spawn: { depth: 1 } } } },
      }) +
        '\n' +
        JSON.stringify({ type: 'response_item', payload: {} }) +
        '\n',
    );

    assert.isTrue(isCodexSubagent('agent-1', cliRollout));
    assert.isTrue(isCodexSubagent(undefined, subRollout));
    assert.isTrue(isCodexSubagent(undefined, largeSubRollout));
    assert.isFalse(isCodexSubagent(undefined, cliRollout));
    assert.isFalse(isCodexSubagent('', null));
  });
});
