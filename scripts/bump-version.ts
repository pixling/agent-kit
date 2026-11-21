// Raises the patch version of the plugin and the packages, which always match.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins/pixling-proxy');
const manifests = [
  ...fs
    .readdirSync(plugin)
    .filter((name) => /^\..+-plugin$/.test(name))
    .map((name) => path.join(plugin, name, 'plugin.json')),
  ...fs.readdirSync(path.join(root, 'packages')).map((name) => path.join(root, 'packages', name, 'package.json')),
];
const current: string = JSON.parse(fs.readFileSync(manifests[0], 'utf8')).version;
const parts = current.split('.').map(Number);
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
for (const file of manifests) {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(`"version": "${current}"`, `"version": "${next}"`));
}
console.log(`${current} -> ${next}`);
