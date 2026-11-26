#!/usr/bin/env node
// A stand-in for the `pixling` CLI. Appends argv to $FAKE_LOG (one JSON line) and
// answers from $FAKE_SCENARIO: {"<subcommand> <verb>": response | [responses...]},
// where a response is {"exit": n, "result": {...}} or {"exit": n, "error": {...}}.
// Arrays are consumed in order; the last element repeats.
//
// Supports `rpc` (NDJSON on stdin/stdout), `call <op> -` (JSON on stdin), and the
// legacy subcommands. Every unary call is also logged to $FAKE_LOG in the canonical
// subcommand argv form so host tests stay transport-agnostic; when $FAKE_RPC_LOG is
// set, the raw transport, pid, argv and JSON payload are recorded there as well.
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

const readScenario = () => JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));

const OP_TO_SCENARIO = {
  'resident.ensure': 'resident ensure',
  'resident.describe': 'resident describe',
  'resident.emote': 'resident emote',
  'resident.status': 'resident status',
  'message.send': 'message send',
  'question.ask': 'question ask',
  'question.result': 'question result',
  'question.cancel': 'question cancel',
  'inbox.watch': 'inbox watch',
  'inbox.read': 'inbox read',
  'sequence.start': 'sequence start',
  'sequence.list': 'sequence list',
  'zukan.list': 'zukan',
};

const DEFAULTS = { 'resident ensure': { exit: 0, result: { state: 'onDesk' } } };

function logRpc(record) {
  if (process.env.FAKE_RPC_LOG) {
    fs.appendFileSync(process.env.FAKE_RPC_LOG, JSON.stringify({ pid: process.pid, ...record }) + '\n');
  }
}

function canonicalArgv(op, input) {
  const p = input ?? {};
  switch (op) {
    case 'resident.ensure':
      return [
        'resident',
        'ensure',
        '--namespace',
        String(p.namespace ?? ''),
        '--key',
        String(p.key ?? ''),
        ...(p.assetID ? ['--asset-id', String(p.assetID)] : []),
        ...(p.name ? ['--name', String(p.name)] : []),
        ...(p.initial ? ['--initial', JSON.stringify(p.initial)] : []),
      ];
    case 'zukan.list':
      return [
        'zukan',
        ...(p.limit != null ? ['--limit', String(p.limit)] : []),
        ...(p.offset != null ? ['--offset', String(p.offset)] : []),
      ];
    case 'message.send':
      return [
        'message',
        'send',
        '--to',
        String(p.to ?? ''),
        ...(p.author ? ['--author', String(p.author)] : []),
        '--text',
        String(p.text ?? ''),
        ...(p.requestID ? ['--request-id', String(p.requestID)] : []),
        ...(p.action ? ['--action', typeof p.action === 'string' ? p.action : JSON.stringify(p.action)] : []),
      ];
    case 'sequence.start':
      return [
        'sequence',
        'start',
        '--to',
        String(p.to ?? ''),
        ...(p.steps ? ['--steps', JSON.stringify(p.steps)] : []),
        ...(p.name ? ['--name', String(p.name)] : []),
      ];
    case 'sequence.list':
      return ['sequence', 'list', '--to', String(p.to ?? '')];
    case 'resident.describe':
      return ['resident', 'describe', '--to', String(p.to ?? '')];
    case 'resident.emote':
      return [
        'resident',
        'emote',
        '--to',
        String(p.to ?? ''),
        '--text',
        String(p.text ?? ''),
        ...(p.count != null ? ['--count', String(p.count)] : []),
      ];
    case 'resident.status':
      return [
        'resident',
        'status',
        '--to',
        String(p.to ?? ''),
        ...(p.name ? ['--name', String(p.name)] : p.clear ? ['--clear'] : []),
      ];
    case 'question.ask':
      return [
        'question',
        'ask',
        '--to',
        String(p.to ?? ''),
        ...(p.author ? ['--author', String(p.author)] : []),
        '--question',
        String(p.question ?? ''),
        ...(p.detail != null ? ['--detail', String(p.detail)] : []),
        ...(Array.isArray(p.choices) ? p.choices.flatMap((c) => ['--choice', `${c.id}=${c.label}`]) : []),
        ...(p.freeText?.label ? ['--free-text-label', String(p.freeText.label)] : []),
        ...(p.freeText?.id ? ['--free-text-id', String(p.freeText.id)] : []),
        ...(p.status ? ['--status', String(p.status)] : []),
        ...(p.waitMs != null ? ['--wait-ms', String(p.waitMs)] : []),
      ];
    case 'question.result':
      return [
        'question',
        'result',
        String(p.promptID ?? ''),
        ...(p.waitMs != null ? ['--wait-ms', String(p.waitMs)] : []),
      ];
    case 'question.cancel':
      return ['question', 'cancel', String(p.promptID ?? '')];
    case 'inbox.watch':
      return [
        'inbox',
        'watch',
        '--namespace',
        String(p.namespace ?? ''),
        '--key',
        String(p.key ?? ''),
        ...(p.waitMs != null ? ['--wait-ms', String(p.waitMs)] : []),
      ];
    case 'inbox.read':
      return [
        'inbox',
        'read',
        '--namespace',
        String(p.namespace ?? ''),
        '--key',
        String(p.key ?? ''),
        String(p.messageID ?? ''),
      ];
    default:
      return [op, JSON.stringify(p)];
  }
}

