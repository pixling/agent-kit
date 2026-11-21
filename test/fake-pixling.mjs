#!/usr/bin/env node
// A stand-in for the `pixling` CLI. Appends argv to $FAKE_LOG (one JSON line) and
// answers from $FAKE_SCENARIO: {"<subcommand> <verb>": response | [responses...]},
// where a response is {"exit": n, "result": {...}} or {"exit": n, "error": {...}}.
// Arrays are consumed in order; the last element repeats.
//
// Like the real CLI, it refuses an option whose separate value starts with `-`, with
// exit 64 and nothing sent (a switch, such as `--clear`, takes none). `--name=value` is logged as two arguments, `--name` `value`.
import fs from 'node:fs';

const raw = process.argv.slice(2).filter((a) => a !== '--json');
const SWITCHES = new Set(['--clear', '--multiplex']);
const refused = raw.findIndex(
  (a, i) => /^--[^=]+$/.test(a) && !SWITCHES.has(a) && (raw[i + 1] === undefined || raw[i + 1].startsWith('-')),
);
if (refused >= 0) {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['refused', raw[refused]]) + '\n');
  process.stderr.write(`Error: Missing value for '${raw[refused]} <value>'\n`);
  process.exit(64);
}
const args = raw.flatMap((a) => {
  const m = a.match(/^(--[^=]+)=([\s\S]*)$/);
  return m ? [m[1], m[2]] : [a];
});
const isMultiplex = args[0] === 'inbox' && args[1] === 'receive' && args.includes('--multiplex');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(isMultiplex ? ['inbox', 'receive-multiplex'] : args) + '\n');
// What Desk calls. Anything else would fail on the real CLI too.
const KNOWN = [
  'resident ensure',
  'resident describe',
  'resident emote',
  'resident status',
  'message send',
  'question ask',
  'question result',
  'question cancel',
  'inbox watch',
  'inbox wait',
  'inbox read',
  'inbox receive',
  'sequence start',
  'sequence list',
  'zukan',
];
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const op = args[0] === 'zukan' ? 'zukan' : args.slice(0, 2).join(' ');
if (!KNOWN.includes(op)) {
  process.stderr.write(`Error: Unknown command '${op}'\n`);
  process.exit(64);
}
if (op === 'inbox receive' && args.includes('--multiplex')) {
  const muxScenario = scenario['inbox receive --multiplex'];
  if (muxScenario && typeof muxScenario.exit === 'number' && muxScenario.exit !== 0) {
    process.exit(muxScenario.exit);
  }
  const HOLD_ENDS = { 0: 'closed', 64: 'invalid', 5: 'notBound' };
  const active = new Map();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const cmd = JSON.parse(line);
        const id = `${cmd.namespace}\0${cmd.key}`;
        if (cmd.op === 'add' && !active.has(id)) {
          fs.appendFileSync(
            process.env.FAKE_LOG,
            JSON.stringify(['inbox', 'receive', '--namespace', cmd.namespace, '--key', cmd.key]) + '\n',
          );
          const r = scenario['inbox receive'] ?? { exit: 0, result: {} };
          if (r.hold) {
            active.set(id, true);
          } else {
            const code = r.exit ?? (r.error ? 5 : 0);
            const end = HOLD_ENDS[code] ?? 'retry';
            process.stdout.write(
              JSON.stringify({ event: 'ended', namespace: cmd.namespace, key: cmd.key, end, code }) + '\n',
            );
          }
        } else if (cmd.op === 'remove') {
          active.delete(id);
          fs.appendFileSync(
            process.env.FAKE_LOG,
            JSON.stringify(['inbox', 'receive', '--remove', '--namespace', cmd.namespace, '--key', cmd.key]) + '\n',
          );
        }
      }
      nl = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  const DEFAULTS = { 'resident ensure': { exit: 0, result: { state: 'onDesk' } } };
  let r = scenario[op] ?? DEFAULTS[op] ?? { exit: 0, result: {} };
  if (Array.isArray(r)) {
    const counter = `${process.env.FAKE_SCENARIO}.${op.replace(/\W/g, '_')}`;
    const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(i + 1));
    r = r[Math.min(i, r.length - 1)];
  }
  const doc = r.error
    ? { ok: false, operation: op, error: r.error }
    : { ok: true, operation: op, result: r.result ?? {} };
  process.stdout.write(JSON.stringify(doc) + '\n');
  process.exit(r.exit ?? (r.error ? 5 : 0));
}
