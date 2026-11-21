// Finds the `pixling` CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  path.join(os.homedir(), '.local/bin/pixling'),
  '/Applications/Pixling.app/Contents/MacOS/pixling',
  '/opt/homebrew/bin/pixling',
  '/usr/local/bin/pixling',
];

// PIXLING_CLI wins; then PATH; then the usual install locations.
export function cliPath(): string {
  if (process.env.PIXLING_CLI) return process.env.PIXLING_CLI;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'pixling');
    if (isExecutable(p)) return p;
  }
  for (const p of CANDIDATES) if (isExecutable(p)) return p;
  return 'pixling';
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
