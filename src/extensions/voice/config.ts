// The voice settings: the `voice` object in ~/.config/pixling/proxy.json, read only by
// the emote extension, and only once the emote settings are on (the judge picks what is said).
import { Predicate, Schema } from 'effect';
import { readSettings } from '../../core/config.ts';
import { field, isSafe, Text } from '../emote/config.ts';

export interface VoiceConfig {
  // Fish Audio's API: POST <endpoint>/v1/tts.
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  // The voice, by its id in Fish Audio's library (`reference_id`). Null: the model's own.
  readonly voice: string | null;
  // 0.5...2, 1 as recorded.
  readonly speed: number;
  // In dB, -20...20.
  readonly volume: number;
  // How much of one reply is said at most, in characters.
  readonly maxChars: number;
  // How sure the judge must be that a part is worth saying, 0...1.
  readonly threshold: number;
  // The voice takes the tone of the reply (cheerful when the work is done, ...).
  readonly tone: boolean;
}

// The session's lock held by the process that speaks its reply. Stopping its holder
// stops the voice.
export const SPEAKING = 'voice-speaking';

export const DEFAULT_VOICE_ENDPOINT = 'https://api.fish.audio';
export const DEFAULT_VOICE_MODEL = 's2.1-pro';
export const DEFAULT_VOICE_KEY_ENV = 'FISH_API_KEY';
export const DEFAULT_MAX_CHARS = 200;
const DEFAULT_THRESHOLD = 0.5;

const between = (minimum: number, maximum: number) => Schema.Finite.check(Schema.isBetween({ minimum, maximum }));

// Null unless the settings have a `voice` object and a key is found: nothing is sent
// to be spoken because some variable happens to hold a key.
export function voiceConfig(
  settingsFile: Record<string, unknown> = readSettings(),
  env: NodeJS.ProcessEnv = process.env,
): VoiceConfig | null {
  const raw = settingsFile.voice;
  if (!Predicate.isObject(raw)) return null;
  const settings = raw as Record<string, unknown>;
  const apiKey = field(Text, settings.apiKey) ?? env[field(Text, settings.apiKeyEnv) ?? DEFAULT_VOICE_KEY_ENV]?.trim();
  const endpoint = (field(Text, settings.endpoint) ?? DEFAULT_VOICE_ENDPOINT).replace(/\/+$/, '');
  if (!apiKey || !isSafe(endpoint)) return null;
  return {
    endpoint,
    apiKey,
    model: field(Text, settings.model) ?? DEFAULT_VOICE_MODEL,
    voice: field(Text, settings.voice) ?? null,
    speed: field(between(0.5, 2), settings.speed) ?? 1,
    volume: field(between(-20, 20), settings.volume) ?? 0,
    maxChars: field(between(1, 2000), settings.maxChars) ?? DEFAULT_MAX_CHARS,
    threshold: field(between(0, 1), settings.threshold) ?? DEFAULT_THRESHOLD,
    tone: field(Schema.Boolean, settings.tone) ?? true,
  };
}
