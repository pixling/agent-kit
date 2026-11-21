// The resident's reaction to one reply, run by the reactor process (bin/emote-reactor.ts)
// once the reply is on the resident. Every failure ends in the resident's own motion for
// a message, which the reply would have had anyway (see `ownMotionFor`).
import { Clock, Effect, Random } from 'effect';
import { SessionStore } from '../../core/services.ts';
import { DEFAULT_SPEAK, Desk, type SpeakHook } from '../../pixling/Desk.ts';
import type { Weight } from './during.ts';
import { Judge, type Verdict } from './Judge.ts';
import {
  glowStylesFor,
  lifted,
  lit,
  type Mood,
  MOOD_EMOJI,
  NO_TRAITS,
  ownMotion,
  pastBottom,
  reactionFor,
  type Run,
  savedName,
  speakLabel,
  type Traits,
  traitsOf,
  weighted,
  withoutMotion,
} from './reactions.ts';

// A resident on the floor is raised by what the refusal says is missing, at most this far.
const MAX_LIFT_PT = 120;
const MAX_TRIES = 5;
const MOTION_OFF = 'motionOff';
// Another run is playing (a new resident's entrance, say): wait for it, a few times.
const BUSY = 'busy';
const BUSY_WAIT = '700 millis';
const LIFT_MARGIN_PT = 3;
// The CLI's words for a resident held by something of the user's (a question, their
// writing, its settings card open): that does not pass in a moment, so no waiting.
const HELD_OPEN = /\bopen\b/;

interface Started {
  readonly played: boolean;
  // Refused because the resident takes no run now, though an emote would still show.
  readonly busy: boolean;
  // For the log.
  readonly note: string;
}

// Starts the run, waiting a little while another run plays. For steps it also raises
// the resident when the run would leave the screen below, and leaves out what needs
// motion when the user turned the resident's motion off.
const start = Effect.fn('emote.start')(function* (to: string, run: Run): Effect.fn.Return<Started, never, Desk> {
  const desk = yield* Desk;
  const steps = 'steps' in run ? run.steps : null;
  let plan = steps;
  let dy = 0;
  for (let tries = 0; ; tries++) {
    const attempt = yield* desk
      .sequence(plan ? { to, steps: dy ? lifted(plan, dy) : plan } : { to, name: (run as { name: string }).name })
      .pipe(Effect.result);
    if (attempt._tag === 'Success') {
      const how = !plan ? `saved ${(run as { name: string }).name}` : plan === steps ? 'ok' : 'without motion';
      return { played: true, busy: false, note: [how, dy ? `lifted ${dy}` : ''].join(' ') };
    }
    const failure = attempt.failure;
    const refused = { played: false, busy: failure.detail === BUSY, note: failure.summary };
    if (tries >= MAX_TRIES) return refused;
    if (failure.detail === BUSY) {
      if (HELD_OPEN.test(failure.explanation ?? '')) return refused;
      yield* Effect.sleep(BUSY_WAIT);
      continue;
    }
    if (!plan || !steps) return refused;
    if (failure.detail === MOTION_OFF && plan === steps) {
      plan = withoutMotion(steps);
      // Nothing left to play: an action, such as a poke.
      if (!plan.length) return refused;
      continue;
    }
    const by = pastBottom(failure.explanation);
    if (!by || dy + by > MAX_LIFT_PT) return refused;
    dy += Math.ceil(by) + LIFT_MARGIN_PT;
  }
});

// What the reply would have had without this extension: the resident's own motion for
// a message (its speak hook). The reactor falls back to it whatever went wrong.
const playOwnMotion = Effect.fn('emote.playOwnMotion')(function* (to: string, speak: SpeakHook) {
  const run = ownMotion(speak);
  return run ? `${speakLabel(speak)}=${(yield* start(to, run)).note.trim()}` : 'none';
});

export const ownMotionFor = Effect.fn('emote.ownMotionFor')(function* (to: string) {
  const desk = yield* Desk;
  const { speak } = yield* desk.traits(to).pipe(Effect.orElseSucceed(() => ({ speak: DEFAULT_SPEAK })));
  return yield* playOwnMotion(to, speak);
});

