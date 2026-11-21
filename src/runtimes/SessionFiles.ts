// The session's memory on disk: a state file, claims and locks under the cache
// directory, shared by every process of one host session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { CurrentSession, SessionStore, type Shown } from '../core/services.ts';
import { alive, startedAt, terminate } from './process.ts';

const SAFE = /[^A-Za-z0-9._-]/g;
const MAX_KEY_LENGTH = 128;
// Longer than any single read of the inbox can take.
const CLAIM_EXPIRES_MS = 120_000;
// What the agent is doing is nobody else's business, even without message bodies.
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
// A session not touched for this long is gone, and a resident left from it is the
// app's to recover: its directory only holds what can be read again.
const FORGET_AFTER_MS = 30 * 24 * 3600 * 1000;
const FORGET_EVERY_MS = 24 * 3600 * 1000;

interface State {
  bound?: boolean;
  stowed?: boolean;
  since?: number;
  shown?: Shown;
  transcript?: Cursor;
}

// How far a transcript has been shown, and what a hook payload said since.
export interface Cursor {
  readonly path?: string | undefined;
  readonly offset: number;
  // Fingerprints of final replies shown before their transcript line.
  readonly ahead: ReadonlyArray<string>;
  // Tool calls waiting to show: only their names, never what was said.
  readonly tools: ReadonlyArray<string>;
  // How many stretches have been shown.
  readonly stretch: number;
}

export class TranscriptCursor extends Context.Service<
  TranscriptCursor,
  {
    readonly get: Effect.Effect<Cursor | null>;
    set(cursor: Cursor): Effect.Effect<void>;
  }
>()('pixling-proxy/runtimes/TranscriptCursor') {}

// Locks shared by the processes of a session.
export class SessionLocks extends Context.Service<
  SessionLocks,
  {
    // A lock held by one live process; one left by a dead process is taken over.
    lock(name: string): Effect.Effect<boolean>;
    // Moves a lock to another process (a daemon just started), keeping it held.
    handOver(name: string, pid: number): Effect.Effect<void>;
    unlock(name: string, pid?: number): Effect.Effect<void>;
    // Stops the live process holding a lock and frees it. Its pid, or 0 when nothing held it.
    stopHolder(name: string): Effect.Effect<number>;
  }
>()('pixling-proxy/runtimes/SessionLocks') {}

const cacheBase = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pixling-proxy');

const stateDir = (namespace: string, key: string): string => {
  return path.join(cacheBase(), namespace.replace(SAFE, '_'), key.replace(SAFE, '_'));
};

const removeFile = (file: string): void => {
  try {
    fs.rmSync(file);
  } catch {
    // Already gone, or another process took it over first.
  }
};

// Never leaves a half-written file for another process to read.
const writeWhole = (file: string, content: string): void => {
  // One temporary file per process: hooks of one session often write at the same moment.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: PRIVATE_FILE });
  fs.renameSync(tmp, file);
};

// The session's memory helps the conversation but never decides it: a cache
// directory that cannot be written must not cost the agent's reply.
const total = <A>(operation: string, fallback: A, run: () => A): Effect.Effect<A> =>
  Effect.try({ try: run, catch: (e) => (e as NodeJS.ErrnoException).code ?? 'unknown' }).pipe(
    Effect.catch((code) => Effect.logInfo(`state ${operation} failed: ${code}`).pipe(Effect.as(fallback))),
  );

// A lock names its process by pid and start time, since a pid gets reused.
const holderLine = (pid: number) => `${pid} ${startedAt(pid)}`;

interface Holder {
  readonly pid: number;
  readonly started: string;
}

const parseHolder = (line: string): Holder => {
  const [pid = '', ...started] = line.trim().split(' ');
  return { pid: Number(pid) || 0, started: started.join(' ').trim() };
};

// Could still be the process that took the lock. Without a start time to compare, a
// live pid gets the benefit of the doubt.
const mayHold = ({ pid, started }: Holder): boolean => {
  if (!pid || !alive(pid)) return false;
  const now = started && startedAt(pid);
  return !now || now === started;
};

// Certainly the process that took the lock: the only one this proxy may signal.
const isHolder = ({ pid, started }: Holder): boolean => !!pid && !!started && alive(pid) && startedAt(pid) === started;

