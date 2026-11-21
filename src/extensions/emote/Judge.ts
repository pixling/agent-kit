// What kind of reply it is, asked of an evaluation API. Only the reply leaves the
// machine, and only when the emote settings have a key (see config.ts).
import { Context, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import type { EmoteConfig } from './config.ts';
import type { Weight } from './during.ts';
import { SPEECH } from '../voice/speech.ts';
import { JUDGE, JUDGE_INTENSITY, type Mood, MOODS, weightOfIntensity } from './reactions.ts';

const TIMEOUT = '10 seconds';
// The headers the AI Gateway's own client sends for an evaluation.
const PROTOCOL_HEADERS = {
  'ai-gateway-protocol-version': '0.0.1',
  'ai-gateway-auth-method': 'api-key',
  'ai-evaluation-model-specification-version': '4',
};

export class JudgeError extends Schema.TaggedError<JudgeError>()('JudgeError', {
  cause: Schema.Defect(),
}) {}

const Answers = Schema.Struct({
  answers: Schema.Struct({
    react: Schema.Struct({ probability: Schema.Finite }),
    mood: Schema.Struct({ choice: Schema.String }),
    intensity: Schema.optional(Schema.Struct({ score: Schema.optional(Schema.Finite) })),
  }),
});

// One answer per part asked about; a part the judge left out is not said.
const Heard = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ probability: Schema.optional(Schema.Finite) })),
});

// What the judge made of a reply: its mood (null: not worth a reaction of its own) and,
// when the reply's weight says more than the turn's length, how big the reaction is.
export interface Verdict {
  readonly mood: Mood | null;
  readonly weight: Weight | null;
}

const isMood = (choice: string): choice is Mood => (MOODS as ReadonlyArray<string>).includes(choice);

export class Judge extends Context.Service<
  Judge,
  {
    // Asked once for a reply, however many ask.
    verdictOf(reply: string): Effect.Effect<Verdict, JudgeError>;
    // How sure it is that each part of a reply is worth saying aloud, 0...1, in order.
    worthSaying(parts: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<number>, JudgeError>;
  }
>()('pixling-proxy/extensions/emote/Judge') {
  static readonly layer = (config: EmoteConfig) =>
    Layer.effect(
      Judge,
      Effect.gen(function* () {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        const ask = <A>(body: object, answer: Schema.Decoder<A>) =>
          HttpClientRequest.post(`${config.endpoint}/evaluation-model`).pipe(
            HttpClientRequest.bearerToken(config.apiKey),
            HttpClientRequest.setHeaders({ ...PROTOCOL_HEADERS, 'ai-model-id': config.model }),
            HttpClientRequest.bodyJsonUnsafe(body),
            client.execute,
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(answer)),
            Effect.timeout(TIMEOUT),
            Effect.mapError((cause) => new JudgeError({ cause })),
          );
        const verdicts = new Map<string, Effect.Effect<Verdict, JudgeError>>();
        const judge = Effect.fn('Judge.verdictOf')(function* (reply: string) {
          const { answers } = yield* ask(
            { state: JUDGE.state(reply), questions: { ...JUDGE.questions, intensity: JUDGE_INTENSITY } },
            Answers,
          );
          const mood = answers.mood.choice;
          return {
            mood: answers.react.probability >= config.threshold && isMood(mood) && mood !== 'neutral' ? mood : null,
            weight: weightOfIntensity(answers.intensity?.score),
          };
        });
        return Judge.of({
          verdictOf: Effect.fnUntraced(function* (reply: string) {
            const asked = verdicts.get(reply) ?? (yield* Effect.cached(judge(reply)));
            verdicts.set(reply, asked);
            return yield* asked;
          }),
          worthSaying: Effect.fn('Judge.worthSaying')(function* (parts: ReadonlyArray<string>) {
            const { answers } = yield* ask({ state: SPEECH.state(parts), questions: SPEECH.questions(parts) }, Heard);
            return parts.map((_, index) => answers[SPEECH.name(index)]?.probability ?? 0);
          }),
        });
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
}
