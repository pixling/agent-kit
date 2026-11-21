// Where hook processes find what the agent did: its prose in the host's transcript
// (JSONL), tool calls from their payloads. The transcript is its own buffer, so no
// body is written to disk: a cursor in the session store remembers how far it has been
// shown, and only moves once it has. Hooks that run at the same moment take turns.
//
// The turn's end shows the final reply from its payload, often before the transcript
// has it: that text is remembered by fingerprint and skipped when its line turns up.
import fs from 'node:fs';
import { Effect, Layer, Option, Schedule } from 'effect';
import { type Activity, fingerprint } from '../../core/Activity.ts';
import { ActivitySource, CurrentSession } from '../../core/services.ts';
import { type Cursor, SessionLocks, TranscriptCursor } from '../SessionFiles.ts';
import { HookHost } from './HookHost.ts';

// Final replies shown ahead of the transcript, still to be skipped there.
const AHEAD_MAX = 8;
// Tool calls kept waiting, the newest ones, should nothing get them to the resident.
const WAITING_TOOLS_MAX = 200;
// Hooks of one session take turns; one send takes well under this.
const LOCK_WAIT_MS = 5000;
const LOCK_POLL = '50 millis';
// The host writes its transcript a little after the hook starts: how long to wait
// for the tool call's own line, which comes after the text before it.
const FLUSH_WAIT_MS = 3000;
const FLUSH_POLL = '100 millis';
const TAIL_BYTES = 256 * 1024;
// How far back the last assistant text is looked for.
const LAST_TEXT_LINES = 200;

const size = (file: string): number | null => {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
};

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

// What the lines after `offset` show, and where the last complete line ends. A line
// still being written waits for the next call.
const newActivities = (
  file: string,
  offset: number,
  activitiesOf: (row: unknown) => ReadonlyArray<Activity>,
): { items: Activity[]; offset: number } => {
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const end = fs.fstatSync(fd).size;
      // The transcript was replaced (shorter than where we were): start at its end.
      if (end < offset) return { items: [], offset: end };
      buf = Buffer.alloc(end - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { items: [], offset };
  }
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return { items: [], offset };
  const items = buf
    .subarray(0, last)
    .toString('utf8')
    .split('\n')
    .flatMap((line) => activitiesOf(parse(line)));
  return { items, offset: offset + last + 1 };
};

const mentions = (file: string, needle: string): boolean => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const end = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, end));
      fs.readSync(fd, buf, 0, buf.length, end - buf.length);
      return buf.toString('utf8').includes(needle);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Nothing to wait for.
    return true;
  }
};

// Waits until the transcript has a line mentioning `id` (the tool call that started
// this hook), so the text written before it is there too.
export const untilWritten = (file: string, id: string) =>
  Effect.sync(() => mentions(file, JSON.stringify(id))).pipe(
    Effect.repeat({ until: Boolean, schedule: Schedule.spaced(FLUSH_POLL) }),
    Effect.timeoutOption(FLUSH_WAIT_MS),
    Effect.asVoid,
  );

// Fallback for hosts that do not pass the final text: the last assistant text.
export const lastAssistantText = (
  file: string | null | undefined,
  activitiesOf: (row: unknown) => ReadonlyArray<Activity>,
) => {
  if (!file) return null;
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  } catch {
    return null;
  }
  for (const line of lines.slice(-LAST_TEXT_LINES).reverse()) {
    const text = activitiesOf(parse(line)).findLast((item) => item.kind === 'text');
    if (text?.text.trim()) return text.text;
  }
  return null;
};

const startingAtEnd = (file: string | null | undefined): Cursor => ({
  path: file ?? undefined,
  offset: (file && size(file)) || 0,
  ahead: [],
  tools: [],
  stretch: 0,
});

// Starts reading at the end of the transcript, so a resumed session does not replay its history.
export const startReading = Effect.fn('startReading')(function* (file: string | null | undefined) {
  if (!file) return;
  const cursor = yield* TranscriptCursor;
  // A resumed session keeps counting: its stretches must not be mistaken for old ones.
  const stored = yield* cursor.get;
  yield* cursor.set({ ...startingAtEnd(file), stretch: stored?.stretch ?? 0 });
});

export const transcriptActivities = (file: string | null | undefined) =>
  Layer.effect(ActivitySource)(
    Effect.gen(function* () {
      const host = yield* HookHost;
      const position = yield* TranscriptCursor;
      const locks = yield* SessionLocks;
      const session = yield* CurrentSession;

      const takingTurns = <A, E, R>(program: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const held = yield* locks
            .lock('reader')
            .pipe(
              Effect.repeat({ until: Boolean, schedule: Schedule.spaced(LOCK_POLL) }),
              Effect.timeoutOption(LOCK_WAIT_MS),
            );
          if (Option.isNone(held)) {
            yield* Effect.logInfo(`${session.selector} transcript: lock busy`);
            return;
          }
          yield* program.pipe(Effect.ensuring(locks.unlock('reader')));
        });

      // Installed mid-session, or the transcript moved: start from here.
      const current = Effect.map(position.get, (stored): Cursor => {
        if (stored && (!file || stored.path === file)) return stored;
        return { ...startingAtEnd(file), tools: stored?.tools ?? [], stretch: stored?.stretch ?? 0 };
      });

      return ActivitySource.of({
        observe: (activity) =>
          activity.kind !== 'tool'
            ? Effect.void
            : takingTurns(
                Effect.gen(function* () {
                  const cursor = yield* current;
                  yield* position.set({
                    ...cursor,
                    tools: [...cursor.tools, activity.name].slice(-WAITING_TOOLS_MAX),
                  });
                }),
              ),

        drain: (show) =>
          takingTurns(
            Effect.gen(function* () {
              const cursor = yield* current;
              const read = cursor.path
                ? newActivities(cursor.path, cursor.offset, host.activitiesOf)
                : { items: [], offset: cursor.offset };
              let ahead = cursor.ahead;
              const prose = read.items.filter((item) => {
                if (item.kind !== 'text') return true;
                const seen = fingerprint(item.text);
                if (!ahead.includes(seen)) return true;
                ahead = ahead.filter((known) => known !== seen);
                return false;
              });
              // Tool calls last: the usual order, a text and then what it led to. Held back
              // by `everyMs`, the calls may have come earlier than some of the text.
              const items = [...prose, ...cursor.tools.map((name) => ({ kind: 'tool', name }) as const)];
              const shown = !items.length || (yield* show({ items, position: String(cursor.stretch) }));
              if (shown) {
                yield* position.set({
                  path: cursor.path,
                  offset: read.offset,
                  ahead,
                  tools: [],
                  stretch: cursor.stretch + 1,
                });
              }
            }),
          ),

        // Without the turn, the worst is the reply showing again when its line turns up.
        replied: (text) =>
          takingTurns(
            Effect.gen(function* () {
              const cursor = yield* current;
              yield* position.set({ ...cursor, ahead: [...cursor.ahead, fingerprint(text)].slice(-AHEAD_MAX) });
            }),
          ),
      });
    }),
  );
