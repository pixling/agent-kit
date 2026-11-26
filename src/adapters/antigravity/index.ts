// The anti-corruption layer towards Antigravity CLI (agy): camelCase payloads, one
// transcript line per step, and text handed over as injected steps.
//
// Antigravity CLI currently has no public API to wake an idle TUI session from a
// plugin (no Claude Code `asyncRewake`, no Codex `codex queue`, and Sidecars / MCP
// Apps are Antigravity App only). Until Antigravity CLI adds a native turn-start or
// async wake-up API, we keep the execution open in `PostInvocation` after a
// tool-free reply (`holdAtStepEnd`) and inject the user's message with
// `terminationBehavior: "force_continue"` + `injectSteps: [{ userMessage }]`.
// Unlike `Stop` (`decision: "continue"`), which caps at 10 continuations and injects
// a system message, `PostInvocation` injects a real `USER_INPUT` step without that
// 10-continuation cap. Once Antigravity CLI supports native turn-start / async
// wake-up, replace `holdAtStepEnd` / `stepEndedReply` / `continueStep` with it.
import fs from 'node:fs';
import { Effect, Layer, Schema } from 'effect';
import { type Config, readSettings } from '../../core/config.ts';
import { HookHost, NOTHING } from '../../runtimes/hook/HookHost.ts';
import { commandLine, findHostPid } from '../../runtimes/process.ts';

const Text = Schema.optional(Schema.NullOr(Schema.String));

const Payload = Schema.Struct({
  conversationId: Schema.NonEmptyString,
  transcriptPath: Text,
  lastUserInput: Text,
  terminationReason: Text,
  executionNum: Schema.optional(Schema.NullOr(Schema.Number)),
  toolCall: Schema.optional(Schema.NullOr(Schema.Struct({ name: Text, args: Schema.optional(Schema.Unknown) }))),
});

const StepHead = Schema.Struct({
  type: Schema.String,
  source: Text,
});
const decodeStepHead = Schema.decodeUnknownOption(StepHead);

const TranscriptStep = Schema.Struct({
  type: Schema.String,
  source: Text,
  content: Text,
  tool_calls: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Text,
          args: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  ),
});
const decodeTranscriptStep = Schema.decodeUnknownOption(TranscriptStep);

const KillArgs = Schema.Struct({
  Action: Text,
  ConversationIds: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const decodeKillArgs = Schema.decodeUnknownOption(KillArgs);

// The model's reasoning, and its text before its tool calls, or its reply.
const Line = Schema.Struct({
  type: Schema.Literal('PLANNER_RESPONSE'),
  source: Schema.Literal('MODEL'),
  thinking: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const decodeLine = Schema.decodeUnknownOption(Line);

const PRINT_RUN = /^\S*agy(\s.*)?\s(-p|--print|--prompt)(\s|=|$)/;
// Under the 3600 s PostInvocation hook timeout in plugins/pixling-proxy/hooks.json,
// leaving room for budget overhead so the hook exits cleanly before agy kills it.
export const MAX_HOLD_MS = 59 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 16 * 1024;
const SUBAGENT_CREATED = /Created the following subagent:\s*\{[\s\S]*?"conversationId"\s*:\s*"([^"]+)"/g;
const MESSAGE_SENDER = /\[Message\][^\n]*\bsender=([^\s]+)/g;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const firstNonEmptyLine = (text: string): string | null => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
};

const lastNonEmptyLine = (text: string): string | null => {
  const trimmed = text.trimEnd();
  if (!trimmed) return null;
  const nl = trimmed.lastIndexOf('\n');
  return nl < 0 ? trimmed : trimmed.slice(nl + 1);
};

// Antigravity runs hooks inside subagent conversations too, without a dedicated flag.
// Unlike user conversations (which start with `USER_INPUT` and carry a non-empty
// `lastUserInput`), subagent conversations start with a `SYSTEM_MESSAGE` from their
// parent and always pass `lastUserInput: ""`.
export const isSubagentSession = (
  lastUserInput: string | null | undefined,
  transcriptPath: string | null | undefined,
): boolean => {
  if (lastUserInput && lastUserInput.trim()) return false;
  if (transcriptPath) {
    let head: string | null = null;
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const end = fs.fstatSync(fd).size;
        if (end > 0) {
          const buf = Buffer.alloc(Math.min(HEAD_BYTES, end));
          fs.readSync(fd, buf, 0, buf.length, 0);
          head = buf.toString('utf8');
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      head = null;
    }
    if (head) {
      const firstLine = firstNonEmptyLine(head);
      let row = firstLine ? parseJson(firstLine) : null;
      if (row === null && !head.includes('\n')) {
        try {
          row = parseJson(firstNonEmptyLine(fs.readFileSync(transcriptPath, 'utf8')) ?? '');
        } catch {
          row = null;
        }
      }
      const step = decodeStepHead(row);
      if (step._tag === 'Some') {
        return step.value.type === 'SYSTEM_MESSAGE' && step.value.source === 'SYSTEM';
      }
    }
  }
  return lastUserInput === '';
};

// True when the parent session spawned a subagent that has neither sent a message back
// nor been killed yet, so PostInvocation must not block waiting for resident input.
export const hasPendingSubagent = (file: string): boolean => {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!content.includes('Created the following subagent:')) return false;
  const pending = new Set<string>();
  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim()) continue;
    const step = decodeTranscriptStep(parseJson(rawLine));
    if (step._tag === 'None') continue;
    const { type, content: body, tool_calls: toolCalls } = step.value;
    if (type === 'GENERIC' && body && body.includes('Created the following subagent:')) {
      for (const m of body.matchAll(SUBAGENT_CREATED)) {
        if (m[1]) pending.add(m[1]);
      }
    } else if (type === 'SYSTEM_MESSAGE' && body) {
      for (const m of body.matchAll(MESSAGE_SENDER)) {
        if (m[1]) pending.delete(m[1]);
      }
    } else if (type === 'PLANNER_RESPONSE' && toolCalls) {
      for (const tc of toolCalls) {
        if (tc.name?.trim() !== 'manage_subagents') continue;
        const args = decodeKillArgs(tc.args);
        if (args._tag === 'None') continue;
        if (args.value.Action === 'kill_all') pending.clear();
        else if (args.value.Action === 'kill') {
          for (const id of args.value.ConversationIds ?? []) pending.delete(id);
        }
      }
    }
  }
  return pending.size > 0;
};

