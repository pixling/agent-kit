// Reacts to one reply on the resident, says it aloud when the voice settings are on,
// then exits. Started detached by the emote
// extension, with the session and the reply on stdin. The reply came still, so whatever goes wrong
// here, the resident still gets its own motion for a message.
//
// usage: emote-reactor.mjs < {"namespace": "...", "key": "...", "author": "...", "reply": "..."}
// With "ask": true, `reply` is what a card asks, and is only said aloud.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Schema, Stdio, Stream } from 'effect';
import { emoteConfig, Judge, ownMotionFor, react } from '../extensions/emote/index.ts';
import { voiceConfig } from '../extensions/voice/config.ts';
import { announce, speak, Turn, Voice } from '../extensions/voice/speak.ts';
import { describeFailure, ProxyBase } from '../runtimes/base.ts';
import { sessionFiles } from '../runtimes/SessionFiles.ts';

// However the judge or the CLI hangs, the reactor goes.
const REACTION_TIME = '30 seconds';
const FALLBACK_TIME = '10 seconds';
// A voice takes as long as its words, and may wait for another session's first.
const VOICE_TIME = '4 minutes';

const Input = Schema.fromJsonString(
  Schema.Struct({
    namespace: Schema.NonEmptyString,
    key: Schema.NonEmptyString,
    author: Schema.String,
    reply: Schema.String,
    weight: Schema.optional(Schema.Literals(['light', 'normal', 'heavy'])),
    // Only said aloud, as it is: what a card on the resident asks.
    ask: Schema.optional(Schema.Boolean),
  }),
);

// Whatever went wrong, the resident still gets its own motion for a message.
const fallback = (to: string) =>
  ownMotionFor(to).pipe(
    Effect.flatMap((own) => Effect.logInfo(`${to} emote own ${own}`)),
    Effect.timeout(FALLBACK_TIME),
    Effect.ignore,
  );

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
  const { namespace, key, author, reply, weight, ask } = yield* Schema.decodeUnknownEffect(Input)(text);
  const session = sessionFiles({ namespace, key, author });
  const to = `client:${namespace}/${key}`;
  const config = emoteConfig();
  const voice = voiceConfig();
  if (ask) {
    if (!voice) return;
    return yield* announce(to, reply, voice).pipe(
      Effect.provide(Layer.mergeAll(Voice.layer(voice), Turn.layer, session)),
      Effect.timeout(VOICE_TIME),
      Effect.catchCause((cause) => Effect.logInfo(`${to} voice failed: ${describeFailure(cause)}`)),
    );
  }
  if (!config) return yield* Effect.logInfo(`${to} emote failed: no emote settings`).pipe(Effect.andThen(fallback(to)));
  const reaction = react(to, reply, weight).pipe(
    Effect.timeout(REACTION_TIME),
    Effect.catchCause((cause) =>
      Effect.logInfo(`${to} emote failed: ${describeFailure(cause)}`).pipe(Effect.andThen(fallback(to))),
    ),
  );
  const speech = voice
    ? speak(to, reply, voice).pipe(
        Effect.provide(Layer.merge(Voice.layer(voice), Turn.layer)),
        Effect.timeout(VOICE_TIME),
        Effect.catchCause((cause) => Effect.logInfo(`${to} voice failed: ${describeFailure(cause)}`)),
      )
    : Effect.void;
  // One judge for both: the reply's mood is asked once.
  yield* Effect.all([reaction, speech], { concurrency: 'unbounded', discard: true }).pipe(
    Effect.provide(Layer.merge(Judge.layer(config), session)),
  );
});

program.pipe(
  Effect.catchCause((cause) => Effect.logInfo(`emote reactor: ${describeFailure(cause)}`)),
  Effect.provide(Layer.mergeAll(ProxyBase, NodeServices.layer)),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
