// The emote extension: its settings, its reactions as the CLI will take them, the run
// on a fake desk and judge, and the built pixling-proxy against the fake CLI and
// a judge served from this process.
import { assert, describe, it } from '@effect/vitest';
import { test } from 'vite-plus/test';
import nodeAssert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Effect, Layer, Random } from 'effect';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, emoteConfig } from '../src/extensions/emote/config.ts';
import { Judge, JudgeError } from '../src/extensions/emote/Judge.ts';
import {
  AFTER_ALWAYS_MS,
  EMOJI,
  emojiFor,
  MIN_GAP_MS,
  SAME_KIND_GAP_MS,
  HEAVY_FROM_MS,
  LIGHT_UNDER_MS,
  statusFor,
  toolKind,
  type Weight,
  weightOf,
} from '../src/extensions/emote/during.ts';
import { react } from '../src/extensions/emote/react.ts';
import {
  lifted,
  MOOD_EMOJI,
  MOODS,
  type Mood,
  NO_TRAITS,
  pastBottom,
  reactionFor,
  savedName,
  type Traits,
  traitsOf,
  variantsFor,
  GLOW_STYLES,
  glowStylesFor,
  lit,
  weighted,
  weightOfIntensity,
  withoutMotion,
} from '../src/extensions/emote/reactions.ts';
import { CurrentSession, Expression, SessionStore } from '../src/core/services.ts';
import { EmoteExpression } from '../src/extensions/emote/index.ts';
import { SessionLocks } from '../src/runtimes/SessionFiles.ts';
import { DEFAULT_SPEAK, Desk, DeskError, type SpeakHook } from '../src/pixling/Desk.ts';

describe('emote settings', () => {
  it('needs a key, from the settings or the environment', () => {
    assert.isNull(emoteConfig({ emote: {} }, {}));
    assert.deepStrictEqual(emoteConfig({ emote: {} }, { AI_GATEWAY_API_KEY: ' k ' }), {
      endpoint: DEFAULT_ENDPOINT,
      model: DEFAULT_MODEL,
      apiKey: 'k',
      threshold: 0.5,
    });
    assert.strictEqual(
      emoteConfig({ emote: { apiKeyEnv: 'MINE' } }, { MINE: 'm', AI_GATEWAY_API_KEY: 'k' })?.apiKey,
      'm',
    );
    assert.strictEqual(emoteConfig({ emote: { apiKey: 'own', apiKeyEnv: 'MINE' } }, { MINE: 'm' })?.apiKey, 'own');
  });

  it('is off without an emote object, whatever the environment holds', () => {
    assert.isNull(emoteConfig({}, { AI_GATEWAY_API_KEY: 'k' }));
    assert.isNull(emoteConfig({ emote: 'nonsense' }, { AI_GATEWAY_API_KEY: 'k' }));
  });

  it('sends the key over plain http only to this machine', () => {
    assert.isNull(emoteConfig({ emote: { apiKey: 'k', endpoint: 'http://judge.example/v4/ai' } }, {}));
    assert.isNull(emoteConfig({ emote: { apiKey: 'k', endpoint: 'not a url' } }, {}));
    assert.strictEqual(emoteConfig({ emote: { apiKey: 'k', endpoint: 'http://127.0.0.1:9/v4/ai' } }, {})?.apiKey, 'k');
    assert.strictEqual(emoteConfig({ emote: { apiKey: 'k', endpoint: 'http://localhost/v4/ai' } }, {})?.apiKey, 'k');
  });

  it('a wrong value keeps its default, and costs nothing else', () => {
    const config = emoteConfig(
      { emote: { endpoint: 'https://judge.example/v1///', model: 42, threshold: 2, apiKey: 'k' } },
      {},
    );
    assert.deepStrictEqual(config, {
      endpoint: 'https://judge.example/v1',
      model: DEFAULT_MODEL,
      apiKey: 'k',
      threshold: 0.5,
    });
  });
});

type Step = Record<string, any>;
const POKE = [{ kind: 'action', action: 'poke' }];

const cutsOf = (steps: ReadonlyArray<Step>): Step[] =>
  steps.flatMap((step) =>
    step.kind === 'repeat' ? Array.from({ length: step.times }, () => cutsOf(step.steps)).flat() : [step],
  );

const CLIPPED: Traits = { pleased: 'motion-1', downcast: 'motion-1' };
const clipsNamed = (...names: string[]) => names.map((name, i) => ({ id: i ? `m${i + 1}` : 'idle', name, motion: '' }));
// Every way any resident can react, by mood.
const everyVariant = () =>
  MOODS.flatMap((mood) =>
    [NO_TRAITS, CLIPPED].flatMap((traits) =>
      variantsFor(mood, traits).flatMap((plain) =>
        (['light', 'normal', 'heavy'] as const).map((weight) => ({ mood, steps: weighted(mood, plain, weight) })),
      ),
    ),
  );