function nextResponse(scenarioKey, key) {
  const scenario = readScenario();
  let r = (key && scenario[`${scenarioKey} ${key}`]) ??
    scenario[scenarioKey] ??
    DEFAULTS[scenarioKey] ?? { exit: 0, result: {} };
  if (Array.isArray(r)) {
    const scope = key && scenario[`${scenarioKey} ${key}`] ? `${scenarioKey}_${key}` : scenarioKey;
    const counter = `${process.env.FAKE_SCENARIO}.${scope.replace(/\W/g, '_')}`;
    const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(i + 1));
    r = r[Math.min(i, r.length - 1)];
  }
  return r;
}

if (args[0] === 'rpc') {
  const rpcScenario = readScenario()['rpc'];
  if (rpcScenario && typeof rpcScenario.exit === 'number' && rpcScenario.exit !== 0) {
    process.stderr.write("Error: Unknown command 'rpc'\n");
    process.exit(rpcScenario.exit);
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const req = JSON.parse(line);
        const scenarioKey = OP_TO_SCENARIO[req.op];
        logRpc({ mode: 'rpc', argv: process.argv.slice(2), req });
        if (!scenarioKey) {
          process.stdout.write(
            JSON.stringify({
              id: req.id,
              ok: false,
              operation: req.op,
              error: { code: 'invalidArguments', problem: `unknown operation ${req.op}` },
            }) + '\n',
          );
        } else {
          fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(canonicalArgv(req.op, req.args)) + '\n');
          const key = typeof req.args?.key === 'string' ? req.args.key : null;
          const r = nextResponse(scenarioKey, key);
          const doc = r.error
            ? { id: req.id, ok: false, operation: req.op, error: r.error }
            : { id: req.id, ok: true, operation: req.op, result: r.result ?? {} };
          process.stdout.write(JSON.stringify(doc) + '\n');
        }
      }
      nl = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else if (args[0] === 'call') {
  const callScenario = readScenario()['call'];
  if (callScenario && typeof callScenario.exit === 'number' && callScenario.exit !== 0) {
    process.stderr.write("Error: Unknown command 'call'\n");
    process.exit(callScenario.exit);
  }
  const op = args[1];
  const scenarioKey = OP_TO_SCENARIO[op];
  const inputArg = args[2];
  const rawInput = inputArg === '-' || inputArg === undefined ? fs.readFileSync(0, 'utf8') : inputArg;
  const parsedArgs = rawInput.trim() ? JSON.parse(rawInput) : {};
  logRpc({ mode: 'call', argv: process.argv.slice(2), op, args: parsedArgs });
  if (!scenarioKey) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        operation: op,
        error: { code: 'invalidArguments', problem: `unknown operation ${op}` },
      }) + '\n',
    );
    process.exit(64);
  }
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(canonicalArgv(op, parsedArgs)) + '\n');
  const key = typeof parsedArgs?.key === 'string' ? parsedArgs.key : null;
  const r = nextResponse(scenarioKey, key);
  const doc = r.error
    ? { ok: false, operation: op, error: r.error }
    : { ok: true, operation: op, result: r.result ?? {} };
  process.stdout.write(JSON.stringify(doc) + '\n');
  process.exit(r.exit ?? (r.error ? 5 : 0));
} else {
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
  const op = args[0] === 'zukan' ? 'zukan' : args.slice(0, 2).join(' ');
  logRpc({ mode: 'legacy', argv: process.argv.slice(2), op });
  if (!KNOWN.includes(op)) {
    process.stderr.write(`Error: Unknown command '${op}'\n`);
    process.exit(64);
  }
  if (op === 'inbox receive' && args.includes('--multiplex')) {
    const muxScenario = readScenario()['inbox receive --multiplex'];
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
            const r = readScenario()['inbox receive'] ?? { exit: 0, result: {} };
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
    let muxScenario = readScenario()['inbox wait --multiplex'];
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
            const currentScenario = readScenario();
            const perKey = currentScenario[`inbox wait ${cmd.key}`];
            let r = perKey ?? currentScenario['inbox wait'] ?? { exit: 0, result: { messages: [] } };
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
    const keyIdx = args.indexOf('--key');
    const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
    const r = nextResponse(op, key);
    const doc = r.error
      ? { ok: false, operation: op, error: r.error }
      : { ok: true, operation: op, result: r.result ?? {} };
    process.stdout.write(JSON.stringify(doc) + '\n');
    process.exit(r.exit ?? (r.error ? 5 : 0));
  }
}
