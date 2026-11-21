// Processes: liveness, the host that ran a hook, and the Node.js runtime for
// the proxy's own background processes.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

// When a process started, or '' when unknown. With its pid, this names one process:
// a pid alone may by now belong to another program.
export function startedAt(pid: number): string {
  return ps(pid, 'lstart=');
}

// The host process that ran this hook: the first ancestor that is not a shell. One
// look at the process table, walked here: one ps, however deep the shells go.
export function findHostPid(start = process.ppid): number | null {
  const parents = new Map<number, { ppid: number; comm: string }>();
  for (const line of psAll('pid=,ppid=,comm=').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) parents.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  let pid = start;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const p = parents.get(pid);
    if (!p) return null;
    if (!/^-?(sh|bash|zsh|dash|fish)$/.test(path.basename(p.comm))) return pid;
    pid = p.ppid;
  }
  return null;
}

// The command line of a process (arguments joined by spaces), or '' when unknown.
// Used to tell a host's one-shot runs (`codex exec`) from sessions with the user.
export function commandLine(pid: number | null): string {
  return pid ? ps(pid, 'args=') : '';
}

// The Node.js binary for the proxy's background processes. A host built as one
// executable (OpenCode is a Bun binary) has its own program as execPath, which
// cannot run a script.
export function nodeRuntime(): string {
  if (process.env.PIXLING_PROXY_NODE) return process.env.PIXLING_PROXY_NODE;
  const isNode = !process.versions.bun && /^node(\.exe)?$/i.test(path.basename(process.execPath));
  return isNode ? process.execPath : 'node';
}

// Synchronous, so nothing else runs while it does, not even a hook's budget: bounded per
// call. Past it, '' as when ps fails: a lock's holder gets the benefit of the doubt, and
// a host's pid is unknown (its daemons then end once its session goes quiet: hostGone).
const PS_TIMEOUT_MS = 2000;

function ps(pid: number, format: string): string {
  return run(['-o', format, '-p', String(pid)]);
}

function psAll(format: string): string {
  return run(['-A', '-o', format]);
}

function run(args: ReadonlyArray<string>): string {
  try {
    return execFileSync('ps', args, { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}
