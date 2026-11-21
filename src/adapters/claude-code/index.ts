// The anti-corruption layer towards Claude Code: its field names, transcript format
// and output format stop here.
import { Effect, Layer, Schema } from 'effect';
import type { Activity } from '../../core/Activity.ts';
import type { PermissionAnswer } from '../../core/Conversation.ts';
import { HookHost, NOTHING } from '../../runtimes/hook/HookHost.ts';
import { findHostPid } from '../../runtimes/process.ts';

const Text = Schema.optional(Schema.NullOr(Schema.String));

const Payload = Schema.Struct({
  session_id: Schema.NonEmptyString,
  source: Text,
  reason: Text,
  last_assistant_message: Text,
  transcript_path: Text,
  stop_hook_active: Schema.optional(Schema.NullOr(Schema.Boolean)),
  tool_name: Text,
  tool_input: Schema.optional(Schema.Unknown),
  tool_use_id: Text,
  // Set when the hook fires inside a subagent.
  agent_id: Text,
});

// One content block per line.
const Line = Schema.Struct({
  type: Schema.Literal('assistant'),
  isSidechain: Schema.optional(Schema.Boolean),
  message: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
        thinking: Schema.optional(Schema.String),
      }),
    ),
  }),
});
const decodeLine = Schema.decodeUnknownOption(Line);

const context = (hookEventName: string, additionalContext: string) => ({
  stdout: { hookSpecificOutput: { hookEventName, additionalContext } },
});

const decision = (answer: PermissionAnswer) =>
  answer.decision === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'deny', ...(answer.message ? { message: answer.message } : {}) };

export const ClaudeCode = Layer.succeed(HookHost)(
  HookHost.of({
    id: 'claude-code',
    author: 'Claude Code',
    // Claude Code names its own pid.
    pid: Effect.sync(() => Number(process.env.CLAUDE_PID) || findHostPid()),
    unattended: Effect.sync(
      () =>
        (process.env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') ||
        process.env.CLAUDE_CODE_SESSION_ATTENDED === '0',
    ),
    waitsForHooks: false,
    payload: (raw) =>
      Schema.decodeUnknownEffect(Payload)(raw).pipe(
        Effect.map((p) => ({
          sessionId: p.session_id,
          source: p.source,
          reason: p.reason,
          finalText: p.last_assistant_message,
          transcriptPath: p.transcript_path,
          toolName: p.tool_name,
          toolInput: p.tool_input,
          toolUseId: p.tool_use_id,
          inSubagent: !!p.agent_id,
          turnContinued: p.stop_hook_active,
        })),
      ),
    activitiesOf: (row) => {
      const line = decodeLine(row);
      if (line._tag === 'None' || line.value.isSidechain) return [];
      return line.value.message.content.flatMap((block): Activity[] => {
        if (block.type === 'text' && block.text) return [{ kind: 'text', text: block.text }];
        // Claude Code never keeps the reasoning itself: an update or a summary of it, or
        // nothing (the `thinkingDisplay` of the line, set by `showThinkingSummaries`).
        if (block.type === 'thinking' && block.thinking) {
          return [{ kind: 'reasoning', form: 'summary', text: block.thinking }];
        }
        return [];
      });
    },
    tell: (kind, text) => context(kind === 'session-start' ? 'SessionStart' : 'UserPromptSubmit', text),
    resume: (reason) => ({ stdout: { decision: 'block', reason } }),
    passTool: NOTHING,
    permission: (answer) => ({
      stdout: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision(answer) } },
    }),
    toolsThatAskTheUser: ['AskUserQuestion', 'ExitPlanMode'],
    // asyncRewake: a hook that exits 2 wakes the session with its stderr.
    wakesFromWait: (wake) => ({ stdout: {}, wake }),
  }),
);
