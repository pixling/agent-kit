// The hook program for hosts with command hooks, and the one place that lists them.
// Each plugin's hook-main starts it, with what that plugin adds to a session.
//
// usage: hook.mjs <host> <event>
//
// Reads the hook payload (JSON) on stdin and writes the host's hook output on
// stdout. Every failure is silent and exits 0, so a missing Pixling never gets in
// the agent's way. Only `wait` exits 2, on purpose, to wake a host that wakes on it.
import type { Layer } from 'effect';
import { Antigravity } from '../adapters/antigravity/index.ts';
import { ClaudeCode } from '../adapters/claude-code/index.ts';
import { Codex } from '../adapters/codex/index.ts';
import type { SessionExtension } from '../runtimes/base.ts';
import { isHookEvent } from '../runtimes/hook/events.ts';
import type { HookHost } from '../runtimes/hook/HookHost.ts';
import { runHook } from '../runtimes/hook/main.ts';

const ADAPTERS: Record<string, Layer.Layer<HookHost>> = {
  'claude-code': ClaudeCode,
  codex: Codex,
  antigravity: Antigravity,
};

export function startHook(extension?: SessionExtension): void {
  const [hostId, event] = process.argv.slice(2);
  const adapter = Object.hasOwn(ADAPTERS, hostId) ? ADAPTERS[hostId] : null;
  if (adapter && isHookEvent(event)) runHook(adapter, event, extension);
  else process.stdout.write('{}');
}