// How many times the session reacted to each mood, so the next time takes the next way.
const VARIANTS = 'emote-variants';

const countsOf = (value: unknown): Record<string, number> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1])),
      )
    : {};

// A sequence the user saved for the mood plays first; refused, the built-in one does.
const playMood = Effect.fn('emote.playMood')(function* (
  to: string,
  mood: Mood,
  traits: Traits,
  turn: number,
  weight: Weight,
) {
  const desk = yield* Desk;
  const saved = yield* desk.savedSequences(to).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const notes: string[] = [];
  if (saved.includes(savedName(mood))) {
    const played = yield* start(to, { name: savedName(mood) });
    if (played.played) return played;
    notes.push(played.note);
  }
  const steps = reactionFor(mood, traits, turn);
  if (!steps) return { played: false, busy: false, note: [...notes, 'none'].join(' ') };
  const styles = glowStylesFor(mood);
  const style = styles[yield* Random.nextIntBetween(0, styles.length - 1)]!;
  const played = yield* start(to, { steps: weighted(mood, lit(steps, style), weight) });
  return { ...played, note: [...notes, `glow=${style}`, played.note].join(' ') };
});

// The mood's one emoji, for a resident that takes no run now. For the log.
const pop = Effect.fn('emote.pop')(function* (to: string, mood: Mood) {
  const desk = yield* Desk;
  const text = MOOD_EMOJI[mood];
  if (!text) return 'none';
  return yield* desk.emote({ to, text, count: 2 }).pipe(
    Effect.as('pop'),
    Effect.catch((error) => Effect.succeed(`pop ${error.summary}`)),
  );
});

export const react = Effect.fn('emote.react')(function* (to: string, reply: string, weight: Weight = 'normal') {
  const judge = yield* Judge;
  const desk = yield* Desk;
  const store = yield* SessionStore;
  const began = yield* Clock.currentTimeMillis;
  // Before the judge: what the desk already knows decides whether the reply leaves
  // this Mac at all.
  const described = yield* desk.traits(to).pipe(Effect.orElseSucceed(() => null));
  // No window shows the resident: nobody would see a reaction.
  if (described && !described.inView) return yield* Effect.logInfo(`${to} emote skipped notInView`);
  // A question waits on the resident: that is what the turn ended in, and until it is
  // answered the resident takes no run.
  if (described?.questionOpen)
    return yield* Effect.logInfo(`${to} emote mood=asking question ${yield* pop(to, 'asking')}`);
  const verdict = yield* judge.verdictOf(reply).pipe(
    Effect.tapError((error) => Effect.logInfo(`${to} emote judge failed: ${String(error.cause).slice(0, 200)}`)),
    Effect.orElseSucceed((): Verdict => ({ mood: null, weight: null })),
  );
  const { mood } = verdict;
  // The reply's own weight, when the judge gave one, over the turn's length.
  const effectiveWeight: Weight = verdict.weight ?? weight;
  const traits: Traits = described ? traitsOf(described.clips) : NO_TRAITS;
  const counts = countsOf(yield* store.memo(VARIANTS));
  const turn = mood ? (counts[mood] ?? 0) : 0;
  if (mood) yield* store.setMemo(VARIANTS, { ...counts, [mood]: turn + 1 });
  const reaction = mood
    ? yield* playMood(to, mood, traits, turn, effectiveWeight)
    : { played: false, busy: false, note: 'none' };
  // Not judged, not worth a reaction, or refused: its own motion for a message, or,
  // when it takes no run now, the mood's emoji.
  const own = reaction.played
    ? null
    : mood && reaction.busy
      ? yield* pop(to, mood)
      : yield* playOwnMotion(to, described?.speak ?? DEFAULT_SPEAK);
  const ms = (yield* Clock.currentTimeMillis) - began;
  yield* Effect.logInfo(
    `${to} emote mood=${mood ?? '-'} ${effectiveWeight} turn=${turn} ${reaction.note.trim()}${own ? ` own ${own}` : ''} ms=${ms}`,
  );
});
