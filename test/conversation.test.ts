// The conversation in no host's terms: every service it needs is a test layer.
import { assert, describe, it } from '@effect/vitest';
import { Deferred, type Duration, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import {
  askPermission,
  ensureResident,
  observed,
  relay,
  showPending,
  takeUserMessages,
  noticeTurn,
  turnEnded,
} from '../src/core/Conversation.ts';
import {
  ActivitySource,
  CurrentSession,
  Expression,
  ProxyConfig,
  Receiver,
  SessionStore,
} from '../src/core/services.ts';
import type { Activity, ShowPolicy } from '../src/core/Activity.ts';
import type { Relayed } from '../src/core/text.ts';
import { DEFAULTS } from '../src/core/config.ts';
import { Desk, DeskError, GONE, type InboxEntry, type Question, type ResidentState } from '../src/pixling/Desk.ts';

interface Scenario {
  readonly show?: Partial<ShowPolicy>;
  readonly waiting?: ReadonlyArray<Activity>;
  // `show` is never handed anything: another process has the turn.
  readonly busy?: boolean;
  // Sends fail once this many have got through, for `recoverAfter` tries.
  readonly failAfter?: number;
  readonly recoverAfter?: number;
  readonly outcomes?: ReadonlyArray<string>;
  readonly entries?: Record<string, InboxEntry | 'unreadable' | 'hanging'>;
  readonly unavailable?: boolean;
  readonly ensure?: ReadonlyArray<ResidentState | 'refused'>;
  // `gone`: the desk has no such question left.
  readonly questions?: ReadonlyArray<Question | 'gone'>;
  readonly onCancel?: Question;
  readonly permissionWaitMs?: number;
  readonly askTakes?: Duration.Input;
  readonly waits?: ReadonlyArray<string>;
  // An extension that moves the resident for the reply itself.
  readonly expressive?: boolean;
  // The session's resident was bound before.
  readonly bound?: boolean;
}

const unreachable = (operation: string) => Effect.fail(new DeskError({ operation, reason: 'unreachable' }));
const refused = (operation: string, code: string) => Effect.fail(new DeskError({ operation, reason: 'refused', code }));

const harness = ({
  show = { text: false },
  waiting = [],
  busy = false,
  failAfter = Infinity,
  recoverAfter = Infinity,
  outcomes = ['spoke'],
  entries = {},
  unavailable = false,
  ensure: ensureScript = [],
  questions = [],
  onCancel,
  permissionWaitMs = DEFAULTS.permissionWaitMs,
  askTakes = 0,
  waits = [],
  expressive = false,
  bound = false,
}: Scenario) => {
  const ensure = [...ensureScript];
  const question = [...questions];
  const inbox = [...waits];
  const seen = {
    asked: 0,
    polled: 0,
    ensured: [] as string[],
    initial: [] as unknown[],
    askedWith: [] as unknown[],
    cancelled: [] as string[],
    sent: [] as string[],
    requestIDs: [] as (string | undefined)[],
    still: [] as (boolean | undefined)[],
    waiting: [...waiting],
    replied: [] as string[],
    shown: { at: 0 } as { at: number; said?: string | undefined },
    unclaimed: [] as string[],
    read: [] as string[],
    stowed: false,
    since: 2,
    receiverStopped: false,
    reactedTo: [] as string[],
    noticed: [] as string[],
  };
  const claimed = new Set<string>();
  let failures = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(ProxyConfig)(
      ProxyConfig.of({
        ...DEFAULTS,
        asset: ['No.1'],
        language: 'en',
        show: { ...DEFAULTS.show, ...show },
        permissionWaitMs,
      }),
    ),
    Layer.succeed(CurrentSession)(
      CurrentSession.of({ namespace: 'test', key: 'k', author: 'Test', selector: 'client:test/k' }),
    ),
    Layer.succeed(SessionStore)(
      SessionStore.of({
        isBound: Effect.succeed(bound),
        markBound: Effect.void,
        isStowed: Effect.sync(() => seen.stowed),
        markStowed: Effect.sync(() => void (seen.stowed = true)),
        since: Effect.sync(() => seen.since),
        setSince: (since) => Effect.sync(() => void (seen.since = since)),
        claim: (id) => Effect.sync(() => !claimed.has(id) && !!claimed.add(id)),
        unclaim: (id) =>
          Effect.sync(() => {
            claimed.delete(id);
            seen.unclaimed.push(id);
          }),
        shown: Effect.sync(() => seen.shown),
        setShown: (shown) => Effect.sync(() => void (seen.shown = shown)),
        memo: () => Effect.succeed(undefined),
        setMemo: () => Effect.void,
      }),
    ),
    Layer.succeed(ActivitySource)(
      ActivitySource.of({
        observe: (activity) => Effect.sync(() => void seen.waiting.push(activity)),
        drain: (showBatch) =>
          Effect.gen(function* () {
            if (busy || !seen.waiting.length) return;
            const items = [...seen.waiting];
            if (yield* showBatch({ items, position: 'p' })) seen.waiting = seen.waiting.slice(items.length);
          }),
        replied: (text) => Effect.sync(() => void seen.replied.push(text)),
      }),
    ),
    Layer.succeed(Receiver)(Receiver.of({ stop: Effect.sync(() => void (seen.receiverStopped = true)) })),
    expressive
      ? Layer.succeed(Expression)({
          movesForReply: true,
          replied: (reply) => Effect.sync(() => void seen.reactedTo.push(reply)),
          noticesTools: true,
          noticed: (moment) =>
            Effect.sync(() => void seen.noticed.push(moment.kind === 'tool' ? moment.name : moment.kind)),
          initialSettings: { motionEnabled: true },
          askingStatus: Effect.succeed('asking'),
        })
      : Layer.empty,
    Layer.succeed(Desk)(
      Desk.of({
        ensure: (_, resident) =>
          ensure.length
            ? Effect.suspend(() => {
                const next = ensure.shift()!;
                seen.ensured.push(resident?.assetID ?? 'lookup');
                if (resident) seen.initial.push(resident.initial);
                return next === 'refused' ? refused('ensure', 'rejected') : Effect.succeed(next);
              })
            : unreachable('ensure'),
        residents: () => unreachable('zukan'),
        sequence: () => unreachable('sequence'),
        savedSequences: () => unreachable('sequence list'),
        traits: () => unreachable('describe'),
        emote: () => unreachable('emote'),
        status: () => unreachable('status'),
        ask: ({ status }) =>
          Effect.sleep(askTakes).pipe(
            Effect.andThen(
              Effect.sync(() => {
                seen.asked += 1;
                seen.askedWith.push(status);
                const next = question.shift();
                return next && next !== 'gone' ? next : {};
              }),
            ),
          ),
        questionResult: () =>
          Effect.suspend((): Effect.Effect<Question | typeof GONE> => {
            seen.polled += 1;
            const next = question.shift();
            if (next === 'gone') return Effect.succeed(GONE);
            return next ? Effect.succeed(next) : Effect.never;
          }),
        cancelQuestion: (id) =>
          Effect.sync(() => {
            seen.cancelled.push(id);
            return onCancel ?? GONE;
          }),
        wait: () => (inbox.length ? Effect.succeed(true) : Effect.never),
        hold: () => Effect.succeed('closed' as const),
        send: ({ text, requestID, still }) =>
          unavailable || (seen.sent.length >= failAfter && failures++ < recoverAfter)
            ? unreachable('send')
            : Effect.sync(() => {
                seen.sent.push(text);
                seen.requestIDs.push(requestID);
                seen.still.push(still);
                return { outcomes, offDesk: outcomes.includes('notOnDesk') };
              }),
        unread: () =>
          unavailable
            ? unreachable('unread')
            : Effect.succeed(
                Object.entries(entries).map(([messageID, entry]) => ({
                  messageID,
                  sequence: (typeof entry === 'object' && entry.sequence) || 0,
                  kind: typeof entry === 'object' ? entry.kind : 'message',
                })),
              ),
        read: (_, id) => {
          seen.read.push(id);
          const entry = entries[id];
          if (entry === 'hanging') return Effect.never;
          return entry === 'unreadable' || entry === undefined ? unreachable('read') : Effect.succeed(entry);
        },
      }),
    ),
  );
  return { seen, layer };
};