describe('reactions', () => {
  it('fit what sequence.start takes', () => {
    for (const { mood, steps } of everyVariant()) {
      for (const plan of [lifted(steps, 40), lifted(withoutMotion(steps), 40)]) {
        const cuts = cutsOf(plan);
        assert.isAtMost(plan.length, 32, mood);
        assert.isAtMost(
          cuts.reduce((ms, cut) => ms + (cut.holdMs ?? 0), 0),
          30_000,
          mood,
        );
        assert.isAtMost(
          cuts.reduce((n, cut) => n + (cut.bounce?.length ?? 0), 0),
          32,
          `${mood}: squashes in a run`,
        );
        for (const cut of cuts) {
          for (const squash of cut.bounce ?? []) {
            assert.isAbove(squash.strength, 0, mood);
            assert.isAtMost(squash.strength, 1, mood);
          }
          // A cut has exactly one of a clip and a hold.
          assert.notStrictEqual('animation' in cut, 'holdMs' in cut, `${mood}: clip or hold`);
          if ('holdMs' in cut) assert.isAtMost(cut.holdMs, 10_000, mood);
          for (const light of cut.glow ?? []) {
            assert.property(cut, 'holdMs', `${mood}: a light stays out of a clip, whose length varies`);
            assert.isAtLeast(light.durationMs, light.shape === 'blink' ? 1002 : 334, `${mood} ${light.shape}`);
            assert.isAtMost(light.durationMs, cut.holdMs, `${mood}: a light ends inside its cut`);
          }
        }
      }
    }
  });

  it('end where they started', () => {
    for (const { mood, steps } of everyVariant()) {
      const cuts = cutsOf(steps);
      const dy = cuts.reduce((sum, cut) => sum + (cut.move?.dy ?? 0), 0);
      const turn = cuts.reduce((sum, cut) => sum + (cut.turn ?? 0), 0);
      assert.strictEqual(dy, 0, `${mood} moves back`);
      assert.strictEqual(turn % 360, 0, `${mood} turns back`);
    }
  });

  it('every mood but neutral has two ways or more, so the same mood twice looks different', () => {
    for (const mood of MOODS) {
      if (mood === 'neutral') {
        assert.isNull(reactionFor(mood, CLIPPED, 0));
        continue;
      }
      assert.isAtLeast(variantsFor(mood, NO_TRAITS).length, 2, mood);
      for (const traits of [NO_TRAITS, CLIPPED]) {
        for (let turn = 0; turn < 6; turn++) {
          assert.notDeepEqual(reactionFor(mood, traits, turn), reactionFor(mood, traits, turn + 1), `${mood} ${turn}`);
        }
      }
    }
  });

  it("borrows the resident's own clip only when it has one", () => {
    const clipped = MOODS.flatMap((mood) => variantsFor(mood, CLIPPED)).filter((steps) =>
      JSON.stringify(steps).includes('"animation":"motion-1"'),
    );
    assert.isAbove(clipped.length, 0);
    assert.notInclude(JSON.stringify(MOODS.flatMap((mood) => variantsFor(mood, NO_TRAITS))), 'animation');
  });

  it('borrows a clip whose words suit the feeling, and the usual motion otherwise', () => {
    assert.deepStrictEqual(traitsOf([]), NO_TRAITS);
    assert.deepStrictEqual(traitsOf(clipsNamed('いきをする')), { pleased: 'idle', downcast: 'idle' });
    assert.deepStrictEqual(traitsOf(clipsNamed('いきをする', 'ダンス')), { pleased: 'm2', downcast: 'idle' });
    assert.deepStrictEqual(traitsOf(clipsNamed('Idle', 'Walk', 'Fluster', 'Jump')), { pleased: 'm4', downcast: 'm3' });
    assert.deepStrictEqual(traitsOf(clipsNamed('呼吸', '開心跳舞', '難過')), { pleased: 'm2', downcast: 'm3' });
    assert.deepStrictEqual(traitsOf(clipsNamed('숨쉬기', '춤추기', '시무룩')), { pleased: 'm2', downcast: 'm3' });
    // A name decides before a sentence, where such a word can turn up by the way.
    assert.strictEqual(
      traitsOf([
        { id: 'idle', name: 'いきをする', motion: 'ジャンプはしない' },
        { id: 'm2', name: 'ダンス', motion: '' },
      ]).pleased,
      'm2',
    );
    assert.strictEqual(traitsOf([{ id: 'idle', name: '', motion: 'does a little dance' }]).pleased, 'idle');
    // Whole words only: a shop is no hop.
    assert.deepStrictEqual(traitsOf(clipsNamed('Idle', 'Shop idle', 'Unhappy', 'Saddle up')), {
      pleased: 'idle',
      downcast: 'idle',
    });
    const dances = JSON.stringify(reactionFor('done', traitsOf(clipsNamed('いきをする', 'ダンス')), 1));
    assert.include(dances, '"animation":"m2"');
    assert.include(
      JSON.stringify(reactionFor('failed', traitsOf(clipsNamed('いきをする', 'ダンス')), 1)),
      '"animation":"idle"',
    );
  });

  it('a hop squashes as it leaves the floor and as it lands, deeper the higher it goes', () => {
    const bounces = (steps: ReadonlyArray<Step>) => cutsOf(steps).flatMap((cut) => cut.bounce ?? []);
    for (const mood of ['done', 'asking', 'suggesting', 'greeting'] as const) {
      for (const steps of variantsFor(mood, NO_TRAITS)) {
        const hops = cutsOf(steps).filter((cut) => (cut.move?.dy ?? 0) > 0).length;
        if (hops) assert.isAbove(bounces(steps).length, hops, mood);
      }
    }
    assert.isAbove(bounces(reactionFor('done', NO_TRAITS, 0)!).length, 0);
    // Motion off: the desk skips a squash itself, so it stays in the plan.
    assert.include(JSON.stringify(withoutMotion(reactionFor('done', NO_TRAITS, 0)!)), '"bounce"');
  });

  it('relights every reaction in every style within the desk rules, and leaves `mood` alone', () => {
    const lights = (steps: ReadonlyArray<Step>) =>
      cutsOf(steps).flatMap((cut) => (cut.glow ?? []).map((g: Step) => ({ g, cut })));
    for (const mood of MOODS) {
      assert.notInclude(
        mood === 'done' || mood === 'greeting' || mood === 'suggesting' ? [] : glowStylesFor(mood),
        'rainbow',
      );
      for (const steps of [NO_TRAITS, CLIPPED].flatMap((traits) => variantsFor(mood, traits))) {
        assert.deepStrictEqual(lit(steps, 'mood'), steps);
        for (const style of GLOW_STYLES) {
          const relit = lights(lit(steps, style));
          if (lights(steps).length) assert.isAbove(relit.length, 0, `${mood} ${style}`);
          for (const { g, cut } of relit) {
            assert.strictEqual(g.durationMs, cut.holdMs);
            assert.isAtLeast(g.durationMs, g.shape === 'blink' ? 1002 : 334);
          }
          // The moves, emotes and squashes stay as they were.
          const bare = (xs: ReadonlyArray<Step>) => JSON.stringify(cutsOf(xs).map(({ glow: _, ...rest }) => rest));
          assert.strictEqual(bare(lit(steps, style)), bare(steps));
        }
      }
    }
  });

  it('grows with the work behind it: quiet after a quick answer, an encore after a long job', () => {
    assert.strictEqual(weightOf(null, 5), 'normal');
    assert.strictEqual(weightOf(0, LIGHT_UNDER_MS - 1), 'light');
    assert.strictEqual(weightOf(0, LIGHT_UNDER_MS), 'normal');
    assert.strictEqual(weightOf(0, HEAVY_FROM_MS), 'heavy');
    // The judge's 0-based score, out of five: routine light, weighty heavy, between unsaid.
    assert.deepStrictEqual([undefined, 0, 1.5, 2, 2.5, 4].map(weightOfIntensity), [
      null,
      'light',
      'light',
      null,
      'heavy',
      'heavy',
    ]);
    const pops = (steps: ReadonlyArray<Step>) =>
      cutsOf(steps)
        .flatMap((cut) => cut.emote ?? [])
        .map((pop) => pop.count);
    const deepest = (steps: ReadonlyArray<Step>) =>
      Math.max(
        ...cutsOf(steps)
          .flatMap((cut) => cut.bounce ?? [])
          .map((squash) => squash.strength),
      );
    const done = reactionFor('done', NO_TRAITS, 0)!;
    assert.strictEqual(weighted('done', done, 'normal'), done);
    const light = weighted('done', done, 'light');
    const heavy = weighted('done', done, 'heavy');
    assert.isTrue(pops(light).every((count) => count === 1));
    assert.isBelow(deepest(light), deepest(done));
    assert.isAbove(cutsOf(heavy).length, cutsOf(done).length);
    assert.isAbove(Math.max(...pops(heavy)), Math.max(...pops(done)));
    // A light or heavy turn leaves a mood that only says what kind of reply it is alone.
    const asking = reactionFor('asking', NO_TRAITS, 0)!;
    assert.strictEqual(weighted('asking', asking, 'heavy'), asking);
    assert.strictEqual(weighted('failed', reactionFor('failed', NO_TRAITS, 0)!, 'light').length, 4);
  });

  it('every mood but neutral has an emoji of its own', () => {
    for (const mood of MOODS) assert.strictEqual(MOOD_EMOJI[mood] === null, mood === 'neutral', mood);
  });

  it('without motion, a clip holds still and no turn or shake is left', () => {
    for (const { steps } of everyVariant()) {
      const still = JSON.stringify(withoutMotion(steps));
      for (const word of ['animation', 'turn', 'shake', 'look']) assert.notInclude(still, `"${word}"`);
    }
  });

  it('reads how far a run went past the bottom', () => {
    assert.strictEqual(pastBottom('the path goes past its bottom by 12.5 pt; lift it'), 12.5);
    assert.isNull(pastBottom('busy'));
    assert.isNull(pastBottom(undefined));
  });
});

