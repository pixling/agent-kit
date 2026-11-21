// What the resident shows while the agent works: one emoji when a turn starts, when
// the agent turns to another kind of tool, and when it asks for permission. Only an
// emote, never a run: a run would keep the turn's own reaction waiting, and an emote
// shows on a resident whose motion is off too. Pure data and pure functions.
import type { Moment } from '../../core/services.ts';

export type ToolKind = 'read' | 'write' | 'run' | 'web' | 'delegate' | 'ask';
type Shown = ToolKind | 'start' | 'turn' | 'permission';

export const EMOJI: Readonly<Record<Shown, string>> = {
  start: '👋',
  turn: '👀',
  permission: '❗',
  read: '🔍',
  write: '✏️',
  run: '⚙️',
  web: '🌐',
  delegate: '🤝',
  ask: '❓',
};

// Tool names as the hosts spell them (Read, read_file, apply_patch, exec_command, ...).
// The first match decides; a tool none of them names shows nothing.
const KINDS: ReadonlyArray<readonly [RegExp, ToolKind | null]> = [
  // The agent works the resident itself, or keeps its own notes.
  [/^mcp__pixling__|todo|^task(create|update|list|get|output|stop)$/i, null],
  [/^ask|question/i, 'ask'],
  [/^(task|agent)$|^spawn/i, 'delegate'],
  [/web|fetch|browser|navigate/i, 'web'],
  [/edit|write|patch|notebook/i, 'write'],
  [/(^|_)read|grep|glob|^ls$|list|search|find|view/i, 'read'],
  [/bash|shell|exec|command|terminal|run/i, 'run'],
];

export const toolKind = (name: string): ToolKind | null => KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? null;

// What showed last, for the session.
export interface LastShown {
  readonly kind: string;
  readonly at: number;
}

// Not more often than this, so the emoji stay a glance and not a stream.
export const MIN_GAP_MS = 6_000;
// After a turn's start or a permission prompt, only until their emoji is gone (an
// emote floats for about two seconds).
export const AFTER_ALWAYS_MS = 2_000;
// The same kind again only after this: a long stretch of reading shows now and then.
export const SAME_KIND_GAP_MS = 30_000;

// The emoji for the moment, or null when it would come too soon after the last one.
// A turn's start and a permission prompt always show.
export const emojiFor = (
  moment: Moment,
  last: LastShown | undefined,
  now: number,
): { kind: Shown; text: string } | null => {
  if (moment.kind === 'end') return null;
  const kind: Shown | null = moment.kind === 'tool' ? toolKind(moment.name) : moment.kind;
  if (!kind) return null;
  if (moment.kind === 'tool' && last) {
    const since = now - last.at;
    const always = last.kind === 'start' || last.kind === 'turn' || last.kind === 'permission';
    if (since < (always ? AFTER_ALWAYS_MS : MIN_GAP_MS) || (kind === last.kind && since < SAME_KIND_GAP_MS)) {
      return null;
    }
  }
  return { kind, text: EMOJI[kind] };
};

// The resident's state while the agent works, by name. A name shows only on a resident
// whose asset has a look for it (`pixling status define`); the proxy saves none itself.
export const WORKING = 'working';
// While a permission card waits on the resident.
export const ASKING = 'asking';
// A state is sent again after this long, before the desk lets it lapse (10 minutes).
export const STATUS_RENEW_MS = 5 * 60_000;

// What the session last knew about the resident's state.
export interface StatusMemo {
  // The names its asset has a look for, read once a turn; null: not read this turn.
  readonly defined: ReadonlyArray<string> | null;
  // The state it shows now, as far as this session set it.
  readonly name: string | null;
  readonly at: number;
}

// The state for the moment: the kind of tool's own (`working.read`, ...) when the asset
// has a look for it, else plain `working`. Null: none has a look, or the moment has none.
export const statusFor = (moment: Moment, defined: ReadonlyArray<string>): string | null => {
  if (moment.kind !== 'turn' && moment.kind !== 'tool') return null;
  const kind = moment.kind === 'tool' ? toolKind(moment.name) : null;
  const own = kind ? `${WORKING}.${kind}` : null;
  return own && defined.includes(own) ? own : defined.includes(WORKING) ? WORKING : null;
};

// How much work the turn was, by how long it took: a quick answer gets a small
// reaction and a long job a big one.
export type Weight = 'light' | 'normal' | 'heavy';
export const LIGHT_UNDER_MS = 45_000;
export const HEAVY_FROM_MS = 8 * 60_000;
// `startedAt`: when the turn began, as far as the session saw (null: it did not).
export const weightOf = (startedAt: number | null, now: number): Weight => {
  if (startedAt === null || now < startedAt) return 'normal';
  const took = now - startedAt;
  return took < LIGHT_UNDER_MS ? 'light' : took >= HEAVY_FROM_MS ? 'heavy' : 'normal';
};
