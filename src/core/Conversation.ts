// What the proxy does for a conversation, in no host's terms. The type of each
// program names what it needs; a runtime and an adapter supply it.
import { createHash, randomUUID } from 'node:crypto';
import { Clock, Effect, Exit, Option } from 'effect';
import { admits, bubbles, type Activity, fingerprint, isDue, watches } from './Activity.ts';
import { Desk, GONE, type InboxEntry, type Question } from '../pixling/Desk.ts';
import { clip, permissionDetail, type Relayed, strings } from './text.ts';
import {
  ActivitySource,
  type Batch,
  CurrentSession,
  Expression,
  type Moment,
  ProxyConfig,
  Receiver,
  SessionStore,
} from './services.ts';

const MAX_MESSAGE_CHARS = 4000;
const MAX_QUESTION_CHARS = 120;
// A question result waits at most this long per call.
const MAX_QUESTION_WAIT_MS = 55_000;
// How often a card is shown again after its answer went past (see askPermission).
const MAX_QUESTION_RESHOWS = 1;
const MIN_QUESTION_POLL_MS = 250;
const WITHDRAW_TIMEOUT = '3 seconds';
// What waits is shown first, but what the user waits for does not wait for it: what
// does not make it in this time stays for the next flush.
const FLUSH_TIMEOUT = '3 seconds';
// After a long time away from the desk, only the newest of what waited.
const MAX_BUBBLES_PER_FLUSH = 5;
// Another hook may be creating the resident right now: how long to give it.
const ENSURE_RETRIES = 10;
const ENSURE_RETRY_WAIT = '300 millis';
// A relay's single wait, and how it backs off when waits end at once.
const RELAY_WAIT_MS = 3_600_000;
const RELAY_QUICK_MS = 5000;
const RELAY_BACKOFF_MS = 1000;
const RELAY_BACKOFF_MAX_MS = 60_000;
// What the resident shows during a turn never holds the agent up for long.
const NOTICE_TIMEOUT = '2 seconds';

export type EnsureState = 'onDesk' | 'stowed' | null;

export type PermissionAnswer =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly message?: string | undefined };