describe('during the turn', () => {
  it('sorts tools as the hosts name them, and leaves out the resident itself', () => {
    const kinds = {
      Read: 'read',
      Grep: 'read',
      read_file: 'read',
      Edit: 'write',
      apply_patch: 'write',
      Write: 'write',
      Bash: 'run',
      exec_command: 'run',
      WebFetch: 'web',
      WebSearch: 'web',
      Task: 'delegate',
      Agent: 'delegate',
      TaskCreate: null,
      TaskUpdate: null,
      get_thread: null,
      mcp__files__read_text: 'read',
      mcp__browser__read_page: 'web',
      AskUserQuestion: 'ask',
      TodoWrite: null,
      mcp__pixling__pixling_message_send: null,
      Skill: null,
    } as const;
    for (const [name, kind] of Object.entries(kinds)) assert.strictEqual(toolKind(name), kind, name);
  });

  it('shows a new kind of tool, not too soon, and the same kind only now and then', () => {
    const read = { kind: 'tool', name: 'Read' } as const;
    const edit = { kind: 'tool', name: 'Edit' } as const;
    assert.deepStrictEqual(emojiFor(read, undefined, 0), { kind: 'read', text: EMOJI.read });
    assert.isNull(emojiFor(edit, { kind: 'read', at: 0 }, MIN_GAP_MS - 1));
    assert.deepStrictEqual(emojiFor(edit, { kind: 'read', at: 0 }, MIN_GAP_MS), { kind: 'write', text: EMOJI.write });
    assert.isNull(emojiFor(read, { kind: 'read', at: 0 }, SAME_KIND_GAP_MS - 1));
    assert.isNotNull(emojiFor(read, { kind: 'read', at: 0 }, SAME_KIND_GAP_MS));
    assert.isNull(emojiFor({ kind: 'tool', name: 'TodoWrite' }, undefined, 0));
  });

  it('names a state for the turn and for a kind of tool, only among those the asset has a look for', () => {
    const read = { kind: 'tool', name: 'Read' } as const;
    assert.isNull(statusFor({ kind: 'turn' }, []));
    assert.isNull(statusFor(read, ['working.write', 'asking']));
    assert.strictEqual(statusFor({ kind: 'turn' }, ['working', 'working.read']), 'working');
    assert.strictEqual(statusFor(read, ['working', 'working.read']), 'working.read');
    assert.strictEqual(statusFor({ kind: 'tool', name: 'Bash' }, ['working', 'working.read']), 'working');
    // A tool that pops no emoji (the agent's own notes) keeps the turn's state.
    assert.strictEqual(statusFor({ kind: 'tool', name: 'TodoWrite' }, ['working', 'working.write']), 'working');
    assert.isNull(statusFor({ kind: 'permission', question: 'Allow Bash?' }, ['working']));
    assert.isNull(statusFor({ kind: 'end' }, ['working']));
    assert.isNull(emojiFor({ kind: 'end' }, undefined, 0));
  });

  it("a turn's start and a permission prompt always show, and hold tools back only while their emoji floats", () => {
    const last = { kind: 'turn', at: 0 };
    assert.deepStrictEqual(emojiFor({ kind: 'turn' }, last, 1), { kind: 'turn', text: EMOJI.turn });
    assert.deepStrictEqual(emojiFor({ kind: 'permission', question: 'Allow Bash?' }, last, 1), {
      kind: 'permission',
      text: EMOJI.permission,
    });
    assert.isNull(emojiFor({ kind: 'tool', name: 'Read' }, last, AFTER_ALWAYS_MS - 1));
    assert.isNotNull(emojiFor({ kind: 'tool', name: 'Read' }, last, AFTER_ALWAYS_MS));
  });
});

