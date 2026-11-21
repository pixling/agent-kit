// The anti-corruption layer towards Pixling: the only module that knows the CLI's
// commands, flags and JSON. Everything past it speaks in Desk's types.
import { NodeServices } from '@effect/platform-node';
import { Context, type Duration, Effect, Layer, Option, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { cliPath } from './cli.ts';

// Why a call failed. `refused`: the CLI answered with an error of its own (`code`),
// and the rest mean no such answer came back. `cause` keeps what happened underneath.
export class DeskError extends Schema.TaggedError<DeskError>()('DeskError', {
  operation: Schema.String,
  reason: Schema.Literals(['unreachable', 'timedOut', 'malformed', 'refused']),
  code: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Unknown),
  // What the CLI says about a refusal, in words: its `problem`, `reason` and `hint`.
  explanation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  // Another process bound this pair first, possibly with another resident.
  get alreadyBound(): boolean {
    return this.code === 'clientKeyConflict' || this.detail === 'clientKeyConflict';
  }

  // For the log: never a message body. A CLI that could not be started names the
  // error code and the path tried (a stale PIXLING_CLI in a long-lived host otherwise
  // shows only as "unreachable"); the cause's own words are left out, as they can
  // carry the arguments.
  get summary(): string {
    const started = this.reason === 'unreachable' ? [startFailure(this.cause), `cli=${cliPath()}`] : [];
    return [this.reason, this.code, typeof this.detail === 'string' ? this.detail : undefined, ...started]
      .filter(Boolean)
      .join(' ');
  }
}

// The system's code for a CLI that could not be started (ENOENT, EACCES), from the
// spawner's PlatformError.
const startFailure = (cause: unknown): string | undefined => {
  const reason = (cause as { reason?: { _tag?: unknown; cause?: { code?: unknown } } } | undefined)?.reason;
  const code = reason?.cause?.code ?? reason?._tag;
  return typeof code === 'string' && /^[A-Za-z]+$/.test(code) ? code : undefined;
};

export interface Pair {
  readonly namespace: string;
  readonly key: string;
}

const maybe = <S extends Schema.Constraint>(schema: S) => Schema.optional(Schema.NullOr(schema));

// A state this proxy does not know fails to decode, rather than pass for "on the desk".
const Ensured = Schema.Struct({ state: Schema.Literals(['onDesk', 'stowed', 'unavailable']) });

// `appearing`: the binding exists, but the resident cannot be listed yet.
export type ResidentState = 'onDesk' | 'stowed' | 'appearing';

// One page of the zukan. Only `resident` entries can be bound (`object` ones cannot).
const ZukanPage = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ id: Schema.String, kind: maybe(Schema.String) })),
  nextOffset: maybe(Schema.Number),
});
const ZUKAN_PAGE = 500;
const ZUKAN_MAX_PAGES = 20;

// What the resident does when a message arrives (its speak hook, as it takes effect):
// nothing, a built-in action (poke, settle, pass), one of its animations, or a sequence
// saved for its asset.
const SpeakHook = Schema.Union([
  Schema.Literal('none'),
  Schema.Struct({ builtin: Schema.String }),
  Schema.Struct({ motion: Schema.String }),
  Schema.Struct({ sequence: Schema.String }),
]);
export type SpeakHook = typeof SpeakHook.Type;
// A desk without hooks, or a hook this proxy does not know, pokes: the desk's default.
export const DEFAULT_SPEAK: SpeakHook = { builtin: 'poke' };
const decodeSpeak = Schema.decodeUnknownOption(SpeakHook);

