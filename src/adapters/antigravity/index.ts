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
  terminationReason: Text,
  executionNum: Schema.optional(Schema.NullOr(Schema.Number)),
  toolCall: Schema.optional(Schema.NullOr(Schema.Struct({ name: Text, args: Schema.optional(Schema.Unknown) }))),
});

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

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const lastNonEmptyLine = (text: string): string | null => {
  const trimmed = text.trimEnd();
  if (!trimmed) return null;
  const nl = trimmed.lastIndexOf('\n');
  return nl < 0 ? trimmed : trimmed.slice(nl + 1);
};

// Reads the last transcript entry. Returns the reply when the model ended its step
// without tool calls, or null while tool calls are still in flight (or unreadable).
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