// Reads the last transcript entry. Returns the reply when the model ended its step
// without tool calls, or null while tool calls or subagents are still in flight.
export const readStepEndedReply = (file: string | null | undefined): { readonly text: string | null } | null => {
  if (!file) return null;
  let tail: string;
  let truncated = false;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const end = fs.fstatSync(fd).size;
      if (end <= 0) return null;
      truncated = end > TAIL_BYTES;
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, end));
      fs.readSync(fd, buf, 0, buf.length, end - buf.length);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  let row = parseJson(lastNonEmptyLine(tail) ?? '');
  if (row === null && truncated) {
    try {
      row = parseJson(lastNonEmptyLine(fs.readFileSync(file, 'utf8')) ?? '');
    } catch {
      return null;
    }
  }
  const line = decodeLine(row);
  if (line._tag === 'None') return null;
  if (line.value.tool_calls && line.value.tool_calls.length > 0) return null;
  if (hasPendingSubagent(file)) return null;
  return { text: line.value.content ?? null };
};

// Defaults to holding the turn open (up to MAX_HOLD_MS) unless the user explicitly
// sets `turnEndWaitMs` (e.g. `0` to disable holding and leave the TUI idle).
export const resolveHoldMs = (config: Config): number => {
  const envSet = !!process.env.PIXLING_PROXY_TURN_END_WAIT_MS;
  const fileSet = Object.hasOwn(readSettings(), 'turnEndWaitMs');
  const raw = envSet || fileSet ? config.turnEndWaitMs : MAX_HOLD_MS;
  return Math.max(0, Math.min(raw, MAX_HOLD_MS));
};

export const Antigravity = Layer.succeed(HookHost)(
  HookHost.of({
    id: 'antigravity',
    author: 'Antigravity',
    pid: Effect.sync(findHostPid),
    unattended: Effect.sync(() => PRINT_RUN.test(commandLine(findHostPid()))),
    waitsForHooks: true,
    // PreInvocation.
    promptEachStep: true,
    payload: (raw) =>
      Schema.decodeUnknownEffect(Payload)(raw).pipe(
        Effect.map((p) => ({
          sessionId: p.conversationId,
          transcriptPath: p.transcriptPath,
          reason: p.terminationReason,
          // The name has come with a stray leading space.
          toolName: p.toolCall?.name?.trim(),
          toolInput: p.toolCall?.args,
          inSubagent: isSubagentSession(p.lastUserInput, p.transcriptPath),
          // A Stop hook that already continued the turn once.
          turnContinued: (p.executionNum ?? 0) > 0,
        })),
      ),
    activitiesOf: (row) => {
      const line = decodeLine(row);
      if (line._tag === 'None') return [];
      const { thinking, content } = line.value;
      return [
        ...(thinking ? [{ kind: 'reasoning', form: 'full', text: thinking } as const] : []),
        ...(content ? [{ kind: 'text', text: content } as const] : []),
      ];
    },
    tell: (kind, text) => ({
      stdout: {
        injectSteps: [kind === 'user' ? { userMessage: text } : { systemMessage: { systemMessage: text } }],
      },
    }),
    resume: (reason) => ({ stdout: { decision: 'continue', reason } }),
    holdAtStepEnd: resolveHoldMs,
    stepEndedReply: readStepEndedReply,
    continueStep: (text) => ({
      stdout: {
        terminationBehavior: 'force_continue',
        injectSteps: [{ userMessage: text }],
      },
    }),
    // A decision is required, and no answer denies the call: `ask` is agy's usual
    // check (it runs at once when the user already allowed it, or never needs asking).
    passTool: { stdout: { decision: 'ask' } },
    // agy has no permission hook.
    permission: () => NOTHING,
  }),
);
