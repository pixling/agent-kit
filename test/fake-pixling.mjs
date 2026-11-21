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
const isReceiveMultiplex = args[0] === 'inbox' && args[1] === 'receive' && args.includes('--multiplex');
const isWaitMultiplex = args[0] === 'inbox' && args[1] === 'wait' && args.includes('--multiplex');
fs.appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify(
    isReceiveMultiplex ? ['inbox', 'receive-multiplex'] : isWaitMultiplex ? ['inbox', 'wait-multiplex'] : args,
  ) + '\n',
);
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
} else if (op === 'inbox wait' && args.includes('--multiplex')) {
  let muxScenario = scenario['inbox wait --multiplex'];
  if (Array.isArray(muxScenario)) {
    const counter = `${process.env.FAKE_SCENARIO}.wait_mux`;
    const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(i + 1));
    muxScenario = muxScenario[Math.min(i, muxScenario.length - 1)];
  }
  if (muxScenario && typeof muxScenario.exit === 'number' && muxScenario.exit !== 0) {
    process.exit(muxScenario.exit);
  }
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
        if (cmd.op === 'add') {
          fs.appendFileSync(
            process.env.FAKE_LOG,
            JSON.stringify([
              'inbox',
              'wait',
              '--namespace',
              cmd.namespace,
              '--key',
              cmd.key,
              '--since',
              String(cmd.since ?? 0),
            ]) + '\n',
          );
          const perKey = scenario[`inbox wait ${cmd.key}`];
          let r = perKey ?? scenario['inbox wait'] ?? { exit: 0, result: { messages: [] } };
          if (Array.isArray(r)) {
            const counter = `${process.env.FAKE_SCENARIO}.wait_${cmd.key}`;
            const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
            fs.writeFileSync(counter, String(i + 1));
            r = r[Math.min(i, r.length - 1)];
          }
          if (r.hold) {
            active.set(id, true);
          } else if (r.error || (typeof r.exit === 'number' && r.exit !== 0)) {
            process.stdout.write(
              JSON.stringify({
                event: 'ended',
                namespace: cmd.namespace,
                key: cmd.key,
                reason: r.error?.detail ?? r.error?.code ?? 'refused',
                code: r.exit ?? 5,
              }) + '\n',
            );
          } else if ((r.result?.messages ?? []).length > 0) {
            process.stdout.write(
              JSON.stringify({
                event: 'arrived',
                namespace: cmd.namespace,
                key: cmd.key,
                messages: r.result.messages,
              }) + '\n',
            );
          } else {
            active.set(id, true);
          }
        } else if (cmd.op === 'remove') {
          active.delete(id);
          fs.appendFileSync(
            process.env.FAKE_LOG,
            JSON.stringify(['inbox', 'wait', '--remove', '--namespace', cmd.namespace, '--key', cmd.key]) + '\n',
          );
        }
      }
      nl = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  const DEFAULTS = { 'resident ensure': { exit: 0, result: { state: 'onDesk' } } };
  const keyIdx = args.indexOf('--key');
  const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
  let r = (key && scenario[`${op} ${key}`]) ?? scenario[op] ?? DEFAULTS[op] ?? { exit: 0, result: {} };
  if (Array.isArray(r)) {
    const scope = key && scenario[`${op} ${key}`] ? `${op}_${key}` : op;
    const counter = `${process.env.FAKE_SCENARIO}.${scope.replace(/\W/g, '_')}`;
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