const makeStore = (dir: string) => {
  const lockFile = (name: string) => path.join(dir, `${name}.lock`);
  const claimFile = (messageID: string) => path.join(dir, 'claimed', messageID.replace(SAFE, '_'));
  const makeDir = (to: string) => fs.mkdirSync(to, { recursive: true, mode: PRIVATE_DIR });

  // One file per value, each replaced whole: processes of one session often write at
  // the same moment, and one file for all would lose the other's value.
  const read = <K extends keyof State>(key: K): State[K] => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));
    } catch {
      return readLegacy(key);
    }
  };

  // What versions before 0.1.14 wrote.
  const readLegacy = <K extends keyof State>(key: K): State[K] => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as State)[key];
    } catch {
      return undefined;
    }
  };

  const write = <K extends keyof State>(key: K, value: State[K]): void => {
    makeDir(dir);
    writeWhole(path.join(dir, `${key}.json`), JSON.stringify(value));
  };

  const memoFile = (name: string) => path.join(dir, `memo-${name.replace(SAFE, '_')}.json`);
  const readMemo = (name: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(memoFile(name), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const writeMemo = (name: string, value: unknown): void => {
    makeDir(dir);
    writeWhole(memoFile(name), JSON.stringify(value));
  };

  const readHolder = (name: string): Holder | null => {
    try {
      return parseHolder(fs.readFileSync(lockFile(name), 'utf8'));
    } catch {
      return null;
    }
  };

  // A hard link appears whole or fails with EEXIST, so two hooks starting at the same
  // moment cannot both get it, and neither ever reads an empty lock.
  const placeLock = (name: string): void => {
    const tmp = `${lockFile(name)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, holderLine(process.pid), { mode: PRIVATE_FILE });
    try {
      fs.linkSync(tmp, lockFile(name));
    } finally {
      removeFile(tmp);
    }
  };

  const lock = (name: string): boolean => {
    makeDir(dir);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        placeLock(name);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
        const held = readHolder(name);
        if (held && mayHold(held)) return false;
        // Left by a dead process, or just released: try again.
        if (held) removeFile(lockFile(name));
      }
    }
    return false;
  };

  const unlock = (name: string, pid: number): void => {
    if (readHolder(name)?.pid === pid) removeFile(lockFile(name));
  };

  const stopHolder = (name: string): number => {
    const held = readHolder(name);
    if (!held) return 0;
    const running = isHolder(held);
    if (running) terminate(held.pid);
    removeFile(lockFile(name));
    return running ? held.pid : 0;
  };

  const claim = (messageID: string): boolean => {
    const file = claimFile(messageID);
    makeDir(path.dirname(file));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, '', { flag: 'wx' });
        return true;
      } catch {
        // Still unread long after its claim: whoever claimed it died before reading.
        if (Date.now() - fs.statSync(file).mtimeMs < CLAIM_EXPIRES_MS) return false;
        removeFile(file);
      }
    }
    return false;
  };

  const readCursor = (): Cursor | null => {
    const cursor = read('transcript');
    return cursor && typeof cursor.offset === 'number' ? cursor : null;
  };

  return {
    store: SessionStore.of({
      isBound: total('isBound', false, () => read('bound') === true),
      markBound: total('markBound', undefined, () => write('bound', true)),
      isStowed: total('isStowed', false, () => read('stowed') === true),
      markStowed: total('markStowed', undefined, () => write('stowed', true)),
      since: total('since', 0, () => read('since') ?? 0),
      setSince: (since) => total('setSince', undefined, () => write('since', since)),
      claim: (messageID) => total('claim', false, () => claim(messageID)),
      unclaim: (messageID) => total('unclaim', undefined, () => removeFile(claimFile(messageID))),
      shown: total('shown', { at: 0 }, () => read('shown') ?? { at: 0 }),
      setShown: (shown) => total('setShown', undefined, () => write('shown', shown)),
      memo: (name) => total('memo', undefined, () => readMemo(name)),
      setMemo: (name, value) => total('setMemo', undefined, () => writeMemo(name, value)),
    }),
    cursor: TranscriptCursor.of({
      get: total('cursor', null, readCursor),
      set: (cursor) => total('setCursor', undefined, () => write('transcript', cursor)),
    }),
    locks: SessionLocks.of({
      lock: (name) => total('lock', false, () => lock(name)),
      handOver: (name, pid) => total('handOver', undefined, () => writeWhole(lockFile(name), holderLine(pid))),
      unlock: (name, pid = process.pid) => total('unlock', undefined, () => unlock(name, pid)),
      stopHolder: (name) => total('stopHolder', 0, () => stopHolder(name)),
    }),
  };
};

// Locks shared by every session on this Mac, for what only one of them may do at a time.
export const deskLocks = (): SessionLocks['Service'] => makeStore(path.join(cacheBase(), '.desk')).locks;

// Clears out sessions long gone, at most once a day. Called when a session starts.
export const forgetOldSessions = total('forgetOldSessions', undefined, () => {
  const base = cacheBase();
  const stamp = path.join(base, '.forgotten');
  const now = Date.now();
  try {
    if (now - fs.statSync(stamp).mtimeMs < FORGET_EVERY_MS) return;
  } catch {
    // Never yet.
  }
  fs.mkdirSync(base, { recursive: true });
  fs.chmodSync(base, PRIVATE_DIR);
  fs.writeFileSync(stamp, '');
  for (const namespace of fs.readdirSync(base, { withFileTypes: true })) {
    if (!namespace.isDirectory()) continue;
    const parent = path.join(base, namespace.name);
    for (const key of fs.readdirSync(parent)) {
      const dir = path.join(parent, key);
      if (now - fs.statSync(dir).mtimeMs > FORGET_AFTER_MS) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// When the session last did anything: every event of it writes its state directory.
// 0 when it has none (never started, or forgotten).
export const lastActive = (namespace: string, key: string) => (): number => {
  try {
    return fs.statSync(stateDir(namespace, String(key).slice(0, MAX_KEY_LENGTH))).mtimeMs;
  } catch {
    return 0;
  }
};

// One resident per host session, bound as client:<namespace>/<key>.
export const sessionFiles = (session: {
  readonly namespace: string;
  readonly key: string;
  readonly author: string;
}): Layer.Layer<CurrentSession | SessionStore | TranscriptCursor | SessionLocks> => {
  const key = String(session.key).slice(0, MAX_KEY_LENGTH);
  const { store, cursor, locks } = makeStore(stateDir(session.namespace, key));
  return Layer.mergeAll(
    Layer.succeed(CurrentSession)(
      CurrentSession.of({
        namespace: session.namespace,
        key,
        author: session.author,
        selector: `client:${session.namespace}/${key}`,
      }),
    ),
    Layer.succeed(SessionStore)(store),
    Layer.succeed(TranscriptCursor)(cursor),
    Layer.succeed(SessionLocks)(locks),
  );
};
