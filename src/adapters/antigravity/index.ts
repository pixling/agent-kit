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
import path from 'node:path';
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

const StepIndexHead = Schema.Struct({
  step_index: Schema.Number,
});
const decodeStepIndexHead = Schema.decodeUnknownOption(StepIndexHead);

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
const BTW_COMMAND = /^\/btw(?:\s|$)/i;
// Under the 3600 s PostInvocation hook timeout in plugins/pixling-proxy/hooks.json,
// leaving room for budget overhead so the hook exits cleanly before agy kills it.
export const MAX_HOLD_MS = 59 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 16 * 1024;
// Upper bound for line-0 fallback reads so a huge or malformed transcript never stalls a hook.
const MAX_HEAD_BYTES = 256 * 1024;
// Fallback poll only when fs.watch cannot attach (e.g. EMFILE).
const WATCH_FALLBACK_MS = 2000;

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

// Reads up to `limit` bytes from a regular file. Never throws and skips non-regular
// paths (directories, FIFOs, sockets) so hook checks cannot hang on unexpected paths.
const readFilePrefix = (file: string, limit: number): { readonly text: string; readonly full: boolean } | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return null;
    const toRead = Math.min(limit, stat.size);
    const buf = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), full: bytesRead >= stat.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
};

const readFirstTranscriptRow = (transcriptPath: string | null | undefined): unknown => {
  if (!transcriptPath) return null;
  const initial = readFilePrefix(transcriptPath, HEAD_BYTES);
  if (!initial) return null;
  const firstLine = firstNonEmptyLine(initial.text);
  let row = firstLine ? parseJson(firstLine) : null;
  if (row === null && !initial.full && !initial.text.includes('\n')) {
    const larger = readFilePrefix(transcriptPath, MAX_HEAD_BYTES);
    const line = larger ? firstNonEmptyLine(larger.text) : null;
    row = line ? parseJson(line) : null;
  }
  return row;
};

const isBtwCommand = (lastUserInput: string | null | undefined): boolean =>
  typeof lastUserInput === 'string' && BTW_COMMAND.test(lastUserInput.trim());

const isSubagentRow = (lastUserInput: string | null | undefined, row: unknown): boolean => {
  if (lastUserInput && lastUserInput.trim()) return false;
  const step = decodeStepHead(row);
  if (step._tag === 'Some') {
    return step.value.type === 'SYSTEM_MESSAGE' && step.value.source === 'SYSTEM';
  }
  return lastUserInput === '';
};

const isSideQuestionRow = (lastUserInput: string | null | undefined, row: unknown): boolean => {
  if (isBtwCommand(lastUserInput)) return true;
  const indexed = decodeStepIndexHead(row);
  return indexed._tag === 'Some' && Number.isFinite(indexed.value.step_index) && indexed.value.step_index > 0;
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
  return isSubagentRow(lastUserInput, readFirstTranscriptRow(transcriptPath));
};

// Antigravity `/btw` side questions fork the conversation into an ephemeral session
// without a dedicated hook flag. Unlike main sessions (whose transcript starts at
// `step_index: 0`), a `/btw` fork's transcript starts at the parent's step index (> 0).
// Every read and schema decode fails closed to `false` so format changes never throw or hang.
export const isSideQuestionSession = (
  lastUserInput: string | null | undefined,
  transcriptPath: string | null | undefined,
): boolean => {
  if (isBtwCommand(lastUserInput)) return true;
  return isSideQuestionRow(lastUserInput, readFirstTranscriptRow(transcriptPath));
};

export const isIgnoredSession = (
  lastUserInput: string | null | undefined,
  transcriptPath: string | null | undefined,
): boolean => {
  if (isBtwCommand(lastUserInput)) return true;
  const row = readFirstTranscriptRow(transcriptPath);
  return isSideQuestionRow(lastUserInput, row) || isSubagentRow(lastUserInput, row);
};

// Antigravity writes every reactive wake-up (background task completions, subagent
// replies, scheduled timers, and queued terminal prompts) into
// `<session>/.system_generated/messages/undelivered/` beside `logs/transcript.jsonl`.
export const undeliveredDirOf = (transcriptPath: string | null | undefined): string | null => {
  if (!transcriptPath) return null;
  const logsDir = path.dirname(transcriptPath);
  if (path.basename(logsDir) !== 'logs') return null;
  return path.join(path.dirname(logsDir), 'messages', 'undelivered');
};

