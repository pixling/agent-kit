// The Desk against the CLI: one that cannot be started must say why in the log line,
// `resident describe` is read into the resident's traits, and unary calls run over one
// persistent `pixling rpc` worker with clean fallback to `call` and legacy subcommands.
import { assert, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { NodeServices } from '@effect/platform-node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SPEAK, Desk } from '../src/pixling/Desk.ts';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-pixling.mjs');

const withFakeDesk = <A, E>(scenarioDoc: Record<string, unknown>, run: (rpcLog: string) => Effect.Effect<A, E, Desk>) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-desk-test-'));
    const scenario = path.join(dir, 'scenario.json');
    const rpcLog = path.join(dir, 'rpc.jsonl');
    fs.writeFileSync(scenario, JSON.stringify(scenarioDoc));
    const saved = {
      cli: process.env.PIXLING_CLI,
      log: process.env.FAKE_LOG,
      rpcLog: process.env.FAKE_RPC_LOG,
      scenario: process.env.FAKE_SCENARIO,
    };
    const restore = (name: string, value: string | undefined) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value);
    return yield* Effect.gen(function* () {
      process.env.PIXLING_CLI = FAKE;
      process.env.FAKE_LOG = path.join(dir, 'calls.jsonl');
      process.env.FAKE_RPC_LOG = rpcLog;
      process.env.FAKE_SCENARIO = scenario;
      return yield* run(rpcLog);
    }).pipe(
      Effect.provide(Desk.layer.pipe(Layer.provide(NodeServices.layer))),
      Effect.ensuring(
        Effect.sync(() => {
          restore('PIXLING_CLI', saved.cli);
          restore('FAKE_LOG', saved.log);
          restore('FAKE_RPC_LOG', saved.rpcLog);
          restore('FAKE_SCENARIO', saved.scenario);
        }),
      ),
    );
  });

const readRpcLog = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

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

const describing = (describe: unknown) =>
  withFakeDesk({ 'resident describe': describe }, () =>
    Effect.gen(function* () {
      const desk = yield* Desk;
      return yield* desk.traits('client:t/k');
    }),
  );

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

it.live('reuses one pixling rpc worker across calls and keeps message text out of argv', () =>
  withFakeDesk(
    {
      'resident ensure': { exit: 0, result: { state: 'onDesk' } },
      'message send': { exit: 0, result: { receipts: [{ outcome: 'spoke' }] } },
      'sequence start': { exit: 0, result: { runID: 'r1' } },
    },
    (rpcLog) =>
      Effect.gen(function* () {
        const desk = yield* Desk;
        yield* desk.ensure({ namespace: 'test', key: 'k1' }, { assetID: 'No.1', name: 'A' });
        yield* desk.send({ to: 'client:test/k1', author: 'Bot', text: '- secret bullet line' });
        yield* desk.sequence({ to: 'client:test/k1', steps: [{ kind: 'action', action: 'poke' }] });
        const records = readRpcLog(rpcLog);
        assert.strictEqual(records.length, 3);
        assert.deepStrictEqual(
          records.map((r) => r.mode),
          ['rpc', 'rpc', 'rpc'],
        );
        // All three calls ran on the same persistent worker process.
        assert.strictEqual(new Set(records.map((r) => r.pid)).size, 1);
        // Payloads traveled over stdin JSON, never in argv.
        assert.isFalse(records.some((r) => r.argv.join(' ').includes('secret bullet')));
        // sequence.start sends the wire-required schemaVersion and requestID.
        assert.strictEqual(records[2].req.op, 'sequence.start');
        assert.strictEqual(records[2].req.args.schemaVersion, 1);
        assert.isString(records[2].req.args.requestID);
      }),
  ),
);

it.live('falls back from rpc to pixling call stdin, then to legacy subcommands on older CLIs', () =>
  Effect.gen(function* () {
    // rpc unsupported (exit 64) -> uses `pixling call <op> -`
    yield* withFakeDesk(
      {
        rpc: { exit: 64 },
        'message send': { exit: 0, result: { receipts: [{ outcome: 'spoke' }] } },
      },
      (rpcLog) =>
        Effect.gen(function* () {
          const desk = yield* Desk;
          const sent = yield* desk.send({ to: 'client:t/k', author: 'Bot', text: '- fallback via call' });
          assert.deepStrictEqual(sent.outcomes, ['spoke']);
          const records = readRpcLog(rpcLog);
          assert.strictEqual(records.length, 1);
          assert.strictEqual(records[0].mode, 'call');
          assert.deepStrictEqual(records[0].argv, ['call', 'message.send', '-']);
          assert.strictEqual(records[0].args.text, '- fallback via call');
        }),
    );

    // both rpc and call unsupported (exit 64) -> falls back to legacy subcommand flags
    yield* withFakeDesk(
      {
        rpc: { exit: 64 },
        call: { exit: 64 },
        'message send': { exit: 0, result: { receipts: [{ outcome: 'spoke' }] } },
      },
      (rpcLog) =>
        Effect.gen(function* () {
          const desk = yield* Desk;
          const sent = yield* desk.send({ to: 'client:t/k', author: 'Bot', text: '- fallback via legacy' });
          assert.deepStrictEqual(sent.outcomes, ['spoke']);
          const records = readRpcLog(rpcLog);
          assert.strictEqual(records.length, 1);
          assert.strictEqual(records[0].mode, 'legacy');
          assert.strictEqual(records[0].op, 'message send');
        }),
    );
  }),
);
