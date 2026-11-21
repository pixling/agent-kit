// The emote settings: the `emote` object in ~/.config/pixling/proxy.json, which the
// rest of the proxy never reads.
import { Option, Predicate, Schema } from 'effect';
import { readSettings } from '../../core/config.ts';

export interface EmoteConfig {
  // Where the reply is judged: an evaluation API in the Vercel AI Gateway's form
  // (POST <endpoint>/evaluation-model).
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  // How sure the judge must be that the reply is worth a reaction, 0...1.
  readonly threshold: number;
}

export const DEFAULT_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai';
export const DEFAULT_MODEL = 'typesafe-ai/jev';
export const DEFAULT_KEY_ENV = 'AI_GATEWAY_API_KEY';
const DEFAULT_THRESHOLD = 0.5;

export const Text = Schema.NonEmptyString;
const Threshold = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

// Each field on its own, as in the proxy's settings: one wrong value costs only itself.
export const field = <A>(schema: Schema.Decoder<A>, value: unknown): A | undefined =>
  Schema.decodeUnknownOption(schema)(value).pipe(Option.getOrUndefined);

// Only a service on this Mac may be reached over plain http: the key travels in a header.
export const isSafe = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Null unless the settings have an `emote` object and a key is found: the reply leaves
// the machine only when asked to, not because some variable happens to hold a key.
// The resident then moves for the reply as for any message.
export function emoteConfig(
  settingsFile: Record<string, unknown> = readSettings(),
  env: NodeJS.ProcessEnv = process.env,
): EmoteConfig | null {
  const raw = settingsFile.emote;
  if (!Predicate.isObject(raw)) return null;
  const settings = raw as Record<string, unknown>;
  // The key itself, or the name of the variable that holds it.
  const apiKey = field(Text, settings.apiKey) ?? env[field(Text, settings.apiKeyEnv) ?? DEFAULT_KEY_ENV]?.trim();
  const endpoint = (field(Text, settings.endpoint) ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (!apiKey || !isSafe(endpoint)) return null;
  return {
    endpoint,
    model: field(Text, settings.model) ?? DEFAULT_MODEL,
    apiKey,
    threshold: field(Threshold, settings.threshold) ?? DEFAULT_THRESHOLD,
  };
}
