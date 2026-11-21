// Says a reply aloud, run by the reactor process (bin/emote-reactor.ts) beside the
// resident's reaction: the judge picks the parts worth hearing, Fish Audio turns them
// into speech, and the Mac plays it. Every failure only costs the voice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Clock, Context, Effect, Fiber, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { clip } from '../../core/text.ts';
import { deskLocks, SessionLocks } from '../../runtimes/SessionFiles.ts';
import { Judge } from '../emote/Judge.ts';
import { SPEAKING, type VoiceConfig } from './config.ts';
import { chosen, MAX_PART_CHARS, MAX_PARTS, partsOf, toned } from './speech.ts';

const SYNTHESIS_TIMEOUT = '30 seconds';
// Longer than any one part takes to say.
const PLAY_TIMEOUT = '2 minutes';
const FORCE_KILL_AFTER = '1 second';
// How long a reply waits for another session's voice to finish, before it goes unsaid.
const TURN_TRIES = 100;
const TURN_WAIT = '400 millis';
// One voice at a time on this Mac.
const TURN = 'voice-turn';
// Plays an audio file given as its one argument, and exits when it is through.
const player = (): string => process.env.PIXLING_PROXY_VOICE_PLAYER || 'afplay';

export class VoiceError extends Schema.TaggedError<VoiceError>()('VoiceError', {
  cause: Schema.Defect(),
}) {}

export class Voice extends Context.Service<
  Voice,
  {
    // The text as speech (MP3).
    synthesize(text: string): Effect.Effect<Uint8Array, VoiceError>;
    // Returns once it has been heard to the end. Interrupted, it falls silent.
    play(audio: Uint8Array): Effect.Effect<void, VoiceError>;
  }
