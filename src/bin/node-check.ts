// Whether this Node.js can run the proxy, checked with nothing else loaded: on an
// older one, the hook answers as if there were nothing to do rather than fail in the
// agent's way. Imports nothing, so it loads on any version.
const MIN_MINOR_OF_22 = 19;

export function recentNode(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= MIN_MINOR_OF_22);
}

export function answerIdle(): void {
  const [host, event] = process.argv.slice(2);
  // Antigravity denies a tool call that gets no decision (see its adapter's `passTool`).
  process.stdout.write(host === 'antigravity' && event === 'before-tool' ? '{"decision":"ask"}' : '{}');
}
