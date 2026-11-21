// What the resident does for each kind of reply, as one sequence run (the CLI's JSON
// steps): emotes and lights ride inside its cuts. Pure data and pure functions.
//
// Only holds, moves, turns and squashes, so every resident can play them. `turn` is relative to
// the cut before, so every tilt is undone by its opposite; `dy` > 0 is up. A light must
// end inside its cut (pulse and sweep at least 334 ms, blink at least 1002 ms).

import type { Clip, SpeakHook } from '../../pixling/Desk.ts';
import type { Weight } from './during.ts';

export const MOODS = [
  'done',
  'partial',
  'failed',
  'asking',
  'running',
  'sorry',
  'suggesting',
  'explaining',
  'greeting',
  'neutral',
] as const;
export type Mood = (typeof MOODS)[number];

type Step = Record<string, unknown>;

// What a reaction may borrow from the resident itself: one of its clips for when it
// is pleased (played faster) and one for when it is not (slower and greyer).
export interface Traits {
  readonly pleased: string | null;
  readonly downcast: string | null;
}
export const NO_TRAITS: Traits = { pleased: null, downcast: null };

// Words a maker gives a clip that suits each: a resident with a dance dances when the
// work is done, instead of breathing faster.
const JOYFUL =
  /ダンス|おど[るり]|踊|よろこ|喜|ジャンプ|とびはね|跳|ばんざい|万歳|はしゃ|跳舞|開心|快樂|高興|歡呼|慶祝|跳躍|蹦跳|雀躍|춤|기쁨|기쁘|행복|신나|환호|축하|점프|뛰|\b(dance|dancing|jump|hop|cheer|joy|happy|celebrat\w*)\b/i;
const GLUM =
  /しょんぼり|うなだれ|おちこ|落ち込|かなし|悲|あわて|慌|こま[るり]|困|難過|傷心|沮喪|失落|哭|慌張|焦急|擔心|煩惱|슬픔|슬프|우울|시무룩|울|당황|걱정|곤란|\b(sad|droop|slump|cry|fluster|panic|worr\w*)\b/i;

// A clip's name says more than the sentence about it, where such a word can turn up
// by the way: every name is tried first.
const named = (clips: ReadonlyArray<Clip>, words: RegExp): string | null =>
  (clips.find(({ name }) => words.test(name)) ?? clips.find(({ motion }) => words.test(motion)))?.id ?? null;

// The clips a reaction borrows: one whose words suit the feeling, else the resident's
// usual motion (its first clip).
export const traitsOf = (clips: ReadonlyArray<Clip>): Traits => {
  const usual = clips[0]?.id ?? null;
  return { pleased: named(clips, JOYFUL) ?? usual, downcast: named(clips, GLUM) ?? usual };
};

const cut = (holdMs: number, fields: Step = {}): Step => ({ kind: 'cut', holdMs, easing: 'smooth', ...fields });
const emote = (text: string, count = 1) => ({ emote: [{ text, count }] });
const glow = (shape: 'pulse' | 'sweep' | 'blink', color: string, durationMs: number, direction?: string) => ({
  glow: [{ select: 'all', shape, color, durationMs, ...(direction ? { direction } : {}) }],
});
const repeat = (times: number, steps: Step[]): Step => ({ kind: 'repeat', times, steps });

// A squash against the floor, as when the resident lands: at the start of its cut. The
// desk leaves it out, and plays the rest, for a resident whose motion is off.
const squash = (strength: number) => ({ bounce: [{ strength, direction: 'down' }] });
// How long a landing takes to spring back.
const LANDING_MS = 220;

// Each hop crouches before it leaves the floor (which is also the landing of the hop
// before), and the last one lands: the higher the hop, the deeper both.
const hop = (times: number, dy = 36, extra: Step = {}): Step[] => {
  const strength = Math.min(1, dy / 50);
  const up = (fields: Step = {}) => cut(150, { move: { dx: 0, dy }, ...squash(strength), ...fields });
  const down = cut(190, { move: { dx: 0, dy: -dy } });
  return [up(extra), down, ...(times > 1 ? [repeat(times - 1, [up(), down])] : []), cut(LANDING_MS, squash(strength))];
};

const sway = (times: number, deg: number, ms: number, extra: Step = {}): Step[] => [
  cut(ms / 2, { turn: -deg }),
  cut(ms, { turn: 2 * deg, ...extra }),
  cut(ms, { turn: -2 * deg }),
  ...(times > 1 ? [repeat(times - 1, [cut(ms, { turn: 2 * deg }), cut(ms, { turn: -2 * deg })])] : []),
  cut(ms / 2, { turn: deg }),
];

