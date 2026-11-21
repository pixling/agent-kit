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
const refused = raw.findIndex(
  (a, i) => /^--[^=]+$/.test(a) && a !== '--clear' && (raw[i + 1] === undefined || raw[i + 1].startsWith('-')),
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
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n');
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
