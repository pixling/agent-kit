# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# This repository

- Write commit messages, PR titles and docs in English (this is a public repository).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is organized.
- Edit `src/`, never the built files, and commit what `npm run build` changes in
  `plugins/*/scripts/`. A running host may load them from this working tree.
- A change to anything shipped needs `npm run bump`.
- Tests use `test/fake-pixling.mjs`. Do not call the real `pixling` from a test: it
  acts on the user's desk.
- Try a change on a real host with two sessions at once. The fake CLI and a single
  session have both hidden bugs before.