describe('EmoteExpression', () => {
  // The extension for one session, with emote settings on and the session's lock
  // taken or free.
  const expression = (lockFree: boolean, statuses: ReadonlyArray<string> = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-emote-expression-'));
    fs.mkdirSync(path.join(dir, 'pixling'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pixling/proxy.json'), JSON.stringify({ emote: { apiKey: 'k' } }));
    process.env.XDG_CONFIG_HOME = dir;
    const popped: string[] = [];
    const states: string[] = [];
    // `unseen`: how many pops the desk refuses first, the resident not showing yet.
    const hooks: { onStatus?: (memos: Map<string, unknown>) => void; unseen?: number } = {};
    let described = 0;
    const memos = new Map<string, unknown>();
    const layer = EmoteExpression.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CurrentSession)({ namespace: 't', key: 'k', author: 'T', selector: 'client:t/k' }),
          Layer.succeed(SessionStore)({
            memo: (name: string) => Effect.sync(() => memos.get(name)),
            setMemo: (name: string, value: unknown) => Effect.sync(() => void memos.set(name, value)),
          } as unknown as SessionStore['Service']),
          Layer.succeed(SessionLocks)({
            lock: () => Effect.succeed(lockFree),
            unlock: () => Effect.void,
          } as unknown as SessionLocks['Service']),
          Layer.succeed(Desk)({
            emote: ({ text }: { text: string }) =>
              Effect.suspend(() => {
                if (hooks.unseen && hooks.unseen-- > 0) {
                  return Effect.fail(
                    new DeskError({ operation: 'resident.emote', reason: 'refused', detail: 'notVisible' }),
                  );
                }
                popped.push(text);
                return Effect.void;
              }),
            traits: () =>
              Effect.sync(() => {
                described += 1;
                return { statuses };
              }),
            status: (state: { name?: string }) =>
              Effect.sync(() => {
                states.push(state.name ?? 'clear');
                hooks.onStatus?.(memos);
              }),
          } as unknown as Desk['Service']),
        ),
      ),
    );
    return { popped, states, layer, hooks, described: () => described };
  };

  it.effect('a resident it creates moves, so its reactions and states can show', () => {
    const { layer } = expression(true);
    return Effect.gen(function* () {
      assert.deepStrictEqual((yield* Expression).initialSettings, { motionEnabled: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect('shows a state for the turn and each kind of tool the asset has a look for, and clears it', () => {
    const { states, layer, described } = expression(true, ['working', 'working.write', 'asking']);
    return Effect.gen(function* () {
      const e = yield* Expression;
      assert.isNull(yield* e.askingStatus);
      yield* e.noticed({ kind: 'turn' });
      assert.strictEqual(yield* e.askingStatus, 'asking');
      // No look of its own: plain `working`, which shows already.
      yield* e.noticed({ kind: 'tool', name: 'Read' });
      yield* e.noticed({ kind: 'tool', name: 'Edit' });
      yield* e.noticed({ kind: 'tool', name: 'Write' });
      // The card carries its own state, and the desk brings this one back after it.
      yield* e.noticed({ kind: 'permission', question: 'Allow Bash?' });
      yield* e.noticed({ kind: 'tool', name: 'Bash' });
      yield* e.noticed({ kind: 'end' });
      yield* e.noticed({ kind: 'end' });
      assert.deepStrictEqual(states, ['working', 'working.write', 'working', 'clear']);
      // The looks are read once a turn, never per tool call.
      assert.strictEqual(described(), 1);
      // A host that tells no turn's start: read at the first tool call instead.
      yield* e.noticed({ kind: 'tool', name: 'Edit' });
      yield* e.noticed({ kind: 'tool', name: 'Read' });
      assert.deepStrictEqual(states.slice(4), ['working.write', 'working']);
      assert.strictEqual(described(), 2);
      // A turn whose last moment is a permission prompt still ends clear.
      yield* e.noticed({ kind: 'permission', question: 'Allow Bash?' });
      yield* e.noticed({ kind: 'end' });
      assert.deepStrictEqual(states.slice(6), ['clear']);
    }).pipe(Effect.provide(layer));
  });

  it.live("a new resident's wave waits for it to show; any other moment does not", () => {
    const { popped, layer, hooks } = expression(true);
    return Effect.gen(function* () {
      const e = yield* Expression;
      hooks.unseen = 2;
      yield* e.noticed({ kind: 'start' });
      assert.deepStrictEqual(popped, [EMOJI.start]);
      hooks.unseen = 1;
      yield* e.noticed({ kind: 'turn' });
      assert.deepStrictEqual(popped, [EMOJI.start]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a tool call's state that lands after the turn ended is taken back", () => {
    const { states, layer, hooks } = expression(true, ['working']);
    return Effect.gen(function* () {
      const e = yield* Expression;
      // The turn ends (in another process) while the state is on its way to the desk.
      hooks.onStatus = (memos) => {
        hooks.onStatus = undefined;
        memos.set('emote-status', { defined: null, name: null, at: Date.now() + 1000 });
      };
      yield* e.noticed({ kind: 'tool', name: 'Read' });
      assert.deepStrictEqual(states, ['working', 'clear']);
    }).pipe(Effect.provide(layer));
  });

  it.effect('an asset with no looks costs one read a turn and no state at all', () => {
    const { states, layer, described } = expression(true);
    return Effect.gen(function* () {
      const e = yield* Expression;
      yield* e.noticed({ kind: 'turn' });
      yield* e.noticed({ kind: 'tool', name: 'Read' });
      yield* e.noticed({ kind: 'end' });
      assert.isNull(yield* e.askingStatus);
      assert.deepStrictEqual([states, described()], [[], 1]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a tool call while another process is deciding shows nothing; a turn and a prompt still show', () => {
    const { popped, layer } = expression(false);
    return Effect.gen(function* () {
      const e = yield* Expression;
      yield* e.noticed({ kind: 'tool', name: 'Read' });
      yield* e.noticed({ kind: 'turn' });
      yield* e.noticed({ kind: 'permission', question: 'Allow Bash?' });
      assert.deepStrictEqual(popped, [EMOJI.turn, EMOJI.permission]);
    }).pipe(Effect.provide(layer));
  });
});

describe('react', () => {
  // A refusal: the CLI's words, or `motionOff`.
  const harness = (options: {
    mood?: Mood | null | 'fails';
    weight?: Weight | null;
    // Where the random pick of a lighting style lands, 0...1: 0 keeps the mood's own.
    pick?: number;
    refusals?: ReadonlyArray<string>;
    speak?: SpeakHook;
    clips?: ReadonlyArray<string>;
    named?: ReadonlyArray<{ id: string; name: string; motion: string }>;
    saved?: ReadonlyArray<string>;
    inView?: boolean;
    questionOpen?: boolean;
  }) => {
    const refusals = [...(options.refusals ?? [])];
    const runs: unknown[] = [];
    const pops: unknown[] = [];
    let judged = 0;
    const memos = new Map<string, unknown>();
    const layer = Layer.mergeAll(
      Layer.succeed(Random.Random)({ nextIntUnsafe: () => 0, nextDoubleUnsafe: () => options.pick ?? 0 }),
      Layer.succeed(SessionStore)({
        memo: (name: string) => Effect.sync(() => memos.get(name)),
        setMemo: (name: string, value: unknown) => Effect.sync(() => void memos.set(name, value)),
      } as unknown as SessionStore['Service']),
      Layer.succeed(Judge)({
        verdictOf: () =>
          Effect.suspend(() => {
            judged += 1;
            return options.mood === 'fails'
              ? Effect.fail(new JudgeError({ cause: new Error('down') }))
              : Effect.succeed({ mood: options.mood ?? null, weight: options.weight ?? null });
          }),
        worthSaying: () => Effect.succeed([]),
      }),
      Layer.succeed(Desk)({
        traits: () =>
          Effect.succeed({
            speak: options.speak ?? DEFAULT_SPEAK,
            clips: options.named ?? (options.clips ?? []).map((id) => ({ id, name: '', motion: '' })),
            inView: options.inView ?? true,
            questionOpen: options.questionOpen ?? false,
            statuses: [],
          }),
        emote: (pop: { text: string; count?: number }) => Effect.sync(() => void pops.push([pop.text, pop.count])),
        savedSequences: () => Effect.succeed(options.saved ?? []),
        sequence: (run: { steps?: ReadonlyArray<unknown>; name?: string }) =>
          Effect.suspend(() => {
            runs.push(run.steps ?? run.name);
            const refusal = refusals.shift();
            return refusal
              ? Effect.fail(
                  refusal === 'motionOff' || refusal === 'busy'
                    ? new DeskError({ operation: 'sequence.start', reason: 'refused', detail: refusal })
                    : refusal === 'held'
                      ? new DeskError({
                          operation: 'sequence.start',
                          reason: 'refused',
                          detail: 'busy',
                          explanation: HELD,
                        })
                      : new DeskError({ operation: 'sequence.start', reason: 'refused', explanation: refusal }),
                )
              : Effect.void;
          }),
      } as unknown as Desk['Service']),
    );
    return { runs, pops, layer, memos, judged: () => judged };
  };
  // The desk's words for a resident with a card of the user's open on it.
  const HELD = "the user has this resident's inbox, a question or its settings card open";
  const plain = (mood: Mood, turn = 0) => reactionFor(mood, NO_TRAITS, turn)!;

  it.effect('a resident with a dance dances when the work is done, and droops in its usual motion', () => {
    const named = clipsNamed('いきをする', 'ダンス');
    const done = harness({ mood: 'done', named });
    const failed = harness({ mood: 'failed', named });
    // The second way to react is the one that borrows a clip.
    done.memos.set('emote-variants', { done: 1 });
    failed.memos.set('emote-variants', { failed: 1 });
    return Effect.gen(function* () {
      yield* react('client:t/k', 'Done.').pipe(Effect.provide(done.layer));
      yield* react('client:t/k', 'It broke.').pipe(Effect.provide(failed.layer));
      assert.include(JSON.stringify(done.runs[0]), '"animation":"m2"');
      assert.include(JSON.stringify(failed.runs[0]), '"animation":"idle"');
    });
  });

  it.effect('plays the reaction for the work the turn was', () => {
    const { runs, layer } = harness({ mood: 'done' });
    return react('client:t/k', 'Done.', 'heavy').pipe(
      Effect.provide(layer),
      Effect.map(() => assert.deepStrictEqual(runs, [weighted('done', plain('done'), 'heavy')])),
    );
  });

  it.effect('a resident no window shows gets no reaction, and its reply is never judged', () => {
    const { runs, pops, layer, judged } = harness({ mood: 'done', inView: false });
    return react('client:t/k', 'Done.').pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.strictEqual(judged(), 0);
        assert.deepStrictEqual([runs, pops], [[], []]);
      }),
    );
  });

  it.effect('with a question waiting on the resident, pops ❓ without judging or starting a run', () => {
    const { runs, pops, layer, judged } = harness({ mood: 'done', questionOpen: true });
    return react('client:t/k', 'Which one?').pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.strictEqual(judged(), 0);
        assert.deepStrictEqual([runs, pops], [[], [[MOOD_EMOJI.asking, 2]]]);
      }),
    );
  });

  it.effect("held by a card of the user's, pops the mood's emoji at once instead of a run or a poke", () => {
    const { runs, pops, layer } = harness({ mood: 'done', refusals: ['held'] });
    return react('client:t/k', 'Done.').pipe(
      Effect.provide(layer),
      Effect.map(() => assert.deepStrictEqual([runs, pops], [[plain('done')], [[MOOD_EMOJI.done, 2]]])),
    );
  });

  it.effect('lights each reaction in a style picked at random', () => {
    const last = harness({ mood: 'done', pick: 0.999 });
    return react('client:t/k', 'x').pipe(
      Effect.provide(last.layer),
      Effect.map(() => assert.deepStrictEqual(last.runs, [lit(plain('done'), 'sparkle')])),
    );
  });

  it.effect("takes the reply's own weight over the turn's length, and the length when it gives none", () => {
    const routine = harness({ mood: 'done', weight: 'light' });
    const unsaid = harness({ mood: 'done', weight: null });
    return Effect.gen(function* () {
      yield* react('client:t/k', 'x', 'heavy').pipe(Effect.provide(routine.layer));
      yield* react('client:t/k', 'x', 'heavy').pipe(Effect.provide(unsaid.layer));
      assert.deepStrictEqual(routine.runs, [weighted('done', plain('done'), 'light')]);
      assert.deepStrictEqual(unsaid.runs, [weighted('done', plain('done'), 'heavy')]);
    });
  });

  it.effect('takes the next way for each mood each time, whatever came between', () => {
    let mood: Mood = 'done';
    const { runs, layer, memos } = harness({ clips: ['motion-1'] });
    const judged = Layer.succeed(Judge)({
      verdictOf: () => Effect.sync(() => ({ mood, weight: null })),
      worthSaying: () => Effect.succeed([]),
    });
    const again = (next: Mood) =>
      Effect.suspend(() => {
        mood = next;
        return react('client:t/k', 'x').pipe(Effect.provide(Layer.merge(layer, judged)));
      });
    return Effect.gen(function* () {
      yield* again('done');
      yield* again('explaining');
      yield* again('done');
      assert.deepStrictEqual(runs, [
        reactionFor('done', CLIPPED, 0),
        reactionFor('explaining', CLIPPED, 0),
        reactionFor('done', CLIPPED, 1),
      ]);
      assert.deepStrictEqual(memos.get('emote-variants'), { done: 2, explaining: 1 });
    });
  });

  it.effect('plays a sequence saved for the mood instead, and the built-in one when it is refused', () => {
    const saved = harness({ mood: 'done', saved: [savedName('done')] });
    const refused = harness({ mood: 'done', saved: [savedName('done')], refusals: ['nope'] });
    const other = harness({ mood: 'failed', saved: [savedName('done')] });
    return Effect.gen(function* () {
      yield* react('client:t/k', 'x').pipe(Effect.provide(saved.layer));
      yield* react('client:t/k', 'x').pipe(Effect.provide(refused.layer));
      yield* react('client:t/k', 'x').pipe(Effect.provide(other.layer));
      assert.deepStrictEqual(saved.runs, ['emote.done']);
      assert.deepStrictEqual(refused.runs, ['emote.done', plain('done')]);
      assert.deepStrictEqual(other.runs, [plain('failed')]);
    });
  });

  it.effect('raises a resident on the floor by what is missing, and tries again', () => {
    const { runs, layer } = harness({ mood: 'failed', refusals: ['goes past its bottom by 10 pt'] });
    return react('client:t/k', 'It broke.').pipe(
      Effect.provide(layer),
      Effect.map(() => assert.deepStrictEqual(runs, [plain('failed'), lifted(plain('failed'), 13)])),
    );
  });

  it.effect("with the resident's motion off, plays the rest without turns, shakes and clips", () => {
    const { runs, layer, memos } = harness({ mood: 'failed', refusals: ['motionOff'], clips: ['motion-1'] });
    memos.set('emote-variants', { failed: 1 });
    const steps = reactionFor('failed', CLIPPED, 1)!;
    return react('client:t/k', 'It broke.').pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.deepStrictEqual(runs, [steps, withoutMotion(steps)]);
        assert.include(JSON.stringify(runs[0]), 'animation');
        assert.notInclude(JSON.stringify(runs[1]), 'animation');
        assert.include(JSON.stringify(runs[1]), 'emote');
      }),
    );
  });

  it.live('waits for a run that is playing, and then plays', () => {
    const { runs, layer } = harness({ mood: 'done', refusals: ['busy'] });
    return react('client:t/k', 'Done.').pipe(
      Effect.provide(layer),
      Effect.map(() => assert.deepStrictEqual(runs, [plain('done'), plain('done')])),
    );
  });

  it.effect("falls back to the resident's own speak hook, or to none", () => {
    const settles = harness({ mood: 'fails', speak: { builtin: 'settle' } });
    const still = harness({ mood: null, speak: 'none' });
    const moves = harness({ mood: null, speak: { motion: 'wave' } });
    const saved = harness({ mood: 'fails', speak: { sequence: 'hello' } });
    return Effect.gen(function* () {
      for (const h of [settles, still, moves, saved]) yield* react('client:t/k', 'x').pipe(Effect.provide(h.layer));
      assert.deepStrictEqual(settles.runs, [[{ kind: 'action', action: 'settle' }]]);
      assert.deepStrictEqual(still.runs, []);
      assert.deepStrictEqual(moves.runs, [[{ kind: 'cut', animation: 'wave', cycles: 1, easing: 'smooth' }]]);
      assert.deepStrictEqual(saved.runs, ['hello']);
    });
  });

  it.effect('a motion hook holds still instead when the motion is off', () => {
    const { runs, layer } = harness({ mood: null, speak: { motion: 'wave' }, refusals: ['motionOff'] });
    return react('client:t/k', 'x').pipe(
      Effect.provide(layer),
      Effect.map(() =>
        assert.deepStrictEqual(runs, [
          [{ kind: 'cut', animation: 'wave', cycles: 1, easing: 'smooth' }],
          [{ kind: 'cut', easing: 'smooth', holdMs: 700 }],
        ]),
      ),
    );
  });

  it.effect('pokes when the judge fails, finds nothing to react to, or the run is refused', () => {
    const failing = harness({ mood: 'fails' });
    const nothing = harness({ mood: null });
    const busy = harness({ mood: 'asking', refusals: ['nope'] });
    return Effect.gen(function* () {
      yield* react('client:t/k', 'x').pipe(Effect.provide(failing.layer));
      yield* react('client:t/k', 'x').pipe(Effect.provide(nothing.layer));
      yield* react('client:t/k', 'x').pipe(Effect.provide(busy.layer));
      assert.deepStrictEqual(failing.runs, [POKE]);
      assert.deepStrictEqual(nothing.runs, [POKE]);
      assert.deepStrictEqual(busy.runs, [plain('asking'), POKE]);
    });
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'plugins/pixling-proxy/scripts/hook.mjs');
const FAKE = path.join(root, 'test/fake-pixling.mjs');
const sid = 'e3c1d2e4-0000-4000-8000-000000000001';

const until = async <A>(check: () => A | undefined, ms = 10_000): Promise<A> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

// `reacted`: what in the CLI's calls says the reactor is through.
const stop = (
  settings: object | null,
  judge: http.RequestListener,
  scenario_: object = {},
  reacted: (call: string[]) => boolean = (c) => c[0] === 'sequence' && c[1] === 'start',
  // Events of the same session before its stop.
  first: ReadonlyArray<readonly [string, object]> = [],
) =>
  new Promise<{ calls: string[][]; requests: { headers: http.IncomingHttpHeaders; body: any }[] }>(
    (resolve, reject) => {
      const requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          requests.push({ headers: req.headers, body: JSON.parse(body) });
          judge(req, res);
        });
      });
      server.listen(0, '127.0.0.1', async () => {
        try {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-emote-test-'));
          const log = path.join(dir, 'calls.jsonl');
          const scenario = path.join(dir, 'scenario.json');
          fs.writeFileSync(log, '');
          fs.writeFileSync(scenario, JSON.stringify(scenario_));
          const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v4/ai`;
          if (settings) {
            fs.mkdirSync(path.join(dir, 'config/pixling'), { recursive: true });
            fs.writeFileSync(
              path.join(dir, 'config/pixling/proxy.json'),
              JSON.stringify({ emote: { endpoint, ...settings } }),
            );
          }
          const env = {
            ...process.env,
            PIXLING_CLI: FAKE,
            FAKE_LOG: log,
            FAKE_SCENARIO: scenario,
            XDG_CACHE_HOME: path.join(dir, 'cache'),
            XDG_CONFIG_HOME: path.join(dir, 'config'),
            AI_GATEWAY_API_KEY: '',
            CLAUDE_CODE_ENTRYPOINT: 'cli',
            CLAUDE_CODE_SESSION_ATTENDED: '1',
          };
          for (const [event, payload] of first) {
            spawnSync(process.execPath, [HOOK, 'claude-code', event], {
              input: JSON.stringify({ session_id: sid, ...payload }),
              encoding: 'utf8',
              env,
            });
          }
          const res = spawnSync(process.execPath, [HOOK, 'claude-code', 'stop'], {
            input: JSON.stringify({ session_id: sid, last_assistant_message: 'All tests pass.' }),
            encoding: 'utf8',
            env,
          });
          nodeAssert.equal(res.status, 0);
          nodeAssert.equal(res.stdout, '{}');
          const read = () =>
            fs
              .readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as string[]);
          // The reactor runs after the hook has answered.
          if (settings) await until(() => (read().some(reacted) ? true : undefined));
          resolve({ calls: read(), requests });
        } catch (error) {
          reject(error);
        } finally {
          server.close();
        }
      });
    },
  );

const verdict = (mood: string, intensity?: number) => (_: http.IncomingMessage, res: http.ServerResponse) => {
  res.setHeader('content-type', 'application/json');
  const weight = intensity === undefined ? {} : { intensity: { score: intensity } };
  res.end(JSON.stringify({ answers: { react: { probability: 0.9 }, mood: { choice: mood }, ...weight } }));
};

const arg = (call: string[], name: string) => call[call.indexOf(name) + 1];

// The run the built hook started is the reaction in one of the mood's lighting styles,
// picked at random.
const isLitReaction = (steps: unknown, mood: Mood, weight: Weight = 'normal') =>
  nodeAssert.ok(
    glowStylesFor(mood).some((style) =>
      isDeepStrictEqual(steps, weighted(mood, lit(reactionFor(mood, NO_TRAITS, 0)!, style), weight)),
    ),
    JSON.stringify(steps),
  );

test('pixling-proxy with emote settings: the reply arrives still, and the resident reacts to it', async () => {
  const { calls, requests } = await stop({ apiKey: 'secret', model: 'm/judge' }, verdict('done'));
  const send = calls.find((c) => c[0] === 'message')!;
  nodeAssert.equal(arg(send, '--text'), 'All tests pass.');
  nodeAssert.equal(arg(send, '--action'), 'none');
  const run = calls.find((c) => c[0] === 'sequence' && c[1] === 'start')!;
  nodeAssert.equal(arg(run, '--to'), `client:claude-code/${sid}`);
  isLitReaction(JSON.parse(arg(run, '--steps')), 'done');
  // Only the reply leaves, and never as an argument.
  nodeAssert.equal(requests.length, 1);
  nodeAssert.equal(requests[0].headers.authorization, 'Bearer secret');
  nodeAssert.equal(requests[0].headers['ai-model-id'], 'm/judge');
  nodeAssert.equal(requests[0].body.state.said, 'All tests pass.');
  nodeAssert.equal(requests[0].body.questions.intensity.type, 'score');
  nodeAssert.ok(!calls.flat().some((a) => a.includes('secret')));
});

test('pixling-proxy with emote settings: a weighty reply reacts heavily even after a short turn', async () => {
  // Score 3 of 0...4 is 4 of 5.
  const { calls } = await stop({ apiKey: 'k' }, verdict('done', 3));
  const run = calls.find((c) => c[0] === 'sequence' && c[1] === 'start')!;
  isLitReaction(JSON.parse(arg(run, '--steps')), 'done', 'heavy');
});

test('pixling-proxy with emote settings: a judge that fails leaves the resident its own motion', async () => {
  const { calls } = await stop({ apiKey: 'k' }, (_, res) => {
    res.statusCode = 500;
    res.end('{}');
  });
  const run = calls.find((c) => c[0] === 'sequence' && c[1] === 'start')!;
  nodeAssert.deepEqual(JSON.parse(arg(run, '--steps')), POKE);
});

test('pixling-proxy: without emote settings nothing reacts and nothing is sent', async () => {
  const { calls, requests } = await stop(null, verdict('done'));
  const send = calls.find((c) => c[0] === 'message')!;
  nodeAssert.ok(!send.includes('--action'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  nodeAssert.equal(requests.length, 0);
});

// The built hook for a run of events in one session, with emote settings (a key, and no
// judge to reach) and nothing shown between replies. Events in one inner list run at
// once. Returns every CLI call.
const during = async (
  host: 'claude-code' | 'antigravity',
  steps: ReadonlyArray<ReadonlyArray<readonly [string, object]>>,
  wantEmotes: number,
  scenario_: object = {},
  // After each step, for what it left running detached (a tool call's part).
  settleMs = 0,
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-emote-during-'));
  const log = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(log, '');
  fs.writeFileSync(scenario, JSON.stringify(scenario_));
  fs.mkdirSync(path.join(dir, 'config/pixling'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config/pixling/proxy.json'),
    JSON.stringify({
      emote: { apiKey: 'k', endpoint: 'http://127.0.0.1:9/v4/ai' },
      show: { text: false, reasoning: 'none', tools: 'none' },
      receive: false,
    }),
  );
  const env = {
    ...process.env,
    PIXLING_CLI: FAKE,
    FAKE_LOG: log,
    FAKE_SCENARIO: scenario,
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    AI_GATEWAY_API_KEY: '',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
  };
  const session = host === 'claude-code' ? { session_id: sid } : { conversationId: sid };
  const read = () =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const emotes = () => read().filter((c) => c[0] === 'resident' && c[1] === 'emote');
  const runHook = (event: string, payload: object) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK, host, event], { env, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${event} exited ${code}`))));
      child.stdin.end(JSON.stringify({ ...session, ...payload }));
    });
  for (const step of steps) {
    await Promise.all(step.map(([event, payload]) => runHook(event, payload)));
    if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  // A tool call's part may run in a detached copy of the hook.
  await until(() => (emotes().length >= wantEmotes ? true : undefined));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { calls: read(), texts: emotes().map((c) => arg(c, '--text')) };
};

