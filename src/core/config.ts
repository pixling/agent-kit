// User settings for the proxy: ~/.config/pixling/proxy.json, then PIXLING_PROXY_* env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Option, Schema } from 'effect';
import type { ShowPolicy } from './Activity.ts';

export const LANGUAGES = ['en', 'ja', 'zh-Hant', 'ko'] as const;
export type Language = (typeof LANGUAGES)[number];

const LANGUAGE_BY_LOWER: Readonly<Record<string, Language>> = Object.fromEntries(
  LANGUAGES.map((lang) => [lang.toLowerCase(), lang]),
);

// Same rule as the macOS app: Japanese is `ja`, Korean is `ko`, Traditional Chinese
// (`zh-Hant…`, `zh-TW`, `zh-HK`, `zh-MO`) is `zh-Hant`, and anything else falls back to `en`.
export function languageFromLocale(locale: string): Language {
  const base = locale.split(/[.@]/, 1)[0] ?? '';
  const [primary, secondary] = base.toLowerCase().split(/[-_]/).filter(Boolean);
  if (primary === 'ja') return 'ja';
  if (primary === 'ko') return 'ko';
  if (primary === 'zh' && (secondary === 'hant' || secondary === 'tw' || secondary === 'hk' || secondary === 'mo')) {
    return 'zh-Hant';
  }
  return 'en';
}

export interface Config {
  // Resident for a new session: a zukan selector (No.N), exact name or id, or a
  // list of them to spread sessions across several residents. `random` stands for
  // any resident in the zukan (one per session, always the same for that session).
  asset: string | string[];
  // Agent → resident: what shows, and how often.
  show: ShowPolicy;
  // Ask permission prompts on the resident and wait this long before falling back
  // to the host's own prompt. 0 turns it off.
  permissionWaitMs: number;
  // Resident → agent
  receive: boolean;
  // For hosts that cannot be woken from a hook: hold the turn open this long after
  // each reply for the user to answer on the resident (0: off).
  turnEndWaitMs: number;
  // For hosts that run many sessions in one process: a session with no activity for
  // this long stops listening, until its next activity (0: never).
  idleCloseMs: number;
  // Non-interactive runs (one-shot commands, SDK workers) get no resident unless true.
  unattended: boolean;
  // Default follows LANG.
  language: Language;
}

export const DEFAULTS: Omit<Config, 'language'> & { language: Language | null } = {
  asset: 'No.1',
  show: { reply: true, text: true, reasoning: 'none', tools: 'none', everyMs: 0, maxChars: 4000 },
  permissionWaitMs: 60000,
  receive: true,
  turnEndWaitMs: 0,
  idleCloseMs: 6 * 3600 * 1000,
  unattended: false,
  language: null,
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'pixling', 'proxy.json');
}

// The settings file as written, including what only one adapter reads.
export function readSettings(): Record<string, unknown> {
  try {
    const settings: unknown = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
  } catch {
    // Missing or unreadable: defaults.
    return {};
  }
}

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

// A value that does not fit keeps its default: one wrong setting must not cost the rest,
// nor turn into something else on the way (a string in arithmetic, say).
const SCHEMAS = {
  asset: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  permissionWaitMs: NonNegative,
  receive: Schema.Boolean,
  turnEndWaitMs: NonNegative,
  idleCloseMs: NonNegative,
  unattended: Schema.Boolean,
  language: Schema.NullOr(Schema.Literals(LANGUAGES)),
};

const SHOW_SCHEMAS = {
  reply: Schema.Boolean,
  text: Schema.Boolean,
  reasoning: Schema.Literals(['none', 'summary', 'all']),
  tools: Schema.Union([Schema.Literals(['none', 'all']), Schema.Array(Schema.String)]),
  everyMs: NonNegative,
  maxChars: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
};

const setting = <K extends keyof typeof SCHEMAS>(raw: Record<string, unknown>, key: K) =>
  Schema.decodeUnknownOption(SCHEMAS[key] as Schema.Decoder<unknown>)(raw[key]).pipe(
    Option.getOrElse(() => DEFAULTS[key]),
  ) as (typeof DEFAULTS)[K];

const showSetting = <K extends keyof typeof SHOW_SCHEMAS>(raw: Record<string, unknown>, key: K) =>
  Schema.decodeUnknownOption(SHOW_SCHEMAS[key] as Schema.Decoder<unknown>)(raw[key]).pipe(
    Option.getOrElse(() => DEFAULTS.show[key]),
  ) as ShowPolicy[K];

const list = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const givenIn = (env: NodeJS.ProcessEnv) => (name: string, read: (value: string) => unknown) => {
  const value = env[`PIXLING_PROXY_${name}`];
  return value ? read(value) : undefined;
};

const defined = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

// What the environment says, in the settings file's terms.
const fromEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => {
  const given = givenIn(env);
  const on = (value: string) => value !== '0';
  const entries = {
    // Comma-separated for a list: PIXLING_PROXY_ASSET=No.1,No.2,No.7
    asset: given('ASSET', list),
    permissionWaitMs: given('PERMISSION_WAIT_MS', Number),
    receive: given('RECEIVE', on),
    turnEndWaitMs: given('TURN_END_WAIT_MS', Number),
    idleCloseMs: given('IDLE_CLOSE_MS', Number),
    language: given('LANGUAGE', String),
    unattended: given('UNATTENDED', (value) => value === '1'),
  };
  return defined(entries);
};

const showFromEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => {
  const given = givenIn(env);
  return defined({
    reply: given('REPLY', (value) => value !== '0'),
    text: given('TEXT', (value) => value !== '0'),
    reasoning: given('REASONING', String),
    // PIXLING_PROXY_TOOLS=all, none, or a list: Bash,mcp__*,!Read
    tools: given('TOOLS', (value) => (value === 'all' || value === 'none' ? value : list(value))),
    everyMs: given('EVERY_MS', Number),
  });
};

export function loadConfig(): Config {
  const env = process.env;
  const settings = readSettings();
  const raw = { ...settings, ...fromEnv(env) };
  const written = settings.show;
  const show = {
    ...(typeof written === 'object' && written !== null ? (written as Record<string, unknown>) : {}),
    ...showFromEnv(env),
  };
  const rawLanguage = Option.match(Schema.decodeUnknownOption(Schema.String)(raw.language), {
    onNone: () => raw.language,
    onSome: (value) => LANGUAGE_BY_LOWER[value.trim().toLowerCase()] ?? value,
  });
  return {
    asset: setting(raw, 'asset') as Config['asset'],
    show: {
      reply: showSetting(show, 'reply'),
      text: showSetting(show, 'text'),
      reasoning: showSetting(show, 'reasoning'),
      tools: showSetting(show, 'tools'),
      everyMs: showSetting(show, 'everyMs'),
      maxChars: showSetting(show, 'maxChars'),
    },
    permissionWaitMs: setting(raw, 'permissionWaitMs'),
    receive: setting(raw, 'receive'),
    turnEndWaitMs: setting(raw, 'turnEndWaitMs'),
    idleCloseMs: setting(raw, 'idleCloseMs'),
    unattended: setting(raw, 'unattended'),
    language:
      setting({ language: rawLanguage }, 'language') ||
      languageFromLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG || ''),
  };
}