>()('pixling-proxy/extensions/voice/Voice') {
  static readonly layer = (config: VoiceConfig) =>
    Layer.effect(
      Voice,
      Effect.gen(function* () {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Only this user may read what was said.
        const dir = yield* Effect.acquireRelease(
          Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-voice-'))),
          (made) => Effect.sync(() => fs.rmSync(made, { recursive: true, force: true })),
        );
        let played = 0;
        return Voice.of({
          synthesize: Effect.fn('Voice.synthesize')(function* (text: string) {
            return yield* HttpClientRequest.post(`${config.endpoint}/v1/tts`).pipe(
              HttpClientRequest.bearerToken(config.apiKey),
              HttpClientRequest.setHeader('model', config.model),
              HttpClientRequest.bodyJsonUnsafe({
                text,
                format: 'mp3',
                ...(config.voice ? { reference_id: config.voice } : {}),
                prosody: { speed: config.speed, volume: config.volume },
              }),
              client.execute,
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.timeout(SYNTHESIS_TIMEOUT),
              Effect.mapError((cause) => new VoiceError({ cause })),
            );
          }),
          play: Effect.fn('Voice.play')(function* (audio: Uint8Array) {
            const file = path.join(dir, `${++played}.mp3`);
            yield* Effect.gen(function* () {
              yield* Effect.sync(() => fs.writeFileSync(file, audio, { mode: 0o600 }));
              const handle = yield* spawner.spawn(
                ChildProcess.make(player(), [file], {
                  stdin: 'ignore',
                  stdout: 'ignore',
                  stderr: 'ignore',
                  forceKillAfter: FORCE_KILL_AFTER,
                }),
              );
              const exit = yield* handle.exitCode;
              if (exit !== ChildProcessSpawner.ExitCode(0)) return yield* Effect.fail(new Error(`player exit ${exit}`));
            }).pipe(
              Effect.scoped,
              Effect.timeout(PLAY_TIMEOUT),
              Effect.mapError((cause) => new VoiceError({ cause })),
              Effect.ensuring(Effect.sync(() => fs.rmSync(file, { force: true }))),
            );
          }),
        });
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
}

// Whose voice is heard, among all the sessions on this Mac.
export class Turn extends Context.Service<
  Turn,
  {
    // True once the turn is this process's.
    readonly take: Effect.Effect<boolean>;
    readonly give: Effect.Effect<void>;
  }
>()('pixling-proxy/extensions/voice/Turn') {
  static readonly layer = Layer.sync(Turn)(() => {
    const locks = deskLocks();
    return Turn.of({ take: locks.lock(TURN), give: locks.unlock(TURN) });
  });
}

// Waits for another session's voice to finish. False: it went on too long.
const awaitTurn = Effect.fnUntraced(function* (turn: Turn['Service']) {
  for (let tries = 0; tries < TURN_TRIES; tries++) {
    if (yield* turn.take) return true;
    yield* Effect.sleep(TURN_WAIT);
  }
  return false;
});

// Each text is heard in order, the next one made while this one plays.
const sayAll = Effect.fnUntraced(function* (texts: ReadonlyArray<string>) {
  const voice = yield* Voice;
  let coming = yield* Effect.forkScoped(voice.synthesize(texts[0]));
  for (let index = 0; index < texts.length; index++) {
    const audio = yield* Fiber.join(coming);
    if (index + 1 < texts.length) coming = yield* Effect.forkScoped(voice.synthesize(texts[index + 1]));
    yield* voice.play(audio);
  }
}, Effect.scoped);

// Takes the session's voice (what it was still saying gives way, and from here on this
// too can be stopped: the user's next prompt does), then says the texts `choose` gives
// once it is this session's turn on the Mac. `choose` also says what to log.
const heard = Effect.fnUntraced(function* <R>(
  to: string,
  choose: Effect.Effect<{ readonly texts: ReadonlyArray<string>; readonly summary: string }, never, R>,
) {
  const locks = yield* SessionLocks;
  const turn = yield* Turn;
  const began = yield* Clock.currentTimeMillis;
  yield* locks.stopHolder(SPEAKING);
  yield* locks.lock(SPEAKING);
  yield* Effect.gen(function* () {
    const { texts, summary } = yield* choose;
    if (!texts.length) return yield* Effect.logInfo(`${to} voice ${summary} silent`);
    if (!(yield* awaitTurn(turn))) return yield* Effect.logInfo(`${to} voice ${summary} no turn`);
    const outcome = yield* sayAll(texts).pipe(
      Effect.as('ok'),
      Effect.catch((error) => Effect.succeed(`failed: ${String(error.cause).slice(0, 200)}`)),
      Effect.ensuring(turn.give),
    );
    const ms = (yield* Clock.currentTimeMillis) - began;
    yield* Effect.logInfo(`${to} voice ${summary} ${outcome} ms=${ms}`);
  }).pipe(Effect.ensuring(locks.unlock(SPEAKING)));
});

// Says what a card on the resident asks, as it is: the user is waited for, so nobody
// judges whether it is worth hearing.
export const announce = Effect.fn('voice.announce')(function* (to: string, question: string, config: VoiceConfig) {
  const text = partsOf(question).join(' ');
  if (!text) return yield* Effect.logInfo(`${to} voice nothing to ask`);
  yield* heard(
    to,
    Effect.succeed({
      texts: [toned(text, config.tone ? 'asking' : null)],
      summary: `question chars=${Array.from(text).length}`,
    }),
  );
});

export const speak = Effect.fn('voice.speak')(function* (to: string, reply: string, config: VoiceConfig) {
  const judge = yield* Judge;
  const parts = partsOf(reply)
    .slice(0, MAX_PARTS)
    .map((part) => clip(part, MAX_PART_CHARS));
  if (!parts.length) return yield* Effect.logInfo(`${to} voice nothing to say`);
  yield* heard(
    to,
    Effect.gen(function* () {
      const [probabilities, mood] = yield* Effect.all(
        [
          judge.worthSaying(parts).pipe(
            Effect.tapError((error) =>
              Effect.logInfo(`${to} voice judge failed: ${String(error.cause).slice(0, 200)}`),
            ),
            // Unjudged, a reply is said by its lead.
            Effect.orElseSucceed(() => [1]),
          ),
          config.tone
            ? judge.verdictOf(reply).pipe(
                Effect.map((verdict) => verdict.mood),
                Effect.orElseSucceed(() => null),
              )
            : Effect.succeed(null),
        ],
        { concurrency: 'unbounded' },
      );
      const texts = chosen(parts, probabilities, config.threshold, config.maxChars);
      const chars = texts.reduce((sum, text) => sum + Array.from(text).length, 0);
      return {
        texts: texts.map((text) => toned(text, mood)),
        summary: `parts=${parts.length} said=${texts.length} chars=${chars} mood=${mood ?? '-'}`,
      };
    }),
  );
});