// `asset` is one selector or a list. A session starts at a pick derived from its
// key (stable across retries, spread across sessions) and falls back in order.
export function assetOrder(asset: string | ReadonlyArray<string>, key: string): string[] {
  const list = (typeof asset === 'string' ? [asset] : asset).map((a) => String(a).trim()).filter(Boolean);
  if (!list.length) return ['No.1'];
  const start = createHash('sha256').update(String(key)).digest().readUInt32BE(0) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

// `random` in `asset` stands for any resident in the zukan.
export const RANDOM = 'random';
export const isRandom = (asset: string) => asset.toLowerCase() === RANDOM;

// The session's pick from the whole zukan: stable for a key, like a list's.
export function randomPick(ids: ReadonlyArray<string>, key: string): string | undefined {
  if (!ids.length) return undefined;
  return ids[createHash('sha256').update(`${RANDOM}\0${key}`).digest().readUInt32BE(0) % ids.length];
}

// Binds (or recovers) the resident. A stowed pair stays quiet for the rest of the
// session; null means Pixling cannot be reached.
export const ensureResident = Effect.fn('ensureResident')(function* (): Effect.fn.Return<
  EnsureState,
  never,
  CurrentSession | SessionStore | ProxyConfig | Desk
> {
  const session = yield* CurrentSession;
  const store = yield* SessionStore;
  const config = yield* ProxyConfig;
  const desk = yield* Desk;
  if (yield* store.isStowed) return 'stowed';
  const initial = (yield* Expression).initialSettings ?? undefined;

  const lookup = desk.ensure(session).pipe(Effect.result);
  let found: Effect.Success<typeof lookup> | undefined;
  if (!(yield* store.isBound)) {
    // Try the session's own pick first, then the rest of the list in order.
    for (const asset of assetOrder(config.asset, session.key)) {
      let assetID = asset;
      if (isRandom(asset)) {
        const ids = yield* desk.residents().pipe(
          Effect.tapError((error) => Effect.logInfo(`${session.selector} zukan ${error.summary}`)),
          Effect.orElseSucceed(() => []),
        );
        const pick = randomPick(ids, session.key);
        if (!pick) continue;
        assetID = pick;
      }
      found = yield* desk.ensure(session, { assetID, name: session.author, initial }).pipe(Effect.result);
      if (found._tag === 'Success' || found.failure.reason !== 'refused') break;
      // Already bound (another hook got there first, with another asset): use that one.
      if (found.failure.alreadyBound) break;
    }
  }
  if (!found || (found._tag === 'Failure' && found.failure.reason === 'refused')) found = yield* lookup;
  // The binding exists but the resident cannot be listed yet. Give it a moment.
  for (let i = 0; i < ENSURE_RETRIES && found._tag === 'Success' && found.success === 'appearing'; i++) {
    yield* Effect.sleep(ENSURE_RETRY_WAIT);
    found = yield* lookup;
  }
  if (found._tag === 'Failure') {
    yield* Effect.logInfo(`${session.selector} ensure ${found.failure.summary}`);
    return null;
  }
  yield* store.markBound;
  if (found.success === 'stowed') {
    yield* store.markStowed;
    return 'stowed';
  }
  return found.success === 'appearing' ? null : 'onDesk';
});

// One message on the resident. False when it did not get there.
const send = Effect.fn('send')(function* (
  body: string,
  options: { readonly requestID?: string; readonly still?: boolean } = {},
) {
  const session = yield* CurrentSession;
  const store = yield* SessionStore;
  const desk = yield* Desk;
  const sent = yield* desk
    .send({ to: session.selector, author: session.author, text: body, ...options })
    .pipe(
      Effect.catchTag('DeskError', (error) =>
        Effect.logInfo(`${session.selector} send ${error.summary}`).pipe(Effect.as(null)),
      ),
    );
  if (!sent) return false;
  // Off the desk can mean put away, or only that no window shows it right now. Only
  // the first keeps the session quiet for good.
  if (sent.offDesk) {
    const state = yield* desk.ensure(session).pipe(Effect.orElseSucceed(() => null));
    if (state === 'stowed') yield* store.markStowed;
  }
  if (sent.outcomes.length) yield* Effect.logInfo(`${session.selector} send ${sent.outcomes.join(',')}`);
  return true;
});

// The same stretch of a session with the same words is the same message, however often
// it is tried.
const requestID = (session: string, position: string, text: string): string => {
  const hex = createHash('sha256')
    .update(session)
    .update('\0')
    .update(position)
    .update('\0')
    .update(text)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const maxChars = Effect.map(ProxyConfig, ({ show }) => Math.min(show.maxChars, MAX_MESSAGE_CHARS));

// True once everything in the batch the settings let through is on the resident.
const showBatch = Effect.fn('showBatch')(function* ({ items, position }: Batch) {
  const { show } = yield* ProxyConfig;
  const store = yield* SessionStore;
  const session = yield* CurrentSession;
  const admitted = items.filter((item) => admits(show, item));
  for (const { text, still } of bubbles(admitted, yield* maxChars).slice(-MAX_BUBBLES_PER_FLUSH)) {
    if (!(yield* send(text, { requestID: requestID(session.selector, position, text), still }))) return false;
  }
  if (admitted.length) {
    const lastText = admitted.findLast((item) => item.kind === 'text');
    const { said } = yield* store.shown;
    yield* store.setShown({
      at: yield* Clock.currentTimeMillis,
      said: lastText ? fingerprint(lastText.text) : said,
    });
  }
  return true;
});

// Shows what waits, if it is time. `force`: whatever the time.
export const showPending = Effect.fn('showPending')(function* (options: { readonly force?: boolean } = {}) {
  const { show } = yield* ProxyConfig;
  const store = yield* SessionStore;
  if (!watches(show) || (yield* store.isStowed)) return;
  if (!options.force && !isDue(show, (yield* store.shown).at, yield* Clock.currentTimeMillis)) return;
  const source = yield* ActivitySource;
  yield* source.drain(showBatch);
});

// A moment of the turn, for the resident to show if its Expression does. Only for a
// resident bound and on the desk: otherwise every moment would be a call bound to fail.
const notice = Effect.fn('notice')(function* (moment: Moment) {
  const store = yield* SessionStore;
  if (!(yield* store.isBound) || (yield* store.isStowed)) return;
  const expression = yield* Expression;
  yield* expression.noticed(moment).pipe(Effect.timeoutOption(NOTICE_TIMEOUT));
});

// Something the agent did, and a chance to show what waits.
export const observed = Effect.fn('observed')(function* (activity: Activity) {
  const { show } = yield* ProxyConfig;
  const store = yield* SessionStore;
  if (yield* store.isStowed) return;
  if (activity.kind === 'tool') yield* notice({ kind: 'tool', name: activity.name });
  if (admits(show, activity)) {
    const source = yield* ActivitySource;
    yield* source.observe(activity);
  }
  yield* showPending();
});

const isSameText = (item: Activity | undefined, text: string) => item?.kind === 'text' && item.text.trim() === text;

// The turn's end: everything still waiting, whatever the time, and then the reply by
// itself. Done as one step when it can be, so the reply's own line, if it is among what
// waits, only counts as seen once the reply got there. The reply never depends on that
// step: if it cannot get its turn, fails or takes too long, the reply goes anyway,
// remembered so its line does not show it again, and the rest waits for the next flush.
// Once the reply is on the resident, the resident reacts to it (see Expression).
export const turnEnded = Effect.fn('turnEnded')(function* (finalText: string | null | undefined) {
  const final = finalText?.trim();
  // Not to a resident the reply found put away.
  if ((yield* showTurnEnd(final || undefined)) && final && !(yield* (yield* SessionStore).isStowed)) {
    const expression = yield* Expression;
    yield* expression.replied(final);
  }
  // After the reply, which never waits for it.
  yield* notice({ kind: 'end' });
});

// True when the reply's words are on the resident: shown now, or as a text before.
const showTurnEnd = Effect.fn('showTurnEnd')(function* (final: string | undefined) {
  const { show } = yield* ProxyConfig;
  const store = yield* SessionStore;
  const expression = yield* Expression;
  if (yield* store.isStowed) return false;
  const seen = final ? fingerprint(final) : undefined;
  const limit = yield* maxChars;
  const session = yield* CurrentSession;
  const source = yield* ActivitySource;

  // Shown as a text already, this turn. With texts off only replies set this, and the
  // same reply twice is two replies.
  const alreadySaid = Effect.map(store.shown, ({ said }) => show.text && said === seen);
  let replyShown = false;
  let lineSeen = false;
  // The reply's words are on the resident: sent now, or shown as a text before.
  let onResident = false;
  // This turn's end, however often its reply is tried. The same words next turn are new.
  const replyRequest = requestID(session.selector, randomUUID(), final ?? '');
  const showReply = Effect.gen(function* () {
    if (!final || !show.reply || replyShown) return true;
    const sent = yield* send(clip(final, limit), { requestID: replyRequest, still: expression.movesForReply });
    if (!sent) return false;
    replyShown = true;
    onResident = true;
    yield* store.setShown({ ...(yield* store.shown), said: seen });
    return true;
  });

  if (watches(show)) {
    yield* source
      .drain((batch) =>
        Effect.gen(function* () {
          const last = batch.items.findLastIndex((item) => item.kind === 'text');
          const hasLine = !!final && isSameText(batch.items[last], final);
          const rest = hasLine ? { ...batch, items: batch.items.toSpliced(last, 1) } : batch;
          const skip = !hasLine && (yield* alreadySaid);
          if (!(yield* showBatch(rest))) return false;
          if (!skip && !(yield* showReply)) return false;
          lineSeen = hasLine;
          if (skip) replyShown = onResident = true;
          return true;
        }),
      )
      .pipe(Effect.timeoutOption(FLUSH_TIMEOUT));
  }
  if (!final) return false;
  if (lineSeen) return onResident;
  if (!replyShown && (yield* alreadySaid)) onResident = true;
  else if (!replyShown && !(yield* showReply)) return false;
  if (watches(show)) yield* source.replied(final).pipe(Effect.timeoutOption(FLUSH_TIMEOUT));
  return onResident;
});

// A new turn may end in the same words as the last one.
export const turnStarted = Effect.gen(function* () {
  const store = yield* SessionStore;
  const { at } = yield* store.shown;
  yield* store.setShown({ at });
});

// The turn's start, for the resident to show. Apart from turnStarted, which also runs
// where a host reports a mere step (see HookHost.promptEachStep).
export const noticeTurn = notice({ kind: 'turn' });

// A new session's start, for the resident to show.
export const noticeStart = notice({ kind: 'start' });

// An answer from the inbox, as if the question had returned it.
const questionOf = (entry: InboxEntry): Question | null =>
  entry.kind === 'answer' && entry.answer
    ? {
        state: entry.answer.outcome,
        selectedChoiceID: entry.answer.selectedChoiceID,
        enteredText: entry.answer.enteredText,
      }
    : null;

const answerOf = (question: Question): PermissionAnswer => {
  if (question.selectedChoiceID === 'allow') return { decision: 'allow' };
  if (question.selectedChoiceID === 'deny') return { decision: 'deny' };
  return { decision: 'deny', message: question.enteredText || undefined };
};

// A permission prompt, as a question on the resident. Null when no answer came in
// time; the question is then withdrawn, as it is when this program is interrupted
// (the host got its answer elsewhere).
//
// An answer given in the moment between two calls goes to the inbox instead of to
// the next call, which then finds no such question. It is read back from there by
// its promptID; if that fails too, the card is shown once more.
export const askPermission = Effect.fn('askPermission')(function* (request: {
  readonly tool: string;
  readonly input: unknown;
}) {
  const config = yield* ProxyConfig;
  const store = yield* SessionStore;
  if (!config.permissionWaitMs || (yield* store.isStowed)) return null;
  const session = yield* CurrentSession;
  const desk = yield* Desk;
  const s = strings(config.language);
  const deadline = (yield* Clock.currentTimeMillis) + config.permissionWaitMs;
  // Nobody should have to decide without what led up to it.
  yield* showPending({ force: true }).pipe(Effect.timeoutOption(FLUSH_TIMEOUT));
  // Beside the card, never ahead of it.
  const asks = clip(s.permissionQuestion(request.tool), MAX_QUESTION_CHARS);
  yield* notice({ kind: 'permission', question: asks }).pipe(Effect.forkChild);
  const status = (yield* (yield* Expression).askingStatus.pipe(Effect.timeoutOption(NOTICE_TIMEOUT))).pipe(
    Option.getOrNull,
  );

  // Showing the card is not interruptible: interrupted halfway, it would stay on the
  // resident with no promptID to withdraw it by. The desk's own timeout still applies.
  const showCard = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const asked = yield* desk
        .ask({
          to: session.selector,
          author: session.author,
          question: asks,
          detail: clip(permissionDetail(s, request.input), MAX_MESSAGE_CHARS),
          choices: [
            { id: 'allow', label: s.allow },
            { id: 'deny', label: s.deny },
          ],
          freeText: { id: 'deny-with-message', label: s.typed },
          status: status ?? undefined,
        })
        .pipe(
          Effect.catchTag('DeskError', (error) =>
            Effect.logInfo(`${session.selector} permission ${error.summary}`).pipe(Effect.as(null)),
          ),
        );
      if (!asked) return null;
      // Its answer, should it land in the inbox, is this card's: never pointed at the agent.
      if (asked.promptID) yield* store.claim(asked.promptID);

      const withdraw = asked.promptID
        ? desk.cancelQuestion(asked.promptID).pipe(
            Effect.timeoutOption(WITHDRAW_TIMEOUT),
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          )
        : Effect.succeed(null);
      const fromInbox = (promptID: string) =>
        Effect.gen(function* () {
          const entry = yield* desk
            .read(session, promptID)
            .pipe(
              Effect.catchTag('DeskError', (error) =>
                Effect.logInfo(`${session.selector} answer not in the inbox: ${error.summary}`).pipe(Effect.as(null)),
              ),
            );
          return entry && questionOf(entry);
        });
      const untilAnswered = Effect.gen(function* () {
        let question = asked;
        while (question.state === 'pending' && question.promptID) {
          const before = yield* Clock.currentTimeMillis;
          const left = deadline - before;
          if (left <= 0) break;
          const next = yield* desk
            .questionResult(question.promptID, Math.min(MAX_QUESTION_WAIT_MS, left))
            .pipe(Effect.catchTag('DeskError', () => Effect.succeed(null)));
          if (next === null) break;
          if (next === GONE) {
            const found = yield* fromInbox(question.promptID);
            return found ?? ('showAgain' as const);
          }
          question = next;
          // A desk that answers `pending` without waiting must not turn this into a busy loop.
          if (question.state === 'pending' && (yield* Clock.currentTimeMillis) - before < MIN_QUESTION_POLL_MS) {
            yield* Effect.sleep(MIN_QUESTION_POLL_MS);
          }
        }
        return question;
      });
      const question = yield* restore(untilAnswered).pipe(Effect.onInterrupt(() => withdraw));
      if (question === 'showAgain') return question;
      if (question.state === 'answered') return answerOf(question);
      // The user may have answered just as the wait ended: withdrawing reports it.
      const withdrawn = yield* withdraw;
      const late = withdrawn === GONE && asked.promptID ? yield* fromInbox(asked.promptID) : withdrawn;
      return late && late !== GONE && late.state === 'answered' ? answerOf(late) : null;
    }),
  );

  for (let shown = 0; shown <= MAX_QUESTION_RESHOWS; shown++) {
    const outcome = yield* showCard;
    if (outcome !== 'showAgain') return outcome;
  }
  return null;
});