// The resident's own clip once, its length set by the clip and the tempo. A light
// stays out of it: how long the clip takes differs from resident to resident.
const clipCut = (clip: string, look: Step, extra: Step = {}): Step => ({
  kind: 'cut',
  animation: clip,
  cycles: 1,
  easing: 'smooth',
  look,
  ...extra,
});
const PLEASED = { motionTempo: 'veryFast' };
const DOWNCAST = { motionTempo: 'slow', tone: { brightness: -1, saturation: -2 } };

// One way to react: plain steps every resident can play, or steps built from its
// traits (null when it lacks what they need).
type Variant = ReadonlyArray<Step> | ((traits: Traits) => ReadonlyArray<Step> | null);

const withClip =
  (feeling: keyof Traits, build: (clip: string) => ReadonlyArray<Step>): Variant =>
  (traits) => {
    const clip = traits[feeling];
    return clip ? build(clip) : null;
  };

// The one emoji that stands for each mood, for a resident that can take no run now
// (a question or its settings open on it): an emote still shows.
export const MOOD_EMOJI: Readonly<Record<Mood, string | null>> = {
  done: '🎉',
  partial: '✔️',
  failed: '💦',
  asking: '❓',
  running: '⏳',
  sorry: '🙇',
  suggesting: '💡',
  explaining: '📖',
  greeting: '👋',
  neutral: null,
};

// Each mood has a few ways to react, taken in turn so the same mood twice in a row
// looks different. Neutral has none: no reaction of its own.
export const REACTIONS: Readonly<Record<Mood, ReadonlyArray<Variant>>> = {
  done: [
    [
      cut(340, { move: { dx: 0, dy: 36 }, ...squash(0.7), ...emote('🎉', 3), ...glow('pulse', '#FFD54A', 340) }),
      cut(190, { move: { dx: 0, dy: -36 } }),
      ...hop(1),
      cut(160, { move: { dx: 0, dy: 50 }, ...squash(1) }),
      cut(480, { turn: 360, ...emote('✨', 2), ...glow('sweep', '#FFF3B0', 480, 'bottom-to-top') }),
      cut(200, { move: { dx: 0, dy: -50 } }),
      cut(LANDING_MS, squash(1)),
    ],
    withClip('pleased', (clip) => [
      clipCut(clip, PLEASED, { move: { dx: 0, dy: 30 }, ...emote('🎉', 3) }),
      cut(250, { move: { dx: 0, dy: -30 } }),
      cut(500, { ...squash(0.6), ...emote('✨', 2), ...glow('pulse', '#FFD54A', 500) }),
    ]),
    [...hop(2, 30, emote('✅')), cut(600, { ...emote('✨', 2), ...glow('sweep', '#FFF3B0', 600, 'bottom-to-top') })],
  ],
  partial: [
    [
      cut(340, { move: { dx: 0, dy: 24 }, ...emote('✔️'), ...glow('pulse', '#B8F0C8', 340) }),
      cut(190, { move: { dx: 0, dy: -24 } }),
      cut(700, { turn: 10, ...emote('🤔') }),
      cut(300, { turn: -10 }),
    ],
    [cut(600, { ...emote('📝'), ...glow('sweep', '#FFE9A8', 600, 'left-to-right') }), ...sway(1, 8, 300, emote('🔸'))],
  ],
  failed: [
    [
      cut(500, { shake: { amplitude: 4 }, ...emote('💦', 2), ...glow('pulse', '#6FA8FF', 500) }),
      cut(500, { turn: -8, ...squash(0.8), ...glow('sweep', '#4A6FA5', 500, 'top-to-bottom') }),
      cut(400, emote('💧')),
      cut(300, { turn: 8 }),
    ],
    withClip('downcast', (clip) => [
      clipCut(clip, DOWNCAST, emote('💧')),
      cut(500, { ...emote('💦'), ...glow('pulse', '#6FA8FF', 500) }),
    ]),
    [
      cut(1010, { shake: { amplitude: 3 }, ...emote('❌'), ...glow('blink', '#FF7A7A', 1010) }),
      cut(400, { turn: -6, ...emote('💦') }),
      cut(300, { turn: 6 }),
    ],
  ],
  asking: [
    [
      cut(350, { turn: 14, ...emote('❓'), ...glow('sweep', '#9AD8FF', 350, 'center-out') }),
      cut(700, emote('❔')),
      cut(300, { turn: -14 }),
      ...hop(1, 20),
    ],
    [
      cut(300, { turn: -14, ...emote('🤔') }),
      cut(800, { ...emote('❓', 2), ...glow('pulse', '#9AD8FF', 800) }),
      cut(300, { turn: 14 }),
    ],
  ],
  running: [
    [cut(900, { ...emote('⏳'), ...glow('pulse', '#C9B8FF', 900) }), ...sway(2, 6, 360, emote('💤'))],
    [cut(1000, { ...emote('⚙️'), ...glow('sweep', '#C9B8FF', 1000, 'left-to-right') }), cut(800, emote('⏳'))],
  ],
  sorry: [
    [
      cut(350, { turn: 18, ...squash(0.6), ...emote('🙇'), ...glow('pulse', '#FFB3C7', 350) }),
      cut(700, emote('💦')),
      cut(350, { turn: -18 }),
      cut(300, { turn: 18 }),
      cut(300, { turn: -18 }),
    ],
    withClip('downcast', (clip) => [
      clipCut(clip, DOWNCAST, emote('🙇')),
      cut(700, { ...emote('💦'), ...glow('pulse', '#FFB3C7', 700) }),
    ]),
    [
      cut(400, { turn: -10, ...emote('🙏') }),
      cut(700, { ...emote('💦'), ...glow('pulse', '#FFB3C7', 700) }),
      cut(400, { turn: 10 }),
    ],
  ],
  suggesting: [
    [...hop(1, 44, emote('💡')), cut(1010, { ...emote('✨'), ...glow('blink', '#FFE066', 1010) }), ...hop(1, 20)],
    [
      cut(400, { turn: 8, ...emote('💡'), ...glow('sweep', '#FFE066', 400, 'center-out') }),
      cut(600, emote('👉')),
      cut(300, { turn: -8 }),
      ...hop(1, 20),
    ],
  ],
  explaining: [
    [cut(900, { ...emote('📖'), ...glow('sweep', '#B8F0C8', 900, 'left-to-right') }), ...sway(2, 7, 320, emote('☝️'))],
    [cut(800, { ...emote('📝'), ...glow('sweep', '#B8F0C8', 800, 'top-to-bottom') }), ...hop(1, 16, emote('☝️'))],
  ],
  greeting: [
    [
      cut(340, { ...emote('👋'), ...glow('sweep', '#FFC98A', 340, 'center-out') }),
      ...hop(2, 28),
      ...sway(1, 12, 260, emote('💕')),
    ],
    withClip('pleased', (clip) => [clipCut(clip, PLEASED, emote('👋')), ...sway(1, 12, 260, emote('💕'))]),
    [
      cut(400, { ...emote('🙌'), ...glow('sweep', '#FFC98A', 400, 'bottom-to-top') }),
      ...hop(1, 24),
      cut(500, emote('✨', 2)),
    ],
  ],
  neutral: [],
};

