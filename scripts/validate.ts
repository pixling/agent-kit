// Checks what can be checked without a host installed: skills, the host ledger,
// manifests and hook commands. Prints every problem with the file to fix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_SECONDS } from '../src/runtimes/hook/budgets.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems: string[] = [];
const fail = (file: string, msg: string) => problems.push(`${file}: ${msg}`);
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
// Manifests are checked field by field below, so they stay loosely typed.
const json = (rel: string): any => {
  try {
    return JSON.parse(read(rel));
  } catch (e) {
    fail(rel, `not valid JSON (${(e as Error).message})`);
    return null;
  }
};
// The one plugin, for the hosts that install from git.
const PLUGIN = 'plugins/pixling-proxy';
const dirs = (rel: string) =>
  fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

// Skills: the Agent Skills spec (agentskills.io).
for (const name of dirs('skills')) {
  const rel = `skills/${name}/SKILL.md`;
  if (!fs.existsSync(path.join(root, rel))) {
    fail(`skills/${name}`, 'missing SKILL.md');
    continue;
  }
  const m = read(rel).match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    fail(rel, 'missing YAML frontmatter');
    continue;
  }
  const fm = m[1];
  const field = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
  if (field('name') !== name) fail(rel, `name must be "${name}" (the folder name)`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64)
    fail(rel, 'name: lowercase letters, digits and single hyphens, at most 64');
  const desc = fm
    .match(/^description:\s*(?:>-?\s*\n)?([\s\S]*?)(?=^\S|\s*$(?![\s\S]))/m)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
  if (!desc) fail(rel, 'description is required');
  else if (desc.length > 1024) fail(rel, `description is ${desc.length} characters (max 1024)`);
}

