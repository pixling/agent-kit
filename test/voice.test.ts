// The voice: its settings, a reply taken apart into what can be
// said, the choice among the parts, the run on fakes, and the built pixling-proxy
// against the fake CLI, a fake player, and a judge and Fish Audio served from this process.
import { assert, describe, it } from '@effect/vitest';
import { test } from 'vite-plus/test';
import nodeAssert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { Judge, JudgeError } from '../src/extensions/emote/Judge.ts';
import type { Mood } from '../src/extensions/emote/reactions.ts';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_VOICE_ENDPOINT,
  DEFAULT_VOICE_MODEL,
  SPEAKING,
  type VoiceConfig,
  voiceConfig,
} from '../src/extensions/voice/config.ts';
import { announce, speak, Turn, Voice, VoiceError } from '../src/extensions/voice/speak.ts';
import { chosen, MAX_PARTS, partsOf, SPEECH, toned } from '../src/extensions/voice/speech.ts';
import { SessionLocks } from '../src/runtimes/SessionFiles.ts';

describe('voice settings', () => {
  it('needs a voice object and a key, from the settings or the environment', () => {
    assert.isNull(voiceConfig({}, { FISH_API_KEY: 'k' }));
    assert.isNull(voiceConfig({ voice: {} }, {}));
    assert.deepStrictEqual(voiceConfig({ voice: {} }, { FISH_API_KEY: ' k ' }), {
      endpoint: DEFAULT_VOICE_ENDPOINT,
      apiKey: 'k',
      model: DEFAULT_VOICE_MODEL,
      voice: null,
      speed: 1,
      volume: 0,
      maxChars: DEFAULT_MAX_CHARS,
      threshold: 0.5,
      tone: true,
    });
    assert.strictEqual(voiceConfig({ voice: { apiKeyEnv: 'MINE' } }, { MINE: 'm', FISH_API_KEY: 'k' })?.apiKey, 'm');
    assert.strictEqual(voiceConfig({ voice: { apiKey: 'own' } }, { FISH_API_KEY: 'k' })?.apiKey, 'own');
  });

  it('sends the key over plain http only to this machine', () => {
    assert.isNull(voiceConfig({ voice: { apiKey: 'k', endpoint: 'http://example.com' } }, {}));
    assert.strictEqual(
      voiceConfig({ voice: { apiKey: 'k', endpoint: 'http://127.0.0.1:9/' } }, {})?.endpoint,
      'http://127.0.0.1:9',
    );
  });

  it('a wrong value keeps its default, and costs nothing else', () => {
    const config = voiceConfig(
      { voice: { apiKey: 'k', voice: 'abc', speed: 9, volume: -3, maxChars: 'many', tone: false, model: 7 } },
      {},
    )!;
    assert.deepStrictEqual(
      [config.voice, config.speed, config.volume, config.maxChars, config.tone, config.model],
      ['abc', 1, -3, DEFAULT_MAX_CHARS, false, DEFAULT_VOICE_MODEL],
    );
  });
});

describe('a reply as speech', () => {
  it('leaves out code blocks, tables and rules, and reads the rest part by part', () => {
    const parts = partsOf(
      [
        '## Result ✅',
        '',
        '**All tests pass** (`npm test`).',
        'The change is in `src/extensions/voice/speech.ts`.',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '---',
        '> Shall I deploy it?',
      ].join('\n'),
    );
    assert.deepStrictEqual(parts, [
      'Result',
      'All tests pass (npm test). The change is in speech.ts.',
      'Shall I deploy it?',
    ]);
  });

  it('reads a list as one part, each item a sentence, and the paragraph after it as another', () => {
    assert.deepStrictEqual(partsOf('Two things:\n- [x] the first\n  goes on\n* the second.\n1. third\n\nDone.'), [
      'Two things:',
      'the first goes on. the second. third.',
      'Done.',
    ]);
  });

  it('joins lines without a space where the script uses none, and with a space for Korean', () => {
    assert.deepStrictEqual(partsOf('テストは全部\n通りました。\n- 設定は `voice` に書く\n- 鍵は環境変数'), [
      'テストは全部通りました。',
      '設定は voice に書く。 鍵は環境変数。',
    ]);
    assert.deepStrictEqual(partsOf('測試全部\n通過了。\n- 設定寫在 `voice`\n- 金鑰放在環境變數'), [
      '測試全部通過了。',
      '設定寫在 voice。 金鑰放在環境變數。',
    ]);
    assert.deepStrictEqual(partsOf('테스트가 모두\n통과했어요.\n- 설정은 `voice`에 적어요\n- 키는 환경 변수'), [
      '테스트가 모두 통과했어요.',
      '설정은 voice에 적어요. 키는 환경 변수.',
    ]);
  });

  it('says a link by its words, and neither addresses, pictures, long code nor emoji', () => {
    assert.deepStrictEqual(
      partsOf(
        'See [the docs](https://example.com/a) at https://example.com/b ![shot](x.png) 🎉 and run `a-very-long-command --with --many --flags --nobody --wants --to --hear`.',
      ),
      ['See the docs at and run .'],
    );
    assert.deepStrictEqual(partsOf('詳細は [README](https://example.com) を見てください https://example.com 。'), [
      '詳細は README を見てください。',
    ]);
  });

  it('a code block never closed runs to the end, and a reply of only code says nothing', () => {
    assert.deepStrictEqual(partsOf('Here:\n```\nrm -rf x\n\nmore'), ['Here:']);
    assert.deepStrictEqual(partsOf('```\ncode\n```\n\n---\n\n🎉'), []);
  });

  it('keeps underscores and stars inside names', () => {
    assert.deepStrictEqual(partsOf('Set MAX_PART_CHARS and a*b*c, *really*.'), [
      'Set MAX_PART_CHARS and a*b*c, really.',
    ]);
  });
});