const textOf = (entry: InboxEntry): string | null => (entry.kind === 'message' && entry.text) || null;

// One entry, once across processes. One that was not read, because the desk refused
// or this program was interrupted, stays for the next call.
const readClaimed = Effect.fn('readClaimed')(function* (messageID: string) {
  const session = yield* CurrentSession;
  const store = yield* SessionStore;
  const desk = yield* Desk;
  return yield* Effect.acquireUseRelease(
    store.claim(messageID),
    (claimed) => (claimed ? desk.read(session, messageID) : Effect.succeed(null)),
    (claimed, exit) => (claimed && Exit.isFailure(exit) ? store.unclaim(messageID) : Effect.void),
  ).pipe(Effect.catchTag('DeskError', () => Effect.succeed(null)));
});

// What the user wrote since the last call, and the late answers that arrived since
// (left unread: see Relayed). Stays silent when the desk cannot be reached, or does not
// say what is unread within `lookWithinMs`: the user's messages then wait in the inbox.
// Reading is never cut short here: what is read is gone from the inbox.
export const takeUserMessages = Effect.fn('takeUserMessages')(function* (
  lookWithinMs?: number,
): Effect.fn.Return<ReadonlyArray<Relayed>, never, CurrentSession | SessionStore | Desk | Receiver> {
  const session = yield* CurrentSession;
  const store = yield* SessionStore;
  if (yield* store.isStowed) return [];
  const desk = yield* Desk;
  const lookup = desk
    .unread(session)
    .pipe(
      Effect.catchTag('DeskError', (error) =>
        Effect.logInfo(`${session.selector} unread ${error.summary}`).pipe(Effect.as(null)),
      ),
    );
  const unread =
    lookWithinMs === undefined
      ? yield* lookup
      : Option.getOrNull(yield* Effect.timeoutOption(lookup, Math.max(0, lookWithinMs)));
  if (!unread) return [];
  const since = yield* store.since;
  const answers = unread.filter((notice) => notice.kind === 'answer');
  const toRead = unread.filter((notice) => notice.kind !== 'answer').map((notice) => notice.messageID);
  const entries = (yield* Effect.forEach(toRead, readClaimed)).filter((entry) => entry !== null);
  const newer = answers.filter((notice) => notice.sequence > since);
  // Claimed without reading: once across processes, and never a permission card's own.
  const fresh = yield* Effect.filter(newer, (notice) => store.claim(notice.messageID));
  yield* store.setSince(
    Math.max(since, ...entries.map((entry) => entry.sequence ?? 0), ...newer.map((notice) => notice.sequence)),
  );
  if (entries.some((entry) => entry.kind === 'closed')) {
    const receiver = yield* Receiver;
    yield* Effect.logInfo(`${session.selector} closed by the user`);
    yield* store.markStowed;
    yield* receiver.stop;
  }
  return [
    ...entries.map(textOf).filter((text) => text !== null),
    ...fresh.map((notice) => ({ answerTo: notice.messageID })),
  ];
});