// Host ledger.
const STATUS = ['stable', 'experimental'];
const KIND = ['plugin', 'package', 'hooks'];
const FROM = ['anytime', 'turn-end', 'next-prompt', 'none'];
const docsOrders = new Set<unknown>();
for (const id of dirs('hosts')) {
  const rel = `hosts/${id}/host.json`;
  if (!fs.existsSync(path.join(root, rel))) {
    fail(`hosts/${id}`, 'missing host.json');
    continue;
  }
  if (!fs.existsSync(path.join(root, `hosts/${id}/notes.md`))) fail(`hosts/${id}`, 'missing notes.md (its docs page)');
  const h = json(rel);
  if (!h) continue;
  if (h.id !== id) fail(rel, `id must be "${id}" (the folder name)`);
  if (h.proxy && !fs.existsSync(path.join(root, `src/adapters/${id}`)))
    fail(rel, `has a proxy, but src/adapters/${id} does not exist`);
  for (const k of ['name', 'homepage']) if (typeof h[k] !== 'string' || !h[k]) fail(rel, `${k} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h.verified?.date ?? '')) fail(rel, 'verified.date must be YYYY-MM-DD');
  if (!h.verified?.version) fail(rel, 'verified.version is required');
  if (!Array.isArray(h.skills?.paths) || !h.skills.paths.length) fail(rel, 'skills.paths is required');
  // The docs page: `scripts/docs-hosts.py` in the Pixling app repository copies notes.md with these.
  if (!Number.isInteger(h.docs?.order)) fail(rel, 'docs.order (the page order) is required');
  if (typeof h.docs?.summary !== 'string' || !h.docs.summary.trim() || h.docs.summary.length > 200)
    fail(rel, 'docs.summary (one sentence, at most 200 characters) is required');
  if (docsOrders.has(h.docs?.order)) fail(rel, `docs.order ${h.docs?.order} is already taken`);
  docsOrders.add(h.docs?.order);
  if (!read('README.md').includes(`(hosts/${id}/notes.md)`))
    fail('README.md', `the host table must link hosts/${id}/notes.md`);
  const p = h.proxy;
  if (p) {
    if (!STATUS.includes(p.status)) fail(rel, `proxy.status must be one of ${STATUS.join(', ')}`);
    if (!KIND.includes(p.kind)) fail(rel, `proxy.kind must be one of ${KIND.join(', ')}`);
    if (!FROM.includes(p.fromResident)) fail(rel, `proxy.fromResident must be one of ${FROM.join(', ')}`);
    if (!Array.isArray(p.install) || !p.install.length) fail(rel, 'proxy.install lists the steps');
    if (p.kind === 'package') {
      const manifest = `packages/${id}/package.json`;
      if (!fs.existsSync(path.join(root, manifest))) fail(rel, `kind "package" needs ${manifest}`);
      else if (json(manifest)?.name !== p.package) fail(rel, `proxy.package must be the name in ${manifest}`);
    }
  }
}

// One version for the plugin and its packages.
const versions: Record<string, string | undefined> = {};
for (const plugin of [PLUGIN]) {
  for (const entry of fs.readdirSync(path.join(root, plugin))) {
    if (!/^\..+-plugin$/.test(entry)) continue;
    const rel = `${plugin}/${entry}/plugin.json`;
    versions[rel] = json(rel)?.version;
  }
}
for (const pkg of dirs('packages'))
  versions[`packages/${pkg}/package.json`] = json(`packages/${pkg}/package.json`)?.version;
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1)
  fail(
    'versions',
    `must match: ${Object.entries(versions)
      .map(([f, v]) => `${f}=${v}`)
      .join(', ')}`,
  );

// Every hook command names a script that exists, an adapter and an event the program
// knows, and leaves the hook its budget (src/runtimes/hook/budgets.ts).
const adapterDirs = dirs('src/adapters');
const hookMain = read('src/bin/hooks.ts');
const hookAdapters = [
  ...(hookMain.match(/const ADAPTERS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? '').matchAll(/^\s*'?([\w-]+)'?:/gm),
].map((m) => m[1]);
const hookHostsUsed = new Set<string>();
const checkHook = (rel: string, script: string, hook: any) => {
  if (!fs.existsSync(path.join(root, rel.split('/').slice(0, 2).join('/'), script)))
    fail(rel, `${script} does not exist (run npm run build)`);
  const [, host, event] = hook.command.match(/hook\.mjs"?\s+(\S+)\s+(\S+)/) ?? [];
  if (!host) return fail(rel, `command does not say <host> <event>: ${hook.command}`);
  hookHostsUsed.add(host);
  if (!hookAdapters.includes(host)) fail(rel, `"${host}" is not listed in src/bin/hooks.ts`);
  if (!Object.hasOwn(BUDGET_SECONDS, event)) return fail(rel, `"${event}" is not a hook event`);
  const budget: number | null = BUDGET_SECONDS[event as keyof typeof BUDGET_SECONDS];
  if (typeof hook.timeout !== 'number') fail(rel, `${host} ${event}: set a timeout`);
  else if (budget !== null && hook.timeout <= budget)
    fail(rel, `${host} ${event}: timeout ${hook.timeout} s must be over the event's budget of ${budget} s`);
};

for (const rel of [`${PLUGIN}/hooks/hooks.json`, `${PLUGIN}/hooks/codex-hooks.json`]) {
  const cfg = json(rel);
  for (const groups of Object.values<any[]>(cfg?.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        const m = h.command?.match(/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\/([^"\s]+)/);
        if (!m) fail(rel, `command does not start from the plugin root: ${h.command}`);
        else checkHook(rel, m[1], h);
        if (rel.includes('codex') && h.asyncRewake) fail(rel, 'Codex has no asyncRewake: it would block the turn');
      }
    }
  }
}

// Antigravity reads hooks.json at the plugin root: named hooks, run from the plugin root.
for (const rel of [`${PLUGIN}/hooks.json`]) {
  for (const spec of Object.values<any>(json(rel) ?? {})) {
    for (const [event, list] of Object.entries<any[]>(spec)) {
      if (event === 'enabled') continue;
      for (const h of list.flatMap((g) => g.hooks ?? [g])) {
        const m = h.command?.match(/^node \.\/(\S+)/);
        if (!m) fail(rel, `command does not start with node ./<script>: ${h.command}`);
        else checkHook(rel, m[1], h);
      }
    }
  }
}

// Every adapter is reachable: a hook adapter from the hook program and a hook file, a
// plugin in the host process as a package. Every build ships the receiver and the emote
// reactor beside its entry, without which what the user writes silently never arrives,
// or a reply silently gets no reaction.
// What each build makes, read from the build config itself.
const builds = new Map<string, string[]>(
  ((await import('../vite.config.ts')).default.pack as ReadonlyArray<{ outDir: string; entry: object }>).map(
    (build) => [build.outDir, Object.keys(build.entry)],
  ),
);
const needsBuild = (outDir: string, rel: string) => {
  const entries = builds.get(outDir);
  if (!entries) return fail('vite.config.ts', `nothing builds ${outDir} (${rel})`);
  for (const daemon of ['receiver-daemon', 'emote-reactor'])
    if (!entries.includes(daemon)) fail('vite.config.ts', `${outDir} must also build ${daemon}`);
};
needsBuild(`${PLUGIN}/scripts`, PLUGIN);
for (const id of adapterDirs) {
  const rel = `src/adapters/${id}/index.ts`;
  if (!fs.existsSync(path.join(root, `hosts/${id}/host.json`)))
    fail(`src/adapters/${id}`, `missing hosts/${id}/host.json`);
  if (read(rel).includes('makeLive(')) {
    if (!fs.existsSync(path.join(root, `packages/${id}/package.json`)))
      fail(rel, `missing packages/${id}/package.json`);
    needsBuild(`packages/${id}/dist`, rel);
  } else {
    if (!hookAdapters.includes(id)) fail(rel, 'not listed in src/bin/hooks.ts');
    if (!hookHostsUsed.has(id)) fail(rel, 'no hook file runs this adapter');
  }
}

// Every marketplace lists the plugin.
for (const rel of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
  const names = (json(rel)?.plugins ?? []).map((p: any) => p.name);
  if (!names.includes(PLUGIN.split('/')[1])) fail(rel, `does not list ${PLUGIN.split('/')[1]}`);
}

// The marketplaces point at what exists.
for (const [rel, sourceOf] of [
  ['.claude-plugin/marketplace.json', (p: any) => p.source],
  ['.agents/plugins/marketplace.json', (p: any) => p.source?.path],
] as const) {
  for (const plugin of json(rel)?.plugins ?? []) {
    if (!fs.existsSync(path.join(root, sourceOf(plugin) ?? '')) || !sourceOf(plugin))
      fail(rel, `${plugin.name}: its source does not exist`);
  }
}

// Every distribution carries the licenses of what it bundles (npm run notices).
for (const place of [PLUGIN, ...dirs('packages').map((name) => `packages/${name}`)]) {
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const source = path.join(root, place, file);
    if (!fs.existsSync(source) || fs.readFileSync(source, 'utf8') !== read(file))
      fail(`${place}/${file}`, 'missing or out of date (run npm run notices)');
  }
  if (place.startsWith('packages/') && !json(`${place}/package.json`)?.files?.includes('THIRD_PARTY_NOTICES.md'))
    fail(`${place}/package.json`, 'files must include THIRD_PARTY_NOTICES.md');
}

// A package's entry points are what it builds.
for (const name of dirs('packages')) {
  const manifest = json(`packages/${name}/package.json`);
  if (!/^\.\/dist\//.test(manifest?.exports?.['.'] ?? ''))
    fail(`packages/${name}/package.json`, 'exports must point into dist/');
}

// Dependencies point inwards: adapters -> runtimes -> core -> pixling. What each layer
// may import is listed, so a new folder has to be given a place here.
const ALLOWED: Record<string, string[]> = {
  pixling: ['pixling'],
  core: ['core', 'pixling'],
  runtimes: ['runtimes', 'core', 'pixling'],
  adapters: ['adapters', 'runtimes', 'core', 'pixling'],
  // What a plugin adds on top of the proxy (an Expression, say). No adapter knows of it.
  extensions: ['extensions', 'runtimes', 'core', 'pixling'],
  bin: ['bin', 'extensions', 'adapters', 'runtimes', 'core', 'pixling'],
};
const sources = (rel: string): string[] =>
  fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory() ? sources(`${rel}/${d.name}`) : d.name.endsWith('.ts') ? [`${rel}/${d.name}`] : [],
    );
for (const layer of dirs('src')) {
  if (!ALLOWED[layer]) {
    fail(`src/${layer}`, 'a new layer: say what it may import in scripts/validate.ts');
    continue;
  }
  for (const rel of sources(`src/${layer}`)) {
    // `from '...'`, a bare `import '...'`, `import('...')` and `require('...')`.
    for (const [, , spec] of read(rel).matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.[^'"]+)\1/g,
    )) {
      const target = path.relative(path.join(root, 'src'), path.resolve(root, path.dirname(rel), spec)).split(path.sep);
      if (!ALLOWED[layer].includes(target[0])) fail(rel, `${layer} must not import ${target[0]} (${spec})`);
      // The two ways of running know nothing of each other.
      const [, runtime] = rel.split('/').slice(1);
      if (
        layer === 'runtimes' &&
        target[0] === 'runtimes' &&
        ['hook', 'live'].includes(target[1]) &&
        runtime !== target[1]
      )
        fail(rel, `runtimes/${target[1]} is not for anything outside it (${spec})`);
      // One host's adapter never reads another's.
      if (layer === 'adapters' && target[0] === 'adapters' && target[1] !== rel.split('/')[2])
        fail(rel, `an adapter must not import another adapter (${spec})`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('ok');
