// The emote extension: the resident reacts to each turn's reply in a way that fits it
// (done, failed, asking, ...), as judged by an evaluation API. It takes over core's
// Expression for a session; everything else is the plain proxy.
//
// The judge and the run take seconds, and a hook must answer at once, so the reply
// is handed to a detached reactor process (bin/emote-reactor.ts) on stdin: never as
// an argument, where any process could read it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock, Effect, Layer } from 'effect';
import { CurrentSession, Expression, type Moment, SessionStore } from '../../core/services.ts';
import { Desk } from '../../pixling/Desk.ts';
import { log } from '../../runtimes/log.ts';
import { SessionLocks } from '../../runtimes/SessionFiles.ts';
import { nodeRuntime } from '../../runtimes/process.ts';
import { SPEAKING, voiceConfig } from '../voice/config.ts';
import { emoteConfig } from './config.ts';
import {
  ASKING,
  emojiFor,
  type LastShown,
  STATUS_RENEW_MS,
  statusFor,
  type StatusMemo,
  type Weight,
  weightOf,
} from './during.ts';
import { MAX_JUDGED_CHARS } from './reactions.ts';

export { emoteConfig } from './config.ts';
export { Judge } from './Judge.ts';
export { ownMotionFor, react } from './react.ts';

// Built next to the module that bundles this one.
const REACTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'emote-reactor.mjs');

export interface ReactorInput {
  // The session, whose memory the reactor reads and writes (which reaction comes next).
  readonly namespace: string;
  readonly key: string;
  readonly author: string;
  readonly reply: string;
  // How much work the turn was.
  readonly weight: Weight;
  // `reply` is what a card on the resident asks: said aloud as it is, with no reaction.
  readonly ask?: boolean;
}

// What showed last during the turn.
const LAST_SHOWN = 'emote-shown';
// Held while one process decides and shows: hook processes of a session run at once.
const SHOWING_LOCK = 'emote-showing';
// The resident's state during the turn (see StatusMemo).
const STATUS = 'emote-status';
// When the turn began (a number), for how much work it was.
const TURN_BEGAN = 'emote-turn-began';
// A resident the plugin creates moves: its reactions turn, shake and play its own
// clips, and a state shows. One that exists keeps what its user chose.
const INITIAL_SETTINGS = { motionEnabled: true };

// How long a new resident is given to show, within what a moment may take.
const APPEAR_TRIES = 4;
const APPEAR_WAIT = '400 millis';
const NOT_VISIBLE = 'notVisible';

const statusMemo = (value: unknown): StatusMemo => {
  const memo = (value && typeof value === 'object' ? value : {}) as Partial<StatusMemo>;
  return {
    defined: Array.isArray(memo.defined) ? memo.defined.filter((name) => typeof name === 'string') : null,
    name: typeof memo.name === 'string' ? memo.name : null,
    at: typeof memo.at === 'number' ? memo.at : 0,
  };
};

