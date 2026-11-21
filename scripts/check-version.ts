// A changed plugin needs a new version: Claude Code and Codex cache by version, so
// the same number with new contents never reaches anyone who has it already.
//
// usage: node scripts/check-version.ts <base commit>
import { execFileSync } from 'node:child_process';

const MANIFEST = 'plugins/pixling-proxy/.claude-plugin/plugin.json';
const SHIPPED = /^(src|plugins\/[^/]+|packages)\//;

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
const version = (json: string): string => JSON.parse(json).version;

const base = process.argv[2];
// The first push of a branch has no commit before it.
if (!base || /^0+$/.test(base)) {
  console.log('no base to compare with');
  process.exit(0);
}
const changed = git('diff', '--name-only', base, 'HEAD')
  .split('\n')
  .filter((file) => SHIPPED.test(file));
const before = version(git('show', `${base}:${MANIFEST}`));
const now = version(git('show', `HEAD:${MANIFEST}`));
if (changed.length && before === now) {
  console.error(`${changed.length} shipped file(s) changed, but the version is still ${now}.`);
  console.error('Run `npm run bump` and commit. First changed: ' + changed[0]);
  process.exit(1);
}
console.log(`ok (${before} -> ${now}, ${changed.length} shipped file(s) changed)`);
