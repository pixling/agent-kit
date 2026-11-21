# Releasing

`pixling-proxy` reaches people in two ways:

- Claude Code, Codex and Antigravity install from git, so a change is out once it is
  on `main` with a new version.
- pi, OpenCode and dsh install from npm, so a change is out once it is published.

## A regular release

There is no CI: every check and the publish run on a maintainer's machine.

1. Land the change on `main` with a new version (`npm run bump`), after the checks in
   [CONTRIBUTING.md](CONTRIBUTING.md#releasing-a-change) pass.
2. Tag it: `git tag v$(node -p "require('./packages/pi/package.json').version") && git push --tags`.
3. From a clean checkout of that tag, run `npm ci && npm run check && npm test`, then
   publish each package: `for pkg in packages/*; do (cd "$pkg" && npm publish --access public --ignore-scripts); done`.

## The first public release

To do on Pixling's release day, in this order, since each of these is public and
hard to take back:

1. Make `pixling/agent-kit` public.
2. Publish each of the three packages (`@pixling/<host>-proxy` for pi, OpenCode
   and dsh) by hand:
   `cd packages/<name> && npm run prepack && npm publish --access public`.
3. Check that the install lines in `README.md` work on a clean machine, one host each.
4. List the skills on skills.sh and the plugin in Anthropic's directory.
5. Deploy the docs (`pixling.app/docs/plugins/`) if they are not out yet.