const Described = Schema.Struct({
  resident: maybe(
    Schema.Struct({
      visibility: maybe(Schema.String),
      conversation: maybe(
        Schema.Struct({ questionsPending: maybe(Schema.Number), questionPresented: maybe(Schema.Boolean) }),
      ),
    }),
  ),
  // `effective` is decoded on its own, so a kind this proxy does not know keeps the clips.
  settings: maybe(
    Schema.Struct({
      hooks: maybe(Schema.Struct({ speak: maybe(Schema.Struct({ effective: maybe(Schema.Unknown) })) })),
    }),
  ),
  options: maybe(Schema.Struct({ statuses: maybe(Schema.Array(Schema.Struct({ name: Schema.String }))) })),
  sequence: maybe(
    Schema.Struct({
      animations: maybe(
        Schema.Array(Schema.Struct({ id: Schema.String, name: maybe(Schema.String), motion: maybe(Schema.String) })),
      ),
    }),
  ),
});

// One of the resident's clips: its id, and what its maker called it and wrote about it.
export interface Clip {
  readonly id: string;
  readonly name: string;
  readonly motion: string;
}

// What a reaction can borrow from the resident, and what stands in its way right now.
export interface Traits {
  // What it does when a message arrives (its speak hook).
  readonly speak: SpeakHook;
  // Its clips; the first is its usual motion.
  readonly clips: ReadonlyArray<Clip>;
  // False when no window shows it now (another desktop, hidden, off the screen). A
  // desk that does not say counts as in view.
  readonly inView: boolean;
  // A question waits on it for an answer: it takes no run until then.
  readonly questionOpen: boolean;
  // The state names its asset has a look for (`status define`).
  readonly statuses: ReadonlyArray<string>;
}
// `visibility` of a resident some window shows now.
const VISIBLE = 'visible';
const SavedList = Schema.Struct({ sequences: maybe(Schema.Array(Schema.Struct({ name: Schema.String }))) });

const Sent = Schema.Struct({
  receipts: maybe(Schema.Array(Schema.Struct({ outcome: maybe(Schema.String) }))),
});

const QuestionFields = {
  promptID: maybe(Schema.String),
  state: maybe(Schema.String),
  selectedChoiceID: maybe(Schema.String),
  enteredText: maybe(Schema.String),
};
const QuestionState = Schema.Struct(QuestionFields);
export type Question = typeof QuestionState.Type;

// `question ask` answers with the question itself or wrapped; `question result` wrapped.
const QuestionDoc = Schema.Struct({ ...QuestionFields, question: maybe(QuestionState) });

const Notice = Schema.Struct({ messageID: Schema.String, sequence: Schema.Number, kind: Schema.String });
export type Notice = typeof Notice.Type;
const Unread = Schema.Struct({ messages: maybe(Schema.Array(Notice)) });

const InboxEntry = Schema.Struct({
  sequence: maybe(Schema.Number),
  kind: Schema.String,
  text: maybe(Schema.String),
  answer: maybe(
    Schema.Struct({
      promptID: maybe(Schema.String),
      outcome: Schema.Literals(['answered', 'cancelled']),
      selectedChoiceID: maybe(Schema.String),
      selectedChoiceIDs: maybe(Schema.Array(Schema.String)),
      enteredText: maybe(Schema.String),
    }),
  ),
});
export type InboxEntry = typeof InboxEntry.Type;

// How one hold of the inbox ended.
//   closed:   the user put the resident away
//   invalid:  this proxy called the CLI wrongly, so trying again cannot help
//   notBound: the pair is not bound (yet)
//   retry:    anything else, such as Pixling restarting
export type HoldEnd = 'closed' | 'invalid' | 'notBound' | 'retry';

const HOLD_ENDS: Record<number, HoldEnd> = { 0: 'closed', 64: 'invalid', 5: 'notBound' };

// The desk no longer knows a question: its answer was handed over already, to a call
// or (when no call was waiting) to the resident's inbox, under the promptID.
export const GONE = 'gone' as const;
export type QuestionGone = typeof GONE;