describe('what is said', () => {
  it('the parts the judge would say, in order', () => {
    assert.deepStrictEqual(chosen(['a.', 'b.', 'c.'], [0.9, 0.2, 0.5], 0.5, 100), ['a.', 'c.']);
    // A part the judge did not answer for is not said.
    assert.deepStrictEqual(chosen(['a.', 'b.'], [0.9], 0.5, 100), ['a.']);
  });

  it('stops at the limit, on a sentence, and says nothing after it', () => {
    assert.deepStrictEqual(chosen(['One. Two. Three.', 'Four.'], [1, 1], 0.5, 10), ['One. Two.']);
    assert.deepStrictEqual(chosen(['一つ目です。二つ目です。', '三つ目。'], [1, 1], 0.5, 8), ['一つ目です。']);
    // Not even its first sentence fits.
    assert.deepStrictEqual(chosen(['A sentence too long to fit.', 'Short.'], [1, 1], 0.5, 10), []);
    // A version number is not a sentence's end.
    assert.deepStrictEqual(chosen(['Use v1.2 now. Then stop here.'], [1], 0.5, 15), ['Use v1.2 now.']);
  });

  it('asks the judge about each part by name', () => {
    const parts = ['a', 'b'];
    assert.deepStrictEqual(SPEECH.state(parts).parts, { p1: 'a', p2: 'b' });
    assert.deepStrictEqual(Object.keys(SPEECH.questions(parts)), ['p1', 'p2']);
  });

  it('takes the tone of the reply, where that kind has one', () => {
    assert.strictEqual(toned('Done.', 'done'), '[cheerful] Done.');
    assert.strictEqual(toned('Here is how.', 'explaining'), 'Here is how.');
    assert.strictEqual(toned('Hm.', null), 'Hm.');
  });
});

const CONFIG: VoiceConfig = {
  endpoint: 'http://127.0.0.1:1',
  apiKey: 'k',
  model: 'm',
  voice: null,
  speed: 1,
  volume: 0,
  maxChars: 200,
  threshold: 0.5,
  tone: true,
};