// The ways this resident can react to the mood.
export const variantsFor = (mood: Mood, traits: Traits): ReadonlyArray<ReadonlyArray<Step>> =>
  REACTIONS[mood].flatMap((variant) => {
    const steps = typeof variant === 'function' ? variant(traits) : variant;
    return steps ? [steps] : [];
  });

// The reaction for the session's `turn`-th reply: consecutive replies take
// consecutive variants, so a mood never looks the same twice in a row.
export const reactionFor = (mood: Mood, traits: Traits, turn: number): ReadonlyArray<Step> | null => {
  const variants = variantsFor(mood, traits);
  return variants.length ? variants[Math.abs(Math.trunc(turn)) % variants.length]! : null;
};

// The moods whose reaction grows with the work behind them: finishing a long job is
// more to cheer than answering a quick question. The others say what kind of reply it
// is, which the work does not change.
const WEIGHED: ReadonlySet<Mood> = new Set(['done', 'partial']);
const MAX_POPS = 8;

const eased = (step: Step, pops: (count: number) => number, squash: number): Step => ({
  ...step,
  ...(step.kind === 'repeat' ? { steps: (step.steps as Step[]).map((inner) => eased(inner, pops, squash)) } : {}),
  ...(step.emote
    ? { emote: (step.emote as { count: number }[]).map((pop) => ({ ...pop, count: pops(pop.count) })) }
    : {}),
  ...(step.bounce
    ? {
        bounce: (step.bounce as { strength: number }[]).map((bounce) => ({
          ...bounce,
          strength: Math.min(1, Math.round(bounce.strength * squash * 100) / 100),
        })),
      }
    : {}),
});