const envelope = <S extends Schema.Constraint>(result: S) =>
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Boolean,
      result: Schema.optional(result),
      error: maybe(
        Schema.Struct({
          code: Schema.String,
          detail: Schema.optional(Schema.Unknown),
          // Words for a person, read only when they are text: a refusal must never fail
          // to decode over them, or its `code` would be lost.
          hint: Schema.optional(Schema.Unknown),
          problem: Schema.optional(Schema.Unknown),
          reason: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  );

// `--name=value`: a separate argument starting with `-` (a reply that is a bullet
// list) reads as another flag, and the CLI refuses the whole call.
const flag = (name: string, value: string | number) => `--${name}=${value}`;

const CALL_TIMEOUT: Duration.Input = '15 seconds';
// A CLI that ignores being asked to stop must not hold its caller, and so the host.
const FORCE_KILL_AFTER: Duration.Input = '1 second';
// The CLI ends a wait itself; this only catches one that never comes back.
const WAIT_MARGIN_MS = 10_000;

export class Desk extends Context.Service<
  Desk,
  {
    // `initial`: settings for a resident this call creates (an existing one keeps its own).
    ensure(
      pair: Pair,
      resident?: { assetID: string; name: string; initial?: Record<string, unknown> | undefined },
    ): Effect.Effect<ResidentState, DeskError>;
    // The ids of every resident in the zukan, in zukan order.
    residents(): Effect.Effect<ReadonlyArray<string>, DeskError>;
    // How each receipt went, for the log, and whether the resident was off the desk.
    send(message: {
      readonly to: string;
      readonly author: string;
      readonly text: string;
      // A retry with the same id and text is not shown twice.
      readonly requestID?: string | undefined;
      // The resident does not move for it.
      readonly still?: boolean | undefined;
    }): Effect.Effect<{ readonly outcomes: ReadonlyArray<string>; readonly offDesk: boolean }, DeskError>;
    // Starts a run of sequence steps on one resident (the CLI's JSON plan), without
    // waiting for it to end. The resident goes back to where it was afterwards.
    // `name`: a sequence saved for the resident's asset, instead of steps.
    sequence(
      run: { readonly to: string } & ({ readonly steps: ReadonlyArray<unknown> } | { readonly name: string }),
    ): Effect.Effect<void, DeskError>;
    // The names of the sequences saved for the resident's asset.
    savedSequences(to: string): Effect.Effect<ReadonlyArray<string>, DeskError>;
    traits(to: string): Effect.Effect<Traits, DeskError>;
    // Pops a short text or emoji over the resident's head, `count` copies at once.
    emote(pop: {
      readonly to: string;
      readonly text: string;
      readonly count?: number | undefined;
    }): Effect.Effect<void, DeskError>;
    // Gives the session's own resident a temporary state by name, or takes it away. A
    // name its asset has no look for is accepted and shows nothing.
    status(
      state: { readonly to: string } & ({ readonly name: string } | { readonly clear: true }),
    ): Effect.Effect<void, DeskError>;
    // Shows a question without waiting for its answer.
    ask(question: {
      readonly to: string;
      readonly author: string;
      readonly question: string;
      readonly detail: string;
      readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
      readonly freeText: { readonly id: string; readonly label: string };
      // The resident's state while the card waits, by name.
      readonly status?: string | undefined;
    }): Effect.Effect<Question, DeskError>;
    // Waits up to `waitMs` and returns the question as it stands then.
    questionResult(promptID: string, waitMs: number): Effect.Effect<Question | QuestionGone, DeskError>;
    // Withdraws a question, and returns it as it stood: it may be answered by now.
    cancelQuestion(promptID: string): Effect.Effect<Question | QuestionGone, DeskError>;
    // What is unread, without reading it: reading marks it read.
    unread(pair: Pair): Effect.Effect<ReadonlyArray<Notice>, DeskError>;
    read(pair: Pair, messageID: string): Effect.Effect<InboxEntry, DeskError>;
    // Blocks until something past `since` arrives or `timeoutMs` passes; true when it arrived.
    wait(
      pair: Pair,
      options: { readonly since: number; readonly timeoutMs: number },
    ): Effect.Effect<boolean, DeskError>;
    // Holds the inbox open so the user can type to the resident, until this ends.
    hold(pair: Pair): Effect.Effect<HoldEnd, DeskError>;
  }
>()('pixling-proxy/pixling/Desk') {
  static readonly layer = Layer.effect(
    Desk,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      // One invocation, one JSON document on the last line of stdout. A refusal
      // exits non-zero with its document, so the exit code is not what decides.
      // The CLI is looked up each time: a long-lived host may outlive an install.
      const call = <S extends Schema.Decoder<unknown>>(
        operation: string,
        args: ReadonlyArray<string>,
        result: S,
        timeout: Duration.Input = CALL_TIMEOUT,
      ) =>
        Effect.suspend(() =>
          spawner.string(ChildProcess.make(cliPath(), ['--json', ...args], { forceKillAfter: FORCE_KILL_AFTER })),
        ).pipe(
          Effect.mapError((cause) => new DeskError({ operation, reason: 'unreachable', cause })),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new DeskError({ operation, reason: 'timedOut' })),
          }),
          Effect.map((stdout) => stdout.trim().split('\n').at(-1) ?? ''),
          Effect.flatMap((line) =>
            Schema.decodeUnknownEffect(envelope(result))(line).pipe(
              Effect.mapError((cause) => new DeskError({ operation, reason: 'malformed', cause })),
            ),
          ),
          Effect.flatMap((doc) =>
            doc.ok && doc.result !== undefined
              ? Effect.succeed(doc.result)
              : Effect.fail(
                  new DeskError({
                    operation,
                    reason: 'refused',
                    code: doc.error?.code,
                    detail: doc.error?.detail,
                    explanation:
                      [doc.error?.problem, doc.error?.reason, doc.error?.hint]
                        .filter((words) => typeof words === 'string' && words)
                        .join('; ') || undefined,
                  }),
                ),
          ),
        );

      const inbox = ({ namespace, key }: Pair) => [flag('namespace', namespace), flag('key', key)];

      return Desk.of({
        ensure: (pair, resident) =>
          call(
            'resident.ensure',
            [
              'resident',
              'ensure',
              ...inbox(pair),
              ...(resident ? [flag('asset-id', resident.assetID), flag('name', resident.name)] : []),
              ...(resident?.initial ? [flag('initial', JSON.stringify({ settings: resident.initial }))] : []),
            ],
            Ensured,
          ).pipe(Effect.map(({ state }) => (state === 'unavailable' ? 'appearing' : state))),
        residents: () =>
          Effect.gen(function* () {
            const ids: string[] = [];
            let offset: number | null | undefined = 0;
            for (let page = 0; page < ZUKAN_MAX_PAGES && offset != null; page++) {
              const doc: typeof ZukanPage.Type = yield* call(
                'zukan.list',
                ['zukan', flag('limit', ZUKAN_PAGE), flag('offset', offset)],
                ZukanPage,
              );
              for (const entry of doc.entries) if ((entry.kind ?? 'resident') === 'resident') ids.push(entry.id);
              offset = doc.entries.length ? doc.nextOffset : null;
            }
            return ids;
          }),
        send: ({ to, author, text, requestID, still }) =>
          call(
            'message.send',
            [
              'message',
              'send',
              flag('to', to),
              flag('author', author),
              flag('text', text),
              ...(requestID ? [flag('request-id', requestID)] : []),
              ...(still ? [flag('action', 'none')] : []),
            ],
            Sent,
          ).pipe(
            Effect.map((sent) => {
              const outcomes = (sent.receipts ?? []).flatMap((receipt) => receipt.outcome ?? []);
              return { outcomes, offDesk: outcomes.includes('notOnDesk') };
            }),
          ),
        sequence: (run) =>
          call(
            'sequence.start',
            [
              'sequence',
              'start',
              flag('to', run.to),
              'steps' in run ? flag('steps', JSON.stringify(run.steps)) : flag('name', run.name),
            ],
            Schema.Unknown,
          ).pipe(Effect.asVoid),
        savedSequences: (to) =>
          call('sequence.list', ['sequence', 'list', flag('to', to)], SavedList).pipe(
            Effect.map(({ sequences }) => (sequences ?? []).map(({ name }) => name)),
          ),
        traits: (to) =>
          call('resident.describe', ['resident', 'describe', flag('to', to)], Described).pipe(
            Effect.map(({ resident, settings, options, sequence }) => ({
              speak: Option.getOrElse(decodeSpeak(settings?.hooks?.speak?.effective), () => DEFAULT_SPEAK),
              clips: (sequence?.animations ?? []).map(({ id, name, motion }) => ({
                id,
                name: name ?? '',
                motion: motion ?? '',
              })),
              inView: (resident?.visibility ?? VISIBLE) === VISIBLE,
              questionOpen:
                (resident?.conversation?.questionsPending ?? 0) > 0 || !!resident?.conversation?.questionPresented,
              statuses: (options?.statuses ?? []).map(({ name }) => name),
            })),
          ),
        emote: ({ to, text, count }) =>
          call(
            'resident.emote',
            ['resident', 'emote', flag('to', to), flag('text', text), ...(count ? [flag('count', count)] : [])],
            Schema.Unknown,
          ).pipe(Effect.asVoid),
        status: (state) =>
          call(
            'resident.status',
            ['resident', 'status', flag('to', state.to), 'name' in state ? flag('name', state.name) : '--clear'],
            Schema.Unknown,
          ).pipe(Effect.asVoid),
        ask: ({ to, author, question, detail, choices, freeText, status }) =>
          call(
            'question.ask',
            [
              'question',
              'ask',
              flag('to', to),
              flag('author', author),
              flag('question', question),
              flag('detail', detail),
              ...choices.map(({ id, label }) => flag('choice', `${id}=${label}`)),
              flag('free-text-label', freeText.label),
              flag('free-text-id', freeText.id),
              ...(status ? [flag('status', status)] : []),
              flag('wait-ms', 0),
            ],
            QuestionDoc,
          ).pipe(Effect.map((doc) => doc.question ?? doc)),
        questionResult: (promptID, waitMs) =>
          call(
            'question.result',
            ['question', 'result', promptID, flag('wait-ms', waitMs)],
            QuestionDoc,
            waitMs + WAIT_MARGIN_MS,
          ).pipe(Effect.map((doc) => doc.question ?? GONE)),
        cancelQuestion: (promptID) =>
          call('question.cancel', ['question', 'cancel', promptID], QuestionDoc).pipe(
            Effect.map((doc) => doc.question ?? GONE),
            // Already answered, or withdrawn elsewhere.
            Effect.catchIf(
              (error) => error.reason === 'refused',
              () => Effect.succeed(GONE),
            ),
          ),
        unread: (pair) =>
          call('inbox.watch', ['inbox', 'watch', ...inbox(pair), flag('wait-ms', 0)], Unread).pipe(
            Effect.map((unread) => unread.messages ?? []),
          ),
        read: (pair, messageID) => call('inbox.read', ['inbox', 'read', ...inbox(pair), messageID], InboxEntry),
        wait: (pair, { since, timeoutMs }) =>
          call(
            'inbox.wait',
            ['inbox', 'wait', ...inbox(pair), flag('since', since), flag('timeout-ms', timeoutMs)],
            Unread,
            timeoutMs + WAIT_MARGIN_MS,
          ).pipe(Effect.map((unread) => (unread.messages ?? []).length > 0)),
        hold: (pair) =>
          spawner
            .exitCode(
              ChildProcess.make(cliPath(), ['--json', 'inbox', 'receive', ...inbox(pair)], {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                forceKillAfter: FORCE_KILL_AFTER,
              }),
            )
            .pipe(
              Effect.map((code) => HOLD_ENDS[Number(code)] ?? 'retry'),
              Effect.mapError((cause) => new DeskError({ operation: 'inbox.receive', reason: 'unreachable', cause })),
            ),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}