const text = (body: string): Activity => ({ kind: 'text', text: body });
const tool = (name: string): Activity => ({ kind: 'tool', name });

describe('what waits', () => {
  it.effect('shows as one bubble, with tool calls in a row as one line', () => {
    const { seen, layer } = harness({
      show: { tools: 'all' },
      waiting: [
        text('one'),
        { kind: 'reasoning', form: 'summary', text: 'why' },
        tool('Bash'),
        tool('Edit'),
        tool('Bash'),
      ],
    });
    return Effect.gen(function* () {
      yield* showPending();
      assert.deepStrictEqual(seen.sent, ['one\n\n`Bash` ×2 · `Edit`']);
      assert.deepStrictEqual(seen.waiting, []);
      assert.ok(seen.requestIDs[0]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('stays waiting when it does not get there, and retries as the same message', () => {
    const { seen, layer } = harness({ show: { text: true }, waiting: [text('one')], unavailable: true });
    return Effect.gen(function* () {
      yield* showPending();
      assert.deepStrictEqual(seen.waiting, [text('one')]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('waits for everyMs, and the turn end does not', () => {
    const { seen, layer } = harness({ show: { everyMs: 60_000, tools: 'all' } });
    return Effect.gen(function* () {
      yield* TestClock.adjust(60_000);
      yield* observed(tool('Read'));
      assert.deepStrictEqual(seen.sent, ['`Read`']);
      assert.deepStrictEqual(seen.still, [true]);
      yield* observed(tool('Bash'));
      yield* observed(text('Later.'));
      assert.deepStrictEqual(seen.sent, ['`Read`']);
      yield* TestClock.adjust(10_000);
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, ['`Read`', '`Bash`\n\nLater.', 'All done.']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a tool the settings hide does not wait', () => {
    const { seen, layer } = harness({ show: { tools: ['!Read'] } });
    return Effect.gen(function* () {
      yield* observed(tool('Read'));
      yield* observed(tool('Bash'));
      assert.deepStrictEqual(seen.sent, ['`Bash`']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('shows before a permission card, whatever the time', () => {
    const { seen, layer } = harness({
      show: { everyMs: 60_000, text: true },
      waiting: [text('About to run this.')],
      questions: [{ state: 'answered', selectedChoiceID: 'allow' }],
    });
    return Effect.gen(function* () {
      yield* TestClock.adjust(1);
      yield* askPermission({ tool: 'Bash', input: { command: 'ls' } });
      assert.deepStrictEqual(seen.sent, ['About to run this.']);
    }).pipe(Effect.provide(layer));
  });
});

describe('turnEnded', () => {
  it.effect('its own line among what waits is the reply, not a text', () => {
    const { seen, layer } = harness({ show: { text: true }, waiting: [text('Found it.'), text('All done.')] });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, ['Found it.', 'All done.']);
      assert.deepStrictEqual(seen.replied, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a reply ahead of its line is remembered, so the line does not show it again', () => {
    const { seen, layer } = harness({ show: { text: true }, waiting: [text('Found it.')] });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, ['Found it.', 'All done.']);
      assert.deepStrictEqual(seen.replied, ['All done.']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a reply already shown as a text does not show again', () => {
    const { seen, layer } = harness({ show: { text: true } });
    return Effect.gen(function* () {
      yield* observed(text('Same.'));
      yield* turnEnded('Same.');
      assert.deepStrictEqual(seen.sent, ['Same.']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a reply that does not get there leaves its line waiting, so it is not lost', () => {
    const { seen, layer } = harness({ show: { text: true }, waiting: [text('All done.')], failAfter: 0 });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.waiting, [text('All done.')]);
      assert.deepStrictEqual(seen.replied, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a flush that fails: the reply goes anyway, and its line will not repeat it', () => {
    const { seen, layer } = harness({
      show: { text: true },
      waiting: [text('Found it.'), text('All done.')],
      failAfter: 0,
      recoverAfter: 1,
    });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, ['All done.']);
      assert.deepStrictEqual(seen.replied, ['All done.']);
      assert.strictEqual(seen.waiting.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('the same reply twice with texts off is two replies', () => {
    const { seen, layer } = harness({});
    return Effect.gen(function* () {
      yield* turnEnded('Done.');
      yield* turnEnded('Done.');
      assert.deepStrictEqual(seen.sent, ['Done.', 'Done.']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('the reply does not wait for a flush that cannot get its turn', () => {
    const { seen, layer } = harness({ show: { text: true }, waiting: [text('Found it.')], busy: true });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, ['All done.']);
      assert.deepStrictEqual(seen.waiting, [text('Found it.')]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('with replies off, the reply shows neither way', () => {
    const { seen, layer } = harness({ show: { reply: false, text: true }, waiting: [text('All done.')] });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, []);
      assert.deepStrictEqual(seen.waiting, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('sends the reply itself when nothing else is wanted', () => {
    const { seen, layer } = harness({});
    return Effect.gen(function* () {
      yield* turnEnded('  done  ');
      assert.deepStrictEqual(seen.sent, ['done']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('off the desk with no window is not put away, and it keeps talking', () => {
    const { seen, layer } = harness({ outcomes: ['notOnDesk'], ensure: ['onDesk', 'onDesk'] });
    return Effect.gen(function* () {
      yield* turnEnded('first');
      yield* turnEnded('second');
      assert.isFalse(seen.stowed);
      assert.deepStrictEqual(seen.sent, ['first', 'second']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('stays quiet once the user put the resident away', () => {
    const { seen, layer } = harness({ outcomes: ['notOnDesk'], ensure: ['stowed'] });
    return Effect.gen(function* () {
      yield* turnEnded('first');
      yield* turnEnded('second');
      assert.isTrue(seen.stowed);
      assert.deepStrictEqual(seen.sent, ['first']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('carries on when the desk cannot be reached', () => {
    const { seen, layer } = harness({ unavailable: true });
    return Effect.gen(function* () {
      yield* turnEnded('hello');
      assert.isFalse(seen.stowed);
    }).pipe(Effect.provide(layer));
  });
});

describe('turnEnded, with an Expression that moves for the reply', () => {
  it.effect('sends the reply still, then hands it over once', () => {
    const { seen, layer } = harness({ expressive: true, show: { text: true }, waiting: [text('Found it.')] });
    return Effect.gen(function* () {
      yield* turnEnded('  All done.  ');
      assert.deepStrictEqual(seen.sent, ['Found it.', 'All done.']);
      assert.deepStrictEqual(seen.still, [false, true]);
      assert.deepStrictEqual(seen.reactedTo, ['All done.']);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reacts to a reply that is the turn's last line", () => {
    const { seen, layer } = harness({ expressive: true, show: { text: true }, waiting: [text('All done.')] });
    return Effect.gen(function* () {
      yield* turnEnded('All done.');
      assert.deepStrictEqual(seen.sent, ['All done.']);
      assert.deepStrictEqual(seen.still, [true]);
      assert.deepStrictEqual(seen.reactedTo, ['All done.']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('does not react to a reply that did not get there, or to none', () => {
    const { seen, layer } = harness({ expressive: true, unavailable: true });
    return Effect.gen(function* () {
      yield* turnEnded('hello');
      yield* turnEnded('   ');
      assert.deepStrictEqual(seen.reactedTo, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('does not react once the resident is put away, nor with replies off', () => {
    const off = harness({ expressive: true, show: { reply: false } });
    const stowed = harness({ expressive: true, outcomes: ['notOnDesk'], ensure: ['stowed'] });
    return Effect.gen(function* () {
      yield* turnEnded('first').pipe(Effect.provide(off.layer));
      yield* turnEnded('first').pipe(Effect.provide(stowed.layer));
      yield* turnEnded('second').pipe(Effect.provide(stowed.layer));
      assert.deepStrictEqual(off.seen.reactedTo, []);
      assert.deepStrictEqual(stowed.seen.reactedTo, []);
    }).pipe(Effect.provide(off.layer));
  });

  it.effect('without one, the reply moves the resident as any message', () => {
    const { seen, layer } = harness({});
    return Effect.gen(function* () {
      yield* turnEnded('Done.');
      assert.deepStrictEqual(seen.still, [false]);
    }).pipe(Effect.provide(layer));
  });
});

describe('moments of a turn, for the Expression', () => {
  it.live("tells the turn's start, every tool call and a permission prompt, whatever shows", () => {
    const { seen, layer } = harness({
      expressive: true,
      bound: true,
      // The prompt's moment goes beside the card, while it is being shown.
      askTakes: '20 millis',
      show: { tools: 'none' },
      questions: [{ promptID: 'p', state: 'answered', selectedChoiceID: 'allow' }],
    });
    return Effect.gen(function* () {
      yield* noticeTurn;
      yield* observed(tool('Read'));
      yield* observed(text('Looking.'));
      yield* askPermission({ tool: 'Bash', input: {} });
      yield* turnEnded(null);
      assert.deepStrictEqual(seen.noticed, ['turn', 'Read', 'permission', 'end']);
      // The card carries the state the Expression names for it.
      assert.deepStrictEqual(seen.askedWith, ['asking']);
      assert.deepStrictEqual(seen.waiting, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a resident it creates starts with the settings the Expression names, and only then', () => {
    const expressive = harness({ expressive: true, ensure: ['onDesk'] });
    const plain = harness({
      ensure: ['onDesk'],
      questions: [{ promptID: 'p', state: 'answered', selectedChoiceID: 'allow' }],
    });
    return Effect.gen(function* () {
      yield* ensureResident().pipe(Effect.provide(expressive.layer));
      yield* ensureResident().pipe(Effect.provide(plain.layer));
      yield* askPermission({ tool: 'Bash', input: {} }).pipe(Effect.provide(plain.layer));
      assert.deepStrictEqual(expressive.seen.initial, [{ motionEnabled: true }]);
      assert.deepStrictEqual(plain.seen.initial, [undefined]);
      assert.deepStrictEqual(plain.seen.askedWith, [undefined]);
    });
  });

  it.effect('tells nothing once the resident is put away, or before one is bound', () => {
    const stowed = harness({ expressive: true, bound: true });
    stowed.seen.stowed = true;
    const unbound = harness({ expressive: true });
    const moments = Effect.gen(function* () {
      yield* noticeTurn;
      yield* observed(tool('Read'));
    });
    return Effect.gen(function* () {
      yield* moments.pipe(Effect.provide(stowed.layer));
      yield* moments.pipe(Effect.provide(unbound.layer));
      assert.deepStrictEqual(stowed.seen.noticed, []);
      assert.deepStrictEqual(unbound.seen.noticed, []);
    });
  });
});

describe('takeUserMessages', () => {
  it.effect('hands over messages, points at late answers without reading them, and moves past both', () => {
    const { seen, layer } = harness({
      entries: {
        a: { kind: 'message', sequence: 3, text: 'hello' },
        b: { kind: 'answer', sequence: 5, answer: { outcome: 'answered', selectedChoiceID: 'yes' } },
      },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), ['hello', { answerTo: 'b' }]);
      assert.strictEqual(seen.since, 5);
      assert.deepStrictEqual(seen.read, ['a'], 'the answer stays unread for the agent');
    }).pipe(Effect.provide(layer));
  });

  it.effect('points at a late answer once, though it stays unread', () => {
    const { layer } = harness({
      entries: { b: { kind: 'answer', sequence: 5, answer: { outcome: 'answered', selectedChoiceID: 'yes' } } },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), [{ answerTo: 'b' }]);
      assert.deepStrictEqual(yield* takeUserMessages(), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('does not point again at an answer it moved past', () => {
    const { layer } = harness({
      entries: {
        a: { kind: 'message', sequence: 6, text: 'hello' },
        b: { kind: 'answer', sequence: 2, answer: { outcome: 'answered', selectedChoiceID: 'yes' } },
      },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), ['hello']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('hands over each entry once', () => {
    const { layer } = harness({ entries: { a: { kind: 'message', text: 'hello' } } });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), ['hello']);
      assert.deepStrictEqual(yield* takeUserMessages(), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('keeps an entry it could not read for the next call', () => {
    const { seen, layer } = harness({ entries: { a: 'unreadable' } });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), []);
      assert.deepStrictEqual(seen.unclaimed, ['a']);
    }).pipe(Effect.provide(layer));
  });

  it.live('gives back an entry when interrupted while reading it', () => {
    const { seen, layer } = harness({ entries: { a: 'hanging' } });
    return Effect.gen(function* () {
      const fiber = yield* takeUserMessages().pipe(Effect.forkChild);
      yield* Effect.sleep('20 millis');
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(seen.unclaimed, ['a']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('stops listening when the user closes the resident', () => {
    const { seen, layer } = harness({ entries: { a: { kind: 'closed' } } });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), []);
      assert.isTrue(seen.stowed);
      assert.isTrue(seen.receiverStopped);
    }).pipe(Effect.provide(layer));
  });

  it.effect('leaves the inbox alone when the desk cannot be reached', () => {
    const { seen, layer } = harness({ unavailable: true });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* takeUserMessages(), []);
      assert.strictEqual(seen.since, 2);
    }).pipe(Effect.provide(layer));
  });
});

describe('ensureResident', () => {
  it.effect('falls back to a plain lookup when the pick is refused', () => {
    const { seen, layer } = harness({ ensure: ['refused', 'onDesk'] });
    return Effect.gen(function* () {
      assert.strictEqual(yield* ensureResident(), 'onDesk');
      assert.deepStrictEqual(seen.ensured, ['No.1', 'lookup']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('remembers a resident the user put away', () => {
    const { seen, layer } = harness({ ensure: ['stowed'] });
    return Effect.gen(function* () {
      assert.strictEqual(yield* ensureResident(), 'stowed');
      assert.isTrue(seen.stowed);
    }).pipe(Effect.provide(layer));
  });

  it.effect('is null when Pixling cannot be reached', () => {
    const { layer } = harness({});
    return Effect.gen(function* () {
      assert.isNull(yield* ensureResident());
    }).pipe(Effect.provide(layer));
  });
});

describe('askPermission', () => {
  const request = { tool: 'Bash', input: { command: 'ls' } };

  it.effect('reads the answer from a pending question', () => {
    const { layer } = harness({
      questions: [
        { promptID: 'p', state: 'pending' },
        { promptID: 'p', state: 'answered', selectedChoiceID: 'deny-with-message', enteredText: 'no' },
      ],
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* askPermission(request), { decision: 'deny', message: 'no' });
    }).pipe(Effect.provide(layer));
  });

  it.live('withdraws the question when interrupted', () => {
    const { seen, layer } = harness({ questions: [{ promptID: 'p', state: 'pending' }] });
    return Effect.gen(function* () {
      const fiber = yield* askPermission(request).pipe(Effect.forkChild);
      yield* Effect.sleep('20 millis');
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(seen.cancelled, ['p']);
    }).pipe(Effect.provide(layer));
  });
});

describe('askPermission, when the desk misbehaves or an answer goes past', () => {
  const request = { tool: 'Bash', input: { command: 'ls' } };
  const pending = { promptID: 'p', state: 'pending' };

  it.live('interrupted while showing the card, it finishes showing it and withdraws it', () => {
    const { seen, layer } = harness({ questions: [pending], askTakes: '50 millis' });
    return Effect.gen(function* () {
      const fiber = yield* askPermission(request).pipe(Effect.forkChild);
      yield* Effect.sleep('10 millis');
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(seen.cancelled, ['p']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('reads an answer that went to the inbox by its promptID, and tells nobody else about it', () => {
    const { seen, layer } = harness({
      questions: [pending, 'gone'],
      entries: { p: { kind: 'answer', answer: { promptID: 'p', outcome: 'answered', selectedChoiceID: 'allow' } } },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* askPermission(request), { decision: 'allow' });
      assert.strictEqual(seen.asked, 1);
      assert.deepStrictEqual(yield* takeUserMessages(), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a typed answer from the inbox denies, with the text', () => {
    const { layer } = harness({
      questions: [pending, 'gone'],
      entries: {
        p: {
          kind: 'answer',
          answer: { promptID: 'p', outcome: 'answered', selectedChoiceID: 'deny-with-message', enteredText: 'no' },
        },
      },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* askPermission(request), { decision: 'deny', message: 'no' });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a card's answer in the inbox is never pointed at the agent", () => {
    const { layer } = harness({
      questions: [pending, 'gone'],
      entries: {
        p: { kind: 'answer', sequence: 5, answer: { promptID: 'p', outcome: 'answered', selectedChoiceID: 'allow' } },
      },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* askPermission(request), { decision: 'allow' });
      assert.deepStrictEqual(yield* takeUserMessages(), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a closed card in the inbox allows nothing', () => {
    const { layer } = harness({
      questions: [pending, 'gone'],
      entries: { p: { kind: 'answer', answer: { promptID: 'p', outcome: 'cancelled' } } },
    });
    return Effect.gen(function* () {
      assert.isNull(yield* askPermission(request));
    }).pipe(Effect.provide(layer));
  });

  it.effect('shows the card again when its answer is nowhere to be found', () => {
    const { seen, layer } = harness({
      questions: [
        pending,
        'gone',
        { promptID: 'q', state: 'pending' },
        { promptID: 'q', state: 'answered', selectedChoiceID: 'allow' },
      ],
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* askPermission(request), { decision: 'allow' });
      assert.strictEqual(seen.asked, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('shows it again only once, then leaves it to the host', () => {
    const { seen, layer } = harness({ questions: [pending, 'gone', pending, 'gone'] });
    return Effect.gen(function* () {
      assert.isNull(yield* askPermission(request));
      assert.strictEqual(seen.asked, 2);
      assert.strictEqual(seen.polled, 2);
    }).pipe(Effect.provide(layer));
  });

  it.live('does not spin on a desk that answers pending at once', () => {
    const { seen, layer } = harness({
      permissionWaitMs: 600,
      questions: [pending, ...Array.from({ length: 500 }, () => pending)],
    });
    return Effect.gen(function* () {
      assert.isNull(yield* askPermission(request));
      assert.isBelow(seen.polled, 5);
    }).pipe(Effect.provide(layer));
  });

  it.live('takes an answer that arrived just as the wait ended', () => {
    const { seen, layer } = harness({
      permissionWaitMs: 300,
      questions: [pending, pending, pending, pending],
      onCancel: { promptID: 'p', state: 'answered', selectedChoiceID: 'allow' },
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* askPermission(request), { decision: 'allow' });
      assert.deepStrictEqual(seen.cancelled, ['p']);
    }).pipe(Effect.provide(layer));
  });
});

describe('relay', () => {
  it.live('hands over what the user writes, and ends when the resident is put away', () => {
    const delivered: Relayed[] = [];
    const { seen, layer } = harness({
      waits: ['one'],
      entries: { a: { kind: 'message', text: 'hello' }, b: { kind: 'closed' } },
    });
    return Effect.gen(function* () {
      yield* relay((texts) => Effect.sync(() => void delivered.push(...texts)));
      assert.deepStrictEqual(delivered, ['hello']);
      assert.isTrue(seen.stowed);
    }).pipe(Effect.provide(layer));
  });
});

describe('relay, on the clock', () => {
  it.effect('tries a refused message again at a growing distance', () => {
    let attempts = 0;
    const { layer } = harness({ waits: ['one'], entries: { a: { kind: 'message', text: 'hello' } } });
    return Effect.gen(function* () {
      const fiber = yield* relay(() =>
        Effect.suspend(() => {
          attempts += 1;
          return Effect.fail('host refused');
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust('10 millis');
      assert.strictEqual(attempts, 1);
      yield* TestClock.adjust('1 second');
      assert.strictEqual(attempts, 2);
      yield* TestClock.adjust('1 second');
      assert.strictEqual(attempts, 2, 'now it waits 2 seconds');
      yield* TestClock.adjust('1 second');
      assert.strictEqual(attempts, 3);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(layer));
  });
});

describe('relay, when the host does not take a message', () => {
  it.live(
    'keeps it, tells the user once, and hands it over together with what came next',
    () => {
      const attempts: (readonly Relayed[])[] = [];
      const { seen, layer } = harness({ waits: ['one'], entries: { a: { kind: 'message', text: 'hello' } } });
      return Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const deliver = (texts: ReadonlyArray<Relayed>) =>
          Effect.suspend(() => {
            attempts.push(texts);
            return attempts.length < 3
              ? Effect.fail('host refused')
              : Deferred.succeed(done, undefined).pipe(Effect.asVoid);
          });
        yield* relay(deliver).pipe(Effect.raceFirst(Deferred.await(done)));
        assert.deepStrictEqual(attempts, [['hello'], ['hello'], ['hello']]);
        assert.strictEqual(seen.sent.length, 1);
        assert.match(seen.sent[0], /has not reached the agent/);
      }).pipe(Effect.provide(layer));
    },
    10_000,
  );
});

// The compiler keeps a program from running without what it needs.
export const needsItsServices = () => {
  // @ts-expect-error Desk, the session and the config are not provided.
  void Effect.runPromise(turnEnded('hello'));
};