// The same reaction for the work it follows. Light: one emoji at a time and shallow
// squashes. Heavy: more emoji, deeper squashes, and for work that is done an encore.
// Moves keep their size, so the run fits where the plain one does.
export const weighted = (mood: Mood, steps: ReadonlyArray<Step>, weight: Weight): ReadonlyArray<Step> => {
  if (weight === 'normal' || !WEIGHED.has(mood)) return steps;
  if (weight === 'light') return steps.map((step) => eased(step, () => 1, 0.6));
  const louder = steps.map((step) => eased(step, (count) => Math.min(MAX_POPS, count + 2), 1.4));
  return mood === 'done'
    ? [...louder, ...hop(2, 40, emote('🎉', 5)), cut(500, { ...emote('✨', 4), ...glow('pulse', '#FFD54A', 500) })]
    : louder;
};

// How a reaction lights, picked at random each time (the owner, 2026-11-15: every one of
// these looked fine, so none should win). `mood` keeps the lights written above; the
// others replace them. A rainbow only for the cheerful moods.
export const GLOW_STYLES = ['mood', 'own', 'rise', 'ring', 'rainbow', 'shower', 'sparkle'] as const;
export type GlowStyle = (typeof GLOW_STYLES)[number];
const CHEERFUL: ReadonlySet<Mood> = new Set(['done', 'greeting', 'suggesting']);
export const glowStylesFor = (mood: Mood): ReadonlyArray<GlowStyle> =>
  GLOW_STYLES.filter((style) => style !== 'rainbow' || CHEERFUL.has(mood));

type Light = { readonly shape: 'pulse' | 'sweep' | 'blink'; readonly color: string; readonly direction?: string };
const MIN_LIGHT_MS = 334;
const MIN_BLINK_MS = 1002;

// The lights of a style, one per cut, in the mood's colour where it has one.
const lightsOf = (style: Exclude<GlowStyle, 'mood'>, tint: string): ReadonlyArray<Light> => {
  switch (style) {
    case 'own':
      return [{ shape: 'pulse', color: 'source' }];
    case 'rise':
      return [
        { shape: 'sweep', color: 'source', direction: 'bottom-to-top' },
        { shape: 'pulse', color: tint },
      ];
    case 'ring':
      return [{ shape: 'sweep', color: '#FFFFFF', direction: 'center-out' }];
    case 'rainbow':
      return [
        { shape: 'sweep', color: '#FFD54A', direction: 'left-to-right' },
        { shape: 'sweep', color: '#FF9EC7', direction: 'left-to-right' },
        { shape: 'sweep', color: '#8FE3FF', direction: 'left-to-right' },
      ];
    case 'shower':
      return [{ shape: 'sweep', color: tint, direction: 'top-to-bottom' }];
    case 'sparkle':
      return [{ shape: 'blink', color: 'source' }];
  }
};

const firstTint = (steps: ReadonlyArray<Step>): string | undefined => {
  for (const step of steps) {
    const own = (step.glow as { color?: string }[] | undefined)?.[0]?.color;
    if (own) return own;
    if (step.kind === 'repeat') {
      const inner = firstTint(step.steps as Step[]);
      if (inner) return inner;
    }
  }
  return undefined;
};

const unlit = (step: Step): Step => {
  const { glow: _, ...rest } = step;
  return step.kind === 'repeat' ? { ...rest, steps: (step.steps as Step[]).map(unlit) } : rest;
};

// The reaction with the style's lights instead of its own: each light on the next held
// cut long enough for it, as long as that cut. A blink on a cut too short to blink
// swells once instead. Nothing long enough: the reaction keeps its own lights.
export const lit = (steps: ReadonlyArray<Step>, style: GlowStyle): ReadonlyArray<Step> => {
  if (style === 'mood') return steps;
  const lights = lightsOf(style, firstTint(steps) ?? '#FFF3B0');
  let next = 0;
  const out = steps.map((step) => {
    const bare = unlit(step);
    const holdMs = step.holdMs;
    if (next >= lights.length || step.kind !== 'cut' || typeof holdMs !== 'number' || holdMs < MIN_LIGHT_MS) {
      return bare;
    }
    const light = lights[next++]!;
    const shape = light.shape === 'blink' && holdMs < MIN_BLINK_MS ? 'pulse' : light.shape;
    return { ...bare, glow: [{ select: 'all', ...light, shape, durationMs: holdMs }] };
  });
  return next ? out : steps;
};

// A sequence the user saved for the resident's asset under this name plays instead
// of the built-in reaction.
export const savedName = (mood: Mood) => `emote.${mood}`;

// The resident's own motion for a message (its speak hook), as a run: what a reply gets
// when it is not judged. A built-in action, its animation played once, or its saved
// sequence by name; null for `none`.
export type Run = { readonly steps: ReadonlyArray<Step> } | { readonly name: string };
export const ownMotion = (speak: SpeakHook): Run | null =>
  speak === 'none'
    ? null
    : 'builtin' in speak
      ? { steps: [{ kind: 'action', action: speak.builtin }] }
      : 'motion' in speak
        ? { steps: [{ kind: 'cut', animation: speak.motion, cycles: 1, easing: 'smooth' }] }
        : { name: speak.sequence };