const dirId = (dir: string): string | null => {
  try {
    const s = fs.statSync(dir);
    return s.isDirectory() ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
};

export const hasUndeliveredMessages = (dir: string): boolean => {
  try {
    return fs.readdirSync(dir).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
};

// Completes as soon as Antigravity queues an undelivered message for this session
// (immediately if one is already waiting). Watches the deepest existing ancestor when
// `messages/undelivered` has not been created yet, re-attaching if a directory is
// replaced (inode change) and keeping idle CPU at zero.
export const watchUndelivered = (transcriptPath: string | null | undefined): Effect.Effect<void> => {
  const undeliveredDir = undeliveredDirOf(transcriptPath);
  if (!undeliveredDir) return Effect.never;
  const messagesDir = path.dirname(undeliveredDir);
  const systemDir = path.dirname(messagesDir);
  const hadSystemDir = dirId(systemDir) !== null;
  return Effect.callback<void>((resume) => {
    let done = false;
    let watcher: fs.FSWatcher | null = null;
    let watchedPath: string | null = null;
    let watchedId: string | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    const closeWatcher = () => {
      watcher?.close();
      watcher = null;
      watchedPath = null;
      watchedId = null;
    };

    const closeAll = () => {
      closeWatcher();
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const finish = () => {
      if (done) return;
      done = true;
      closeAll();
      resume(Effect.void);
    };

    const sessionRemoved = () => hadSystemDir && dirId(systemDir) === null;

    const startFallback = () => {
      if (fallbackTimer || done) return;
      fallbackTimer = setInterval(() => {
        if (hasUndeliveredMessages(undeliveredDir) || sessionRemoved()) finish();
      }, WATCH_FALLBACK_MS);
    };

    const deepestExisting = (): { readonly dir: string; readonly id: string } | null => {
      for (const dir of [undeliveredDir, messagesDir, systemDir]) {
        const id = dirId(dir);
        if (id) return { dir, id };
      }
      return null;
    };

    const rearm = () => {
      if (done) return;
      if (hasUndeliveredMessages(undeliveredDir) || sessionRemoved()) {
        finish();
        return;
      }
      const next = deepestExisting();
      if (!next) {
        closeWatcher();
        startFallback();
        return;
      }
      if (next.dir !== watchedPath || next.id !== watchedId) {
        closeWatcher();
        try {
          const attachedDir = next.dir;
          const attachedId = next.id;
          watcher = fs.watch(attachedDir, () => rearm());
          watcher.on('error', () => {
            closeWatcher();
            if (sessionRemoved()) finish();
            else if (dirId(attachedDir) === attachedId) startFallback();
            else rearm();
          });
          watchedPath = attachedDir;
          watchedId = attachedId;
        } catch {
          startFallback();
          return;
        }
      }
      // Close the race window between attaching the watcher and files/directories changing.
      if (hasUndeliveredMessages(undeliveredDir) || sessionRemoved()) {
        finish();
        return;
      }
      const after = deepestExisting();
      if (after && (after.dir !== watchedPath || after.id !== watchedId)) {
        rearm();
      }
    };

    rearm();
    return Effect.sync(() => {
      done = true;
      closeAll();
    });
  });
};

// Reads the last transcript entry. Returns the reply when the model ended its step
// without tool calls, or null while tool calls are still in flight.
export const readStepEndedReply = (file: string | null | undefined): { readonly text: string | null } | null => {
  if (!file) return null;
  let tail: string;
  let truncated = false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return null;
    const end = stat.size;
    truncated = end > TAIL_BYTES;
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, end));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, end - buf.length);
    tail = buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
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
          inSubagent: isIgnoredSession(p.lastUserInput, p.transcriptPath),
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
    waitInterrupted: (input) => watchUndelivered(input.transcriptPath),
    // A decision is required, and no answer denies the call: `ask` is agy's usual
    // check (it runs at once when the user already allowed it, or never needs asking).
    passTool: { stdout: { decision: 'ask' } },
    // agy has no permission hook.
    permission: () => NOTHING,
  }),
);