const SECRET_INPUT = { command: 'cat ~/.secret-token-xyz' };

test("pixling-proxy with emote settings: the turn's start and a new kind of tool pop an emoji, even with tools not shown", async () => {
  const { calls, texts } = await during(
    'claude-code',
    [
      [['session-start', { source: 'resume' }]],
      [['before-tool', { tool_name: 'Bash', tool_use_id: 't1', tool_input: SECRET_INPUT }]],
      // Too soon after Bash.
      [['before-tool', { tool_name: 'Edit', tool_use_id: 't2', tool_input: {} }]],
      // Always.
      [['prompt', { prompt: 'Fix it' }]],
    ],
    2,
  );
  nodeAssert.deepEqual(texts, [EMOJI.run, EMOJI.turn]);
  // Only the tool's name is read.
  nodeAssert.ok(!calls.flat().some((a) => a.includes('secret-token')));
});

test('pixling-proxy with emote settings: tool calls at the same moment pop one emoji', async () => {
  const { texts } = await during(
    'claude-code',
    [
      [['session-start', { source: 'startup' }]],
      ['Read', 'Grep', 'Edit', 'Bash', 'WebFetch', 'Agent'].map(
        (name, i) => ['before-tool', { tool_name: name, tool_use_id: `p${i}`, tool_input: {} }] as const,
      ),
    ],
    1,
  );
  nodeAssert.equal(texts.length, 1);
});