// Blocks until the user writes or `timeoutMs` passes. Empty when nothing came or
// the desk cannot be reached. Interrupting ends the wait and its process.
export const waitForUser = Effect.fn('waitForUser')(function* (timeoutMs: number) {
  const session = yield* CurrentSession;
  const store = yield* SessionStore;
  const desk = yield* Desk;
  const since = yield* store.since;
  const arrived = yield* desk
    .wait(session, { since, timeoutMs })
    .pipe(Effect.catchTag('DeskError', () => Effect.succeed(false)));
  return arrived ? yield* takeUserMessages() : [];
});

// Hands every batch the user writes to `deliver`, until interrupted or the resident
// is put away. What was read is gone from the inbox, so a batch the host does not
// take is kept and tried again, and the user is told once. A wait that ends at once
// (not bound, Pixling refusing) backs off instead of spinning.
export const relay = <E, R>(deliver: (texts: ReadonlyArray<Relayed>) => Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    const store = yield* SessionStore;
    const config = yield* ProxyConfig;
    const desk = yield* Desk;
    let backoff = RELAY_BACKOFF_MS;
    let undelivered: ReadonlyArray<Relayed> = [];
    while (!(yield* store.isStowed)) {
      const started = yield* Clock.currentTimeMillis;
      const fresh = undelivered.length ? yield* takeUserMessages() : yield* waitForUser(RELAY_WAIT_MS);
      const texts = [...undelivered, ...fresh];
      if (texts.length) {
        const handed = yield* deliver(texts).pipe(Effect.result);
        if (handed._tag === 'Success') {
          undelivered = [];
          backoff = RELAY_BACKOFF_MS;
          continue;
        }
        yield* Effect.logInfo(`${session.selector} delivery failed, keeping ${texts.length}`);
        if (!undelivered.length) {
          yield* desk
            .send({ to: session.selector, author: session.author, text: strings(config.language).undelivered })
            .pipe(Effect.ignore);
        }
        undelivered = texts;
      } else if ((yield* Clock.currentTimeMillis) - started >= RELAY_QUICK_MS) {
        continue;
      }
      yield* Effect.sleep(backoff);
      backoff = Math.min(backoff * 2, RELAY_BACKOFF_MAX_MS);
    }
  });