// How the own motion reads in the log.
export const speakLabel = (speak: SpeakHook): string =>
  speak === 'none'
    ? 'none'
    : 'builtin' in speak
      ? speak.builtin
      : 'motion' in speak
        ? `motion:${speak.motion}`
        : `sequence:${speak.sequence}`;

// At most this much of the reply is judged, and handed to the reactor.
export const MAX_JUDGED_CHARS = 2000;

// How long a clip's cut holds instead, for a resident whose motion is off.
const CLIP_HOLD_MS = 700;

// The same run for a resident whose motion the user turned off: the CLI refuses its
// turns, shakes and clips, but lets the rest (emotes, lights, moves) play. A clip's
// cut holds still for a moment instead.
export const withoutMotion = (steps: ReadonlyArray<Step>): ReadonlyArray<Step> =>
  steps.flatMap((step): Step[] => {
    if (step.kind === 'repeat') return [{ ...step, steps: withoutMotion(step.steps as Step[]) }];
    if (step.kind !== 'cut') return [];
    const { turn: _turn, shake: _shake, animation, cycles: _cycles, look: _look, ...rest } = step;
    return [animation ? { ...rest, holdMs: CLIP_HOLD_MS } : rest];
  });

// The same run, raised by `dy` first and lowered after: a resident on the floor has no
// room below it.
export const lifted = (steps: ReadonlyArray<Step>, dy: number): ReadonlyArray<Step> => [
  cut(140, { move: { dx: 0, dy } }),
  ...steps,
  cut(160, { move: { dx: 0, dy: -dy } }),
];

// How far a refused run went past the screen's bottom, from the CLI's words.
export const pastBottom = (explanation: string | undefined): number | null => {
  const pt = Number(explanation?.match(/past its bottom by ([\d.]+) pt/)?.[1]);
  return pt > 0 ? pt : null;
};

// The questions put to the judge about a reply.
export const JUDGE = {
  state: (reply: string) => ({
    context:
      'An AI coding assistant ends its turn by saying this to the developer through a tiny pixel-art pet on the desktop. The pet also reacts once, so the developer can tell the gist at a glance.',
    said: reply.slice(0, MAX_JUDGED_CHARS),
  }),
  questions: {
    react: {
      type: 'boolean',
      instructions: 'Does this have a clear outcome or intent worth a small visible reaction?',
      criteria: {
        true: 'work finished or partly finished, something failed, the assistant asks the developer something, left something running, apologizes, proposes, explains findings, or greets',
        false: 'filler or no clear outcome',
      },
    },
    mood: {
      type: 'choice',
      instructions: 'Which reaction fits it best?',
      criteria: {
        done: 'the requested work is completed and verified successfully',
        partial:
          'part of the work is done, or it is done but could not be verified, or the assistant leaves steps for later',
        failed: 'an error, failure, blocker, or the work could not be finished',
        asking: 'ends by asking the developer a question or for a decision',
        running:
          "started something that keeps running after this message (a build, a job, another agent) and will report back; not merely waiting for the developer's next message",
        sorry: 'apologizes or admits a mistake',
        suggesting: 'mainly offers an idea, opinion or recommendation',
        explaining: 'mainly explains or reports findings without a decision needed',
        greeting: 'hello or goodbye',
        neutral: 'none of the above',
      },
    },
  },
} as const;

export const JUDGE_INTENSITY = {
  type: 'score',
  instructions: 'How weighty is this reply, on a scale of 1 to 5?',
  criteria: [
    '1 - routine acknowledgment, brief filler, or tiny clarification',
    '2 - small completed edit, quick answer, or minor status update',
    '3 - normal completed task, substantive explanation, or standard question',
    '4 - meaningful multi-file milestone, important warning, or notable bug fix',
    '5 - major feature shipped, full suite verified after hard work, or critical failure',
  ],
} as const;

// The judge's score is 0-based (0...4 for the five lines above, its expectation over them).
// A routine reply (up to 2.5 of 5) reacts lightly whatever the turn took; a weighty one
// (from 3.5) reacts heavily even after a short turn; between, the turn's length decides.
export const weightOfIntensity = (score: number | undefined): Weight | null => {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const outOfFive = score + 1;
  return outOfFive <= 2.5 ? 'light' : outOfFive >= 3.5 ? 'heavy' : null;
};
