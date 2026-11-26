// The anti-corruption layer towards Codex: its field names, session file format and
// output format stop here.
import fs from 'node:fs';
import { Effect, Layer, Predicate, Schema } from 'effect';
import type { Activity } from '../../core/Activity.ts';
import type { PermissionAnswer } from '../../core/Conversation.ts';
import { readSettings } from '../../core/config.ts';
import { Daemons, type Daemon } from '../../runtimes/Daemons.ts';
import { FORWARDER_HUB_DIR, FORWARDER_HUB_LOCK } from '../../runtimes/ReceiverHub.ts';
import { HookHost, NOTHING } from '../../runtimes/hook/HookHost.ts';
import { commandLine, findHostPid } from '../../runtimes/process.ts';

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
  agent_id: Text,
});

const SessionMeta = Schema.Struct({
  type: Schema.Literal('session_meta'),
  payload: Schema.Struct({
    source: Schema.optional(Schema.Unknown),
  }),
});
const decodeSessionMeta = Schema.decodeUnknownOption(SessionMeta);

const CHUNK_BYTES = 64 * 1024;
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

const readFirstLine = (filePath: string): string => {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunks: Buffer[] = [];
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      let total = 0;
      while (total < MAX_FIRST_LINE_BYTES) {
        const toRead = Math.min(CHUNK_BYTES, MAX_FIRST_LINE_BYTES - total);
        const n = fs.readSync(fd, buf, 0, toRead, total);
        if (n <= 0) break;
        const nl = buf.subarray(0, n).indexOf(0x0a);
        if (nl >= 0) {
          chunks.push(Buffer.from(buf.subarray(0, nl)));
          break;
        }
        chunks.push(Buffer.from(buf.subarray(0, n)));
        total += n;
      }
      return Buffer.concat(chunks).toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
};

// Codex identifies subagent hooks via `agent_id` in the payload and marks subagent
// rollouts with `session_meta.payload.source: { subagent: ... }` (or `"subagent"`).
export const isCodexSubagent = (
  agentId: string | null | undefined,
  transcriptPath: string | null | undefined,
): boolean => {
  if (agentId && agentId.trim()) return true;
  if (!transcriptPath) return false;
  const firstLine = readFirstLine(transcriptPath);
  if (!firstLine) return false;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return false;
  }
  const meta = decodeSessionMeta(parsed);
  if (meta._tag === 'None') return false;
  const source = meta.value.payload.source;
  return source === 'subagent' || (Predicate.isObject(source) && 'subagent' in source);
};

const Parts = Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }));

// One response item per line.
const Line = Schema.Struct({
  type: Schema.Literal('response_item'),
  payload: Schema.Union([
    Schema.Struct({ type: Schema.Literal('message'), role: Schema.Literal('assistant'), content: Parts }),
    Schema.Struct({ type: Schema.Literal('reasoning'), summary: Schema.optional(Schema.NullOr(Parts)) }),
  ]),
});
const decodeLine = Schema.decodeUnknownOption(Line);

// Codex's options that take the next word as their value.
const OPTION_WITH_VALUE =
  /^(-c|--config|-m|--model|-p|--profile|-C|--cd|-a|--ask-for-approval|-s|--sandbox|-i|--image|--add-dir|--enable|--disable|--local-provider|--remote|--remote-auth-token-env)$/;

// `codex [options] exec ...`: a one-shot run, whatever options come first.
export const isExecRun = (commandLine: string): boolean => {
  const [program, ...words] = commandLine.trim().split(/\s+/);
  if (!/(^|\/)codex$/.test(program ?? '')) return false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (OPTION_WITH_VALUE.test(word)) i++;
    else if (!word.startsWith('-')) return word === 'exec' || word === 'e';
  }
  return false;
};

// Hands the user's messages to `codex queue`, which starts a turn in an idle session.
export const FORWARDER: Daemon = {
  lock: 'forwarder',
  script: 'codex-forwarder.mjs',
  hub: { dir: FORWARDER_HUB_DIR, lock: FORWARDER_HUB_LOCK },
};

const queueEnabled = () => {
  const env = process.env.PIXLING_PROXY_CODEX_QUEUE;
  return env ? env !== '0' : readSettings().codexQueue !== false;
};

const decision = (answer: PermissionAnswer) =>
  answer.decision === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'deny', ...(answer.message ? { message: answer.message } : {}) };

export const Codex = Layer.succeed(HookHost)(
  HookHost.of({
    id: 'codex',
    author: 'Codex',
    pid: Effect.sync(findHostPid),
    unattended: Effect.sync(() => isExecRun(commandLine(findHostPid()))),
    waitsForHooks: true,
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
          inSubagent: isCodexSubagent(p.agent_id, p.transcript_path),
          // Not passed on: this id is not the one in the session file, and Codex has
          // written the call's line before the hook starts, so nothing needs waiting for.
          turnContinued: p.stop_hook_active,
        })),
      ),
    activitiesOf: (row) => {
      const line = decodeLine(row);
      if (line._tag === 'None') return [];
      const { payload } = line.value;
      // The reasoning itself is encrypted; a summary is there when
      // `model_reasoning_summary` asks for one, and not always then.
      if (payload.type === 'reasoning') {
        return (payload.summary ?? []).flatMap((part): Activity[] =>
          part.text ? [{ kind: 'reasoning', form: 'summary', text: part.text }] : [],
        );
      }
      return payload.content.flatMap((part): Activity[] =>
        part.type === 'output_text' && part.text ? [{ kind: 'text', text: part.text }] : [],
      );
    },
    tell: (kind, additionalContext) => ({
      stdout: {
        hookSpecificOutput: {
          hookEventName: kind === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
          additionalContext,
        },
      },
    }),
    resume: (reason) => ({ stdout: { decision: 'block', reason } }),
    passTool: NOTHING,
    permission: (answer) => ({
      stdout: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision(answer) } },
    }),
    onSessionStart: Effect.fn('codex.onSessionStart')(function* ({ sessionId, hostPid }) {
      if (!queueEnabled()) return;
      const daemons = yield* Daemons;
      yield* daemons.start(FORWARDER, { hostPid, extra: [sessionId] });
    }),
    onSessionEnd: Daemons.use((daemons) => daemons.stop(FORWARDER)),
  }),
);
