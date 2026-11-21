// The Desk against the CLI: one that cannot be started must say why in the log line,
// and `resident describe` is read into the resident's traits.
import { assert, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { NodeServices } from '@effect/platform-node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SPEAK, Desk } from '../src/pixling/Desk.ts';

it.live('a CLI that cannot be started names the error and the path tried', () => {
  const missing = '/nonexistent/pixling-stale-override';
  const before = process.env.PIXLING_CLI;
  process.env.PIXLING_CLI = missing;
  return Effect.gen(function* () {
    const desk = yield* Desk;
    const error = yield* desk.residents().pipe(Effect.flip);
    assert.strictEqual(error.reason, 'unreachable');
    assert.strictEqual(error.summary, `unreachable ENOENT cli=${missing}`);
  }).pipe(
    Effect.provide(Desk.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(
      Effect.sync(() => (before === undefined ? delete process.env.PIXLING_CLI : (process.env.PIXLING_CLI = before))),
    ),
  );
});

// `resident describe` through the fake CLI: the speak hook as it takes effect.
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-pixling.mjs');
const describing = (describe: unknown) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-desk-test-'));
    const scenario = path.join(dir, 'scenario.json');
    fs.writeFileSync(scenario, JSON.stringify({ 'resident describe': describe }));
    const saved = { cli: process.env.PIXLING_CLI, log: process.env.FAKE_LOG, scenario: process.env.FAKE_SCENARIO };
    const restore = (name: string, value: string | undefined) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value);
    return yield* Effect.gen(function* () {
      process.env.PIXLING_CLI = FAKE;
      process.env.FAKE_LOG = path.join(dir, 'calls.jsonl');
      process.env.FAKE_SCENARIO = scenario;
      const desk = yield* Desk;
      return yield* desk.traits('client:t/k');
    }).pipe(
      Effect.provide(Desk.layer.pipe(Layer.provide(NodeServices.layer))),
      Effect.ensuring(
        Effect.sync(() => {
          restore('PIXLING_CLI', saved.cli);
          restore('FAKE_LOG', saved.log);
          restore('FAKE_SCENARIO', saved.scenario);
        }),
      ),
    );
  });

const IDLE = { id: 'idle', name: '', motion: '' };
// A desk that says nothing more: in view, no question, no states.
const PLAIN = { speak: DEFAULT_SPEAK, clips: [], inView: true, questionOpen: false, statuses: [] };

const withSpeak = (effective: unknown) => ({
  exit: 0,
  result: {
    settings: { hooks: { speak: { value: effective, effective, layer: 'resident' } } },
    sequence: { animations: [{ id: 'idle' }] },
  },
});

it.live('reads each kind of speak hook from describe', () =>
  Effect.gen(function* () {
    for (const effective of ['none', { builtin: 'settle' }, { motion: 'wave' }, { sequence: 'hello' }] as const) {
      const traits = yield* describing(withSpeak(effective));
      assert.deepStrictEqual(traits, { ...PLAIN, speak: effective, clips: [IDLE] });
    }
  }),
);

it.live('pokes when describe has no hooks, or a kind this proxy does not know', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* describing({ exit: 0, result: { settings: {} } }), PLAIN);
    assert.deepStrictEqual(yield* describing(withSpeak({ dance: 'x' })), { ...PLAIN, clips: [IDLE] });
  }),
);

it.live('reads what stands in the way of a reaction, and what the resident offers', () =>
  Effect.gen(function* () {
    const described = (resident: object, more: object = {}) => describing({ exit: 0, result: { resident, ...more } });
    assert.isFalse((yield* described({ visibility: 'otherDesktop' })).inView);
    assert.isTrue((yield* described({ visibility: 'visible' })).inView);
    assert.isTrue((yield* described({ conversation: { questionsPending: 1 } })).questionOpen);
    assert.isTrue((yield* described({ conversation: { questionPresented: true } })).questionOpen);
    assert.isFalse((yield* described({ conversation: { questionsPending: 0 } })).questionOpen);
    const offers = yield* described(
      {},
      {
        options: { statuses: [{ name: 'working', hold: { animation: 'm2' } }] },
        sequence: { animations: [{ id: 'm2', name: 'ダンス', motion: 'sways' }] },
      },
    );
    assert.deepStrictEqual(offers.statuses, ['working']);
    assert.deepStrictEqual(offers.clips, [{ id: 'm2', name: 'ダンス', motion: 'sways' }]);
  }),
);
