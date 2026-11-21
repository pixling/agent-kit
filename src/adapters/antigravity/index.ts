// The anti-corruption layer towards Antigravity CLI (agy): camelCase payloads, one
// transcript line per step, and text handed over as injected steps.
import { Effect, Layer, Schema } from 'effect';
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
});
const decodeLine = Schema.decodeUnknownOption(Line);

const PRINT_RUN = /^\S*agy(\s.*)?\s(-p|--print|--prompt)(\s|=|$)/;

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
    // A decision is required, and no answer denies the call: `ask` is agy's usual
    // check (it runs at once when the user already allowed it, or never needs asking).
    passTool: { stdout: { decision: 'ask' } },
    // agy has no permission hook.
    permission: () => NOTHING,
  }),
);