test("pixling-proxy with emote settings: every turn's start pops 👀, whether or not its reply showed", async () => {
  const { texts } = await during(
    'claude-code',
    [
      [['session-start', { source: 'resume' }]],
      [['prompt', { prompt: 'One' }]],
      // Interrupted: no Stop.
      [['prompt', { prompt: 'Two' }]],
      [['stop', {}]],
      [['prompt', { prompt: 'Three' }]],
    ],
    3,
  );
  nodeAssert.deepEqual(texts, [EMOJI.turn, EMOJI.turn, EMOJI.turn]);
});

test('pixling-proxy with emote settings: a host whose prompt event fires at every step pops no 👀 for it', async () => {
  const { texts } = await during('antigravity', [[['session-start', {}]], [['prompt', {}]], [['prompt', {}]]], 1);
  // Only the session's own wave.
  nodeAssert.deepEqual(texts, [EMOJI.start]);
});

test('pixling-proxy with emote settings: nothing pops before a resident is bound', async () => {
  const { calls } = await during(
    'claude-code',
    [[['before-tool', { tool_name: 'Read', tool_use_id: 't1', tool_input: {} }]]],
    0,
  );
  nodeAssert.ok(!calls.some((c) => c[1] === 'emote'));
});

const describes = (result: object) => ({ 'resident describe': { exit: 0, result } });