describe('speak', () => {
  const harness = (options: {
    probabilities?: ReadonlyArray<number> | 'fails';
    mood?: Mood | null | 'fails';
    turn?: ReadonlyArray<boolean>;
    synthesis?: 'fails';
  }) => {
    const events: string[] = [];
    const judgedParts: ReadonlyArray<string>[] = [];
    const turns = [...(options.turn ?? [true])];
    const layer = Layer.mergeAll(
      Layer.succeed(Judge)({
        verdictOf: () =>
          options.mood === 'fails'
            ? Effect.fail(new JudgeError({ cause: new Error('down') }))
            : Effect.succeed({ mood: options.mood ?? null, weight: null }),
        worthSaying: (parts) =>
          Effect.suspend(() => {
            judgedParts.push(parts);
            return options.probabilities === 'fails'
              ? Effect.fail(new JudgeError({ cause: new Error('down') }))
              : Effect.succeed(options.probabilities ?? parts.map(() => 1));
          }),
      }),
      Layer.succeed(Voice)({
        synthesize: (text) =>
          options.synthesis === 'fails'
            ? Effect.fail(new VoiceError({ cause: new Error('402') }))
            : Effect.sync(() => {
                events.push(`made ${text}`);
                return new TextEncoder().encode(text);
              }),
        // Playing takes time, in which the next part is made.
        play: (audio) =>
          Effect.yieldNow.pipe(
            Effect.andThen(Effect.sync(() => void events.push(`played ${new TextDecoder().decode(audio)}`))),
          ),
      }),
      Layer.succeed(Turn)({
        take: Effect.sync(() => {
          events.push('take');
          return turns.length > 1 ? turns.shift()! : turns[0];
        }),
        give: Effect.sync(() => void events.push('give')),
      }),
      Layer.succeed(SessionLocks)({
        lock: (name: string) => Effect.sync(() => (events.push(`lock ${name}`), true)),
        unlock: (name: string) => Effect.sync(() => void events.push(`unlock ${name}`)),
        stopHolder: (name: string) => Effect.sync(() => (events.push(`stop ${name}`), 0)),
        handOver: () => Effect.void,
      }),
    );
    return { events, judgedParts, layer };
  };
  const say = (reply: string, config: VoiceConfig = CONFIG) => speak('client:t/k', reply, config);

  it.effect('says the parts the judge picks, in the tone of the reply, the next made while one plays', () => {
    const { events, judgedParts, layer } = harness({ probabilities: [0.9, 0.1, 0.8], mood: 'done' });
    return say('All tests pass.\n\n- src/a.ts\n- src/b.ts\n\nShall I deploy?').pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.deepStrictEqual(judgedParts, [['All tests pass.', 'src/a.ts. src/b.ts.', 'Shall I deploy?']]);
        assert.deepStrictEqual(events, [
          `stop ${SPEAKING}`,
          `lock ${SPEAKING}`,
          'take',
          'made [cheerful] All tests pass.',
          'made [cheerful] Shall I deploy?',
          'played [cheerful] All tests pass.',
          'played [cheerful] Shall I deploy?',
          'give',
          `unlock ${SPEAKING}`,
        ]);
      }),
    );
  });

  it.effect('says what a card asks as it is, without asking the judge', () => {
    const { events, judgedParts, layer } = harness({ probabilities: [0] });
    return announce('client:t/k', 'Allow `Bash`?', CONFIG).pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.deepStrictEqual(judgedParts, []);
        assert.deepStrictEqual(
          events.filter((event) => event.startsWith('played')),
          ['played [curious] Allow Bash?'],
        );
      }),
    );
  });

  it.effect('a reply with nothing to say asks nobody and stops nothing', () => {
    const { events, judgedParts, layer } = harness({});
    return say('```\ncode\n```').pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.deepStrictEqual(judgedParts, []);
        assert.deepStrictEqual(events, []);
      }),
    );
  });

  it.effect('stays silent when the judge would say none of it, without taking the turn', () => {
    const { events, layer } = harness({ probabilities: [0.1] });
    return say('src/a.ts').pipe(
      Effect.provide(layer),
      Effect.map(() => assert.deepStrictEqual(events, [`stop ${SPEAKING}`, `lock ${SPEAKING}`, `unlock ${SPEAKING}`])),
    );
  });

  it.effect('unjudged, says the lead plainly; with the tone off, never asks for the mood', () => {
    const failing = harness({ probabilities: 'fails', mood: 'fails' });
    const plain = harness({ mood: 'done' });
    return Effect.gen(function* () {
      yield* say('First.\n\nSecond.').pipe(Effect.provide(failing.layer));
      assert.deepStrictEqual(
        failing.events.filter((event) => event.startsWith('played')),
        ['played First.'],
      );
      yield* say('First.', { ...CONFIG, tone: false }).pipe(Effect.provide(plain.layer));
      assert.deepStrictEqual(
        plain.events.filter((event) => event.startsWith('played')),
        ['played First.'],
      );
    });
  });

  it.effect('hears at most so many parts, and says at most so many characters', () => {
    const { events, judgedParts, layer } = harness({});
    const reply = Array.from({ length: MAX_PARTS + 5 }, (_, index) => `Part ${index}.`).join('\n\n');
    return say(reply, { ...CONFIG, maxChars: 14 }).pipe(
      Effect.provide(layer),
      Effect.map(() => {
        assert.strictEqual(judgedParts[0].length, MAX_PARTS);
        assert.deepStrictEqual(
          events.filter((event) => event.startsWith('played')),
          ['played Part 0.', 'played Part 1.'],
        );
      }),
    );
  });

  it.live("waits for another session's voice to finish", () => {
    const { events, layer } = harness({ turn: [false, false, true] });
    return say('Hello.').pipe(
      Effect.provide(layer),
      Effect.map(() =>
        assert.deepStrictEqual(
          events.filter((event) => event === 'take' || event.startsWith('played')),
          ['take', 'take', 'take', 'played Hello.'],
        ),
      ),
    );
  });

  it.effect('a voice that cannot be made costs only the voice, and gives the turn back', () => {
    const { events, layer } = harness({ synthesis: 'fails' });
    return say('Hello.').pipe(
      Effect.provide(layer),
      Effect.map(() => assert.deepStrictEqual(events.slice(-2), ['give', `unlock ${SPEAKING}`])),
    );
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(root, 'plugins/pixling-proxy/scripts/hook.mjs');
const sid = 'e3c1d2e4-0000-4000-8000-00000000000a';

const until = async <A>(check: () => A | undefined, ms = 10_000): Promise<A> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

// One server for the judge and for Fish Audio, which answers with its text as the "audio".
const world = async (voice: object | null, playMs = 0) => {
  const requests: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const sent = JSON.parse(body);
      requests.push({ url: req.url ?? '', headers: req.headers, body: sent });
      if (req.url === '/v1/tts') return res.end(`audio of ${sent.text}`);
      res.setHeader('content-type', 'application/json');
      const answers = sent.questions.mood
        ? { react: { probability: 0.9 }, mood: { choice: 'done' } }
        : Object.fromEntries(
            Object.entries<string>(sent.state.parts).map(([name, part]) => [
              name,
              { type: 'boolean', probability: part.includes('.ts') ? 0.1 : 0.9 },
            ]),
          );
      res.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-voice-test-'));
  const played = path.join(dir, 'played.jsonl');
  fs.writeFileSync(played, '');
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'scenario.json'), '{}');
  fs.mkdirSync(path.join(dir, 'config/pixling'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config/pixling/proxy.json'),
    JSON.stringify({
      emote: { endpoint: `${origin}/v4/ai`, apiKey: 'judge-key' },
      ...(voice ? { voice: { endpoint: origin, ...voice } } : {}),
    }),
  );
  const env = {
    ...process.env,
    PIXLING_CLI: path.join(root, 'test/fake-pixling.mjs'),
    PIXLING_PROXY_VOICE_PLAYER: path.join(root, 'test/fake-player.mjs'),
    FAKE_LOG: path.join(dir, 'calls.jsonl'),
    FAKE_SCENARIO: path.join(dir, 'scenario.json'),
    FAKE_PLAYED: played,
    FAKE_PLAY_MS: String(playMs),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    PIXLING_PROXY_DEBUG: path.join(dir, 'proxy.log'),
    PIXLING_PROXY_LANGUAGE: 'en',
    AI_GATEWAY_API_KEY: '',
    FISH_API_KEY: '',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
  };
  const hook = (event: string, payload: object, session = sid) => {
    const res = spawnSync(process.execPath, [HOOK, 'claude-code', event], {
      input: JSON.stringify({ session_id: session, ...payload }),
      encoding: 'utf8',
      env,
    });
    nodeAssert.equal(res.status, 0);
  };
  return {
    requests,
    hook,
    played: () =>
      fs
        .readFileSync(played, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string),
    // The players started so far that still run.
    playing: () =>
      (fs.existsSync(`${played}.pids`) ? fs.readFileSync(`${played}.pids`, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .filter((pid) => spawnSync('kill', ['-0', pid]).status === 0),
    log: () => (fs.existsSync(env.PIXLING_PROXY_DEBUG) ? fs.readFileSync(env.PIXLING_PROXY_DEBUG, 'utf8') : ''),
    calls: () => fs.readFileSync(env.FAKE_LOG, 'utf8'),
    scenario: env.FAKE_SCENARIO,
    close: () => server.close(),
  };
};

const REPLY = '**All tests pass.**\n\n- src/a.ts\n- src/b.ts\n\n```sh\nnpm test\n```\n\nShall I deploy it?';

test('pixling-proxy with emote settings: says the parts of the reply worth hearing, in its tone', async () => {
  const w = await world({ apiKey: 'fish-key', voice: 'voice-1', model: 'fish-model', speed: 1.2 });
  try {
    w.hook('stop', { last_assistant_message: REPLY });
    const played = await until(() => (w.played().length >= 2 ? w.played() : undefined));
    nodeAssert.deepEqual(played, ['audio of [cheerful] All tests pass.', 'audio of [cheerful] Shall I deploy it?']);
    const tts = w.requests.filter((request) => request.url === '/v1/tts');
    nodeAssert.equal(tts[0].headers.authorization, 'Bearer fish-key');
    nodeAssert.equal(tts[0].headers.model, 'fish-model');
    nodeAssert.deepEqual(tts[0].body, {
      text: '[cheerful] All tests pass.',
      format: 'mp3',
      reference_id: 'voice-1',
      prosody: { speed: 1.2, volume: 0 },
    });
    // The mood is asked once, for the reaction and the voice both; the parts once.
    const judged = w.requests.filter((request) => request.url !== '/v1/tts');
    nodeAssert.equal(judged.filter((request) => request.body.questions.mood).length, 1);
    nodeAssert.deepEqual(
      judged.filter((request) => !request.body.questions.mood).map((request) => request.body.state.parts),
      [{ p1: 'All tests pass.', p2: 'src/a.ts. src/b.ts.', p3: 'Shall I deploy it?' }],
    );
    // Neither key, nor what was said, is in an argument or the log.
    await until(() => (/voice parts=3 said=2 .* ok/.test(w.log()) ? true : undefined));
    nodeAssert.ok(!/fish-key|judge-key/.test(w.calls() + w.log()));
    nodeAssert.ok(!/deploy/.test(w.log()));
  } finally {
    w.close();
  }
}, 30_000);

test('pixling-proxy with emote settings: without voice settings nothing is sent to be spoken', async () => {
  const w = await world(null);
  try {
    w.hook('stop', { last_assistant_message: REPLY });
    await until(() => (/sequence","start/.test(w.calls()) ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 300));
    nodeAssert.deepEqual(w.played(), []);
    nodeAssert.equal(w.requests.length, 1);
  } finally {
    w.close();
  }
}, 30_000);

test("pixling-proxy with emote settings: the user's next prompt stops the voice", async () => {
  const w = await world({ apiKey: 'fish-key' }, 30_000);
  try {
    w.hook('stop', { last_assistant_message: 'One thing is done.\n\nAnother thing is done.' });
    await until(() => (w.played().length === 1 ? true : undefined));
    w.hook('prompt', { prompt: 'next' });
    // The player was stopped mid-way, and the second part is never played.
    await until(() => (w.playing().length === 0 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 500));
    nodeAssert.equal(w.played().length, 1);
  } finally {
    w.close();
  }
}, 30_000);

test('pixling-proxy with emote settings: two sessions speak one after the other', async () => {
  const w = await world({ apiKey: 'fish-key', tone: false }, 600);
  try {
    w.hook('stop', { last_assistant_message: 'First session.' });
    w.hook('stop', { last_assistant_message: 'Second session.' }, 'e3c1d2e4-0000-4000-8000-00000000000b');
    await until(() => (w.log().match(/voice parts=1 said=1 .* ok/g)?.length === 2 ? true : undefined));
    const times = [...w.log().matchAll(/^(\S+) .* voice parts=1 said=1 .* ok/gm)].map((m) => Date.parse(m[1]));
    nodeAssert.equal(w.played().length, 2);
    // The second waited for the first to be heard out.
    nodeAssert.ok(Math.abs(times[1] - times[0]) >= 500, `apart by ${Math.abs(times[1] - times[0])} ms`);
  } finally {
    w.close();
  }
}, 30_000);

test('pixling-proxy with emote settings: a permission card is also heard, by its question alone', async () => {
  const w = await world({ apiKey: 'fish-key' });
  try {
    fs.writeFileSync(
      w.scenario,
      JSON.stringify({
        'question ask': { exit: 0, result: { promptID: 'q1', state: 'answered', selectedChoiceID: 'allow' } },
      }),
    );
    // The session has its resident.
    w.hook('session-start', { source: 'startup' });
    w.hook('permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf secret-dir' } });
    const played = await until(() => (w.played().length ? w.played() : undefined));
    nodeAssert.deepEqual(played, ['audio of [curious] Allow Bash?']);
    // Nothing of the call is sent to be spoken, and the judge is not asked.
    nodeAssert.deepEqual(
      w.requests.map((request) => request.url),
      ['/v1/tts'],
    );
    nodeAssert.ok(!JSON.stringify(w.requests).includes('secret-dir'));
  } finally {
    w.close();
  }
}, 30_000);
