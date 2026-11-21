// Shared receiver hub registry: lets every active session on this Mac share one
// receiver-daemon process and one multiplexed `pixling inbox receive --multiplex`
// process, instead of spawning 1 Node + 1 CLI process per session.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { alive } from './process.ts';
import { cacheBase, lastActive } from './SessionFiles.ts';

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

export const HUB_LOCK = 'receiver-hub';

export interface HubEntry {
  readonly namespace: string;
  readonly key: string;
  readonly hostPid: number;
  readonly idleCloseMs: number;
  readonly registeredAt: number;
}

export const hubEntriesDir = (): string => path.join(cacheBase(), '.receiver-hub', 'entries');

export const entryId = (namespace: string, key: string): string =>
  createHash('sha256').update(`${namespace}\0${key}`).digest('hex').slice(0, 24);

const entryFile = (namespace: string, key: string): string =>
  path.join(hubEntriesDir(), `${entryId(namespace, key)}.json`);

export const pairKey = (namespace: string, key: string): string => `${namespace}\0${key}`;

export const registerHubEntry = (entry: HubEntry): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      const dir = hubEntriesDir();
      fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
      const file = entryFile(entry.namespace, entry.key);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), { mode: PRIVATE_FILE });
      fs.renameSync(tmp, file);
    } catch {
      // Cache directory unavailable: never block the agent's hook.
    }
  });

export const removeHubEntry = (namespace: string, key: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      fs.rmSync(entryFile(namespace, key));
    } catch {
      // Already removed.
    }
  });

export const readHubEntries = (): HubEntry[] => {
  const dir = hubEntriesDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries: HubEntry[] = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<HubEntry>;
      if (
        typeof raw.namespace === 'string' &&
        raw.namespace.length > 0 &&
        typeof raw.key === 'string' &&
        raw.key.length > 0
      ) {
        entries.push({
          namespace: raw.namespace,
          key: raw.key,
          hostPid: typeof raw.hostPid === 'number' && Number.isFinite(raw.hostPid) ? raw.hostPid : 0,
          idleCloseMs: typeof raw.idleCloseMs === 'number' && Number.isFinite(raw.idleCloseMs) ? raw.idleCloseMs : 0,
          registeredAt:
            typeof raw.registeredAt === 'number' && Number.isFinite(raw.registeredAt) ? raw.registeredAt : Date.now(),
        });
      }
    } catch {
      // Skip unreadable or concurrently replaced entries.
    }
  }
  return entries;
};

// An entry is retired when its host process has exited, OR when the session has been
// quiet for `idleCloseMs` (catching long-lived multi-session hosts without SessionEnd).
export const entryExpiredReason = (
  entry: HubEntry,
  now: number,
  checkAlive: (pid: number) => boolean = alive,
  getLastActive: (namespace: string, key: string) => number = (ns, k) => lastActive(ns, k)(),
): 'hostExited' | 'idle' | null => {
  if (entry.hostPid > 0 && !checkAlive(entry.hostPid)) return 'hostExited';
  if (entry.idleCloseMs > 0) {
    const active = Math.max(entry.registeredAt, getLastActive(entry.namespace, entry.key));
    if (now - active >= entry.idleCloseMs) return 'idle';
  }
  return null;
};
