// Every distribution bundles Effect, whose MIT license asks to be kept with it. Writes
// the license and the third-party notices into each of them; `npm run check` fails if
// they drift. Run after changing the bundled dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = ['effect', '@effect/platform-node', '@effect/platform-node-shared'];

const notices = [
  '# Third-party notices',
  '',
  'The built scripts in this distribution bundle the following packages.',
  ...BUNDLED.flatMap((name) => {
    const dir = path.join(root, 'node_modules', name);
    const { version, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return [
      '',
      `## ${name} ${version} (${license})`,
      '',
      '```',
      fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8').trim(),
      '```',
    ];
  }),
  '',
].join('\n');

const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices);
const places = [
  'plugins/pixling-proxy',
  ...fs.readdirSync(path.join(root, 'packages')).map((name) => `packages/${name}`),
];
for (const place of places) {
  fs.writeFileSync(path.join(root, place, 'LICENSE'), license);
  fs.writeFileSync(path.join(root, place, 'THIRD_PARTY_NOTICES.md'), notices);
}