test('pixling-proxy with emote settings: the resident it creates starts with its motion on; one without emote settings is left be', async () => {
  const emote = await during('claude-code', [[['session-start', { source: 'startup' }]]], 0);
  const created = emote.calls.find((c) => c[1] === 'ensure' && c.includes('--asset-id'))!;
  nodeAssert.deepEqual(JSON.parse(arg(created, '--initial')), { settings: { motionEnabled: true } });
  const plain = await stop(null, verdict('done'));
  nodeAssert.ok(!plain.calls.flat().includes('--initial'));
});

test('pixling-proxy with emote settings: a resident no window shows is left alone, and its reply stays on this Mac', async () => {
  const describe = (c: string[]) => c[1] === 'describe';
  const { calls, requests } = await stop(
    { apiKey: 'k' },
    verdict('done'),
    describes({ resident: { visibility: 'otherDesktop' } }),
    describe,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  nodeAssert.equal(requests.length, 0);
  nodeAssert.ok(!calls.some((c) => c[0] === 'sequence' || c[1] === 'emote'));
});

test('pixling-proxy with emote settings: with a question waiting on the resident it pops ❓, with no judge and no run', async () => {
  const { calls, requests } = await stop(
    { apiKey: 'k' },
    verdict('done'),
    describes({ resident: { visibility: 'visible', conversation: { questionsPending: 1 } } }),
    (c) => c[1] === 'emote',
  );
  const pop = calls.find((c) => c[1] === 'emote')!;
  nodeAssert.deepEqual([arg(pop, '--text'), arg(pop, '--count')], ['❓', '2']);
  nodeAssert.equal(requests.length, 0);
  nodeAssert.ok(!calls.some((c) => c[0] === 'sequence'));
});

test('pixling-proxy with emote settings: states show on an asset with looks for them, the card carries its own, and the turn ends clear', async () => {
  const { calls } = await during(
    'claude-code',
    [
      [['session-start', { source: 'startup' }]],
      [['prompt', { prompt: 'go' }]],
      [['before-tool', { tool_name: 'Edit', tool_use_id: 't1', tool_input: {} }]],
      [['permission', { tool_name: 'Bash', tool_input: { command: 'ls' } }]],
      [['stop', { last_assistant_message: '' }]],
    ],
    1,
    {
      ...describes({ options: { statuses: [{ name: 'working' }, { name: 'working.write' }, { name: 'asking' }] } }),
      'question ask': {
        exit: 0,
        result: { question: { promptID: 'p', state: 'answered', selectedChoiceID: 'allow' } },
      },
    },
    1000,
  );
  const states = calls
    .filter((c) => c[1] === 'status')
    .map((c) => (c.includes('--clear') ? 'clear' : arg(c, '--name')));
  nodeAssert.deepEqual(states, ['working', 'working.write', 'clear']);
  nodeAssert.equal(
    arg(
      calls.find((c) => c[0] === 'question' && c[1] === 'ask')!,
      '--status',
    ),
    'asking',
  );
}, 20_000);

test('pixling-proxy with emote settings: an asset with no looks gets no state, and its card none', async () => {
  const { calls } = await during(
    'claude-code',
    [
      [['session-start', { source: 'startup' }]],
      [['prompt', { prompt: 'go' }]],
      [['permission', { tool_name: 'Bash', tool_input: { command: 'ls' } }]],
      [['stop', { last_assistant_message: '' }]],
    ],
    1,
    {
      'question ask': {
        exit: 0,
        result: { question: { promptID: 'p', state: 'answered', selectedChoiceID: 'allow' } },
      },
    },
  );
  nodeAssert.ok(!calls.some((c) => c[1] === 'status'));
  nodeAssert.ok(!calls.find((c) => c[0] === 'question' && c[1] === 'ask')!.includes('--status'));
}, 20_000);

test('pixling-proxy with emote settings: a turn that took a moment gets the quiet reaction', async () => {
  const { calls } = await stop({ apiKey: 'k' }, verdict('done'), {}, undefined, [
    ['session-start', { source: 'startup' }],
    ['prompt', { prompt: 'go' }],
  ]);
  const run = calls.find((c) => c[0] === 'sequence' && c[1] === 'start')!;
  const light = weighted('done', reactionFor('done', NO_TRAITS, 0)!, 'light');
  nodeAssert.notDeepEqual(light, reactionFor('done', NO_TRAITS, 0));
  isLitReaction(JSON.parse(arg(run, '--steps')), 'done', 'light');
}, 20_000);

test('pixling-proxy with emote settings: a session that begins waves once; one that goes on does not', async () => {
  const began = await during('claude-code', [[['session-start', { source: 'startup' }]]], 1);
  nodeAssert.deepEqual(began.texts, [EMOJI.start]);
  const resumed = await during('claude-code', [[['session-start', { source: 'resume' }]]], 0);
  nodeAssert.deepEqual(resumed.texts, []);
});
