// A small always-on log for diagnosing the proxy:
// ~/.cache/pixling-proxy/proxy.log (PIXLING_PROXY_DEBUG=<path> moves it, =0 turns it off).
// Rotated to proxy.log.1 past 1 MB. Message bodies are never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function logPath(): string | null {
  const env = process.env.PIXLING_PROXY_DEBUG;
  if (env === '0') return null;
  if (env) return env;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'pixling-proxy', 'proxy.log');
}

export function log(line: string): void {
  const file = logPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 });
  } catch {
    // Nowhere to log.
  }
}