// Never fails: a reactor that cannot start costs the reply its motion, nothing else.
const startReactor = (input: ReactorInput) =>
  Effect.try(() => {
    const child = spawn(nodeRuntime(), [REACTOR], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    child.on('error', (e) => log(`${input.key} emote reactor failed to start: ${e.message}`));
    child.stdin?.on('error', () => {});
    // Only what the judge reads.
    child.stdin?.end(JSON.stringify({ ...input, reply: input.reply.slice(0, MAX_JUDGED_CHARS) }));
    child.unref();
  }).pipe(Effect.catch((e) => Effect.logInfo(`${input.key} emote reactor failed to start: ${String(e)}`)));

// Without emote settings and a key nothing changes: the resident moves for the reply as
// for any message, and shows nothing while the agent works.
export const EmoteExpression = Layer.effect(Expression)(
  Effect.gen(function* () {
    const session = yield* CurrentSession;
    const store = yield* SessionStore;
    const locks = yield* SessionLocks;
    const desk = yield* Desk;
    if (!emoteConfig()) return Expression.defaultValue();
    const speaks = voiceConfig() !== null;

    // Decides and records under the lock; another process at it means this moment is
    // too close to that one, except for what always shows.
    const decide = (moment: Moment, now: number) =>
      Effect.gen(function* () {
        const emoji = emojiFor(moment, (yield* store.memo(LAST_SHOWN)) as LastShown | undefined, now);
        if (emoji) yield* store.setMemo(LAST_SHOWN, { kind: emoji.kind, at: now } satisfies LastShown);
        return emoji;
      });

    // The resident's state for the moment, on an asset that has looks for the names
    // (none: no call at all past the turn's start). Failures only cost the state. The
    // memo is written before the desk is called, so a call cut short is still known.
    const showStatus = (moment: Moment, now: number) =>
      Effect.gen(function* () {
        if (moment.kind === 'start') return;
        const to = session.selector;
        const before = statusMemo(yield* store.memo(STATUS));
        // Cleared whenever the asset has looks, whatever the memo says shows: the desk
        // brings a state back after a card, and a late tool call may have set one. The
        // next turn reads the looks again: the user may have given the asset some.
        if (moment.kind === 'end') {
          yield* store.setMemo(STATUS, { defined: null, name: null, at: now } satisfies StatusMemo);
          if (before.defined?.length) yield* desk.status({ to, clear: true }).pipe(Effect.ignore);
          return;
        }
        // The card carries its own state, and the desk brings this one back after it.
        if (moment.kind === 'permission') return;
        // Read at the turn's start, or at its first tool call on a host that tells no start.
        const read = moment.kind === 'turn' || before.defined === null;
        const defined = read
          ? (yield* desk.traits(to).pipe(Effect.orElseSucceed(() => ({ statuses: before.defined ?? [] })))).statuses
          : (before.defined ?? []);
        const name = statusFor(moment, defined);
        const fresh = name === before.name && now - before.at < STATUS_RENEW_MS;
        if (read || (name && !fresh)) {
          yield* store.setMemo(STATUS, { defined, name: name ?? before.name, at: now } satisfies StatusMemo);
        }
        if (!name || fresh) return;
        yield* desk.status({ to, name }).pipe(Effect.ignore);
        // The turn ended while this was on its way (a tool call's part runs detached):
        // its state must not outlive the turn.
        const after = statusMemo(yield* store.memo(STATUS));
        if (after.defined === null && after.at >= now) yield* desk.status({ to, clear: true }).pipe(Effect.ignore);
      });

    return Expression.of({
      initialSettings: INITIAL_SETTINGS,
      askingStatus: Effect.map(store.memo(STATUS), (memo) =>
        statusMemo(memo).defined?.includes(ASKING) ? ASKING : null,
      ),
      movesForReply: true,
      replied: (reply) =>
        Effect.gen(function* () {
          const began = yield* store.memo(TURN_BEGAN);
          const weight = weightOf(typeof began === 'number' ? began : null, yield* Clock.currentTimeMillis);
          yield* startReactor({
            namespace: session.namespace,
            key: session.key,
            author: session.author,
            reply,
            weight,
          });
        }),
      noticesTools: true,
      noticed: (moment) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // The turn's start, or its first tool call on a host that tells no start.
          if (
            moment.kind === 'turn' ||
            (moment.kind === 'tool' && typeof (yield* store.memo(TURN_BEGAN)) !== 'number')
          ) {
            yield* store.setMemo(TURN_BEGAN, now);
          }
          if (moment.kind === 'end') yield* store.setMemo(TURN_BEGAN, null);
          // The user has moved on: what is still being said of the last reply stops.
          if (moment.kind === 'turn' && speaks) yield* locks.stopHolder(SPEAKING);
          // A permission card is also heard: the user may not be looking.
          if (moment.kind === 'permission' && speaks) {
            yield* startReactor({
              namespace: session.namespace,
              key: session.key,
              author: session.author,
              reply: moment.question,
              weight: 'normal',
              ask: true,
            });
          }
          const locked = yield* locks.lock(SHOWING_LOCK);
          if (!locked && moment.kind === 'tool') return;
          const emoji = yield* decide(moment, now).pipe(
            Effect.ensuring(locked ? locks.unlock(SHOWING_LOCK) : Effect.void),
          );
          // The emoji first: it is what the moment is for, and the state may take longer.
          if (emoji) {
            // A resident just created takes a moment to show: its wave waits for it.
            for (let tries = moment.kind === 'start' ? APPEAR_TRIES : 1; tries > 0; tries--) {
              const popped = yield* desk.emote({ to: session.selector, text: emoji.text }).pipe(Effect.result);
              if (popped._tag === 'Success') break;
              if (tries > 1 && popped.failure.detail === NOT_VISIBLE) {
                yield* Effect.sleep(APPEAR_WAIT);
                continue;
              }
              yield* Effect.logInfo(`${session.selector} emote ${emoji.kind} ${popped.failure.summary}`);
              break;
            }
          }
          yield* showStatus(moment, now);
        }),
    });
  }),
);
