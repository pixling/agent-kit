# Contributing

Thank you for helping Pixling reach more agents. Pull requests and issues in
English or Japanese are welcome.

## What you can add

| Change | Where | Review |
| --- | --- | --- |
| Support for a new host | `hosts/<id>/`, `src/adapters/<id>/`, and a hook file or a package | Maintainer review |
| A fix or update for a host (new version, changed path) | `hosts/<id>/host.json`, `notes.md` | Light review once the checks pass |
| A skill fix or a new skill | `skills/<name>/SKILL.md` | Maintainer review |
| Proxy behaviour | `src/` (never the built files) | Maintainer review |

## Before you start

- Node.js 22.19 or later, then `npm install`. The toolchain is
  [Vite+](https://viteplus.dev) (`vp`), installed as a dev dependency.
- The proxy is written in TypeScript under `src/`. `npm run build` (`vp pack`)
  bundles it into `plugins/pixling-proxy/scripts/` and `packages/*/dist/`.
  Commit the plugin's built scripts with your change, because Claude Code and
  Codex install the plugin straight from git. Never edit files that start with
  `// GENERATED`: `npm run build` overwrites them, and `git status` must stay clean
  after building and testing.
- There is no CI; run the checks yourself before pushing. `npm run check` formats,
  lints, type-checks and validates the manifests (`npm run format` fixes formatting). `npm test` builds, then runs the
  tests against a fake `pixling` CLI, so you do not need Pixling installed.
- Use the `id` that the [skills CLI](https://github.com/vercel-labs/skills) uses
  for the host when it has one (`claude-code`, `codex`, `opencode`, …).

## How the proxy is organized

```
src/adapters/    The anti-corruption layer towards each host
  claude-code/, codex/, antigravity/   command hooks: a HookHost
  codex/forwarder.ts                   Codex's own background process
  opencode/, dsh/, pi/                 plugins in the host process: built on makeLive
src/runtimes/    How the proxy runs, in no host's terms
  hook/            one process per event: stdin, stdout, every failure is silent
    HookHost.ts      the contract a hook adapter fills in
    events.ts        one handler per hook event
    budgets.ts       how long each event may take
    transcript.ts    what the agent did, read from the host's transcript
  live/            sessions inside a host process, behind a Promise API
  SessionFiles.ts  a session's memory, claims and locks on disk
  Daemons.ts       background processes
  process.ts, log.ts   processes and the diagnostic log
  base.ts          the desk, the settings and the diagnostic log, as layers
src/core/        What happens in a conversation, in no host's terms
  Activity.ts      what the agent does, and which of it shows: pure
  Conversation.ts  bind, show, ask permission, read what the user writes, relay
  services.ts      what those programs need from the world
  config.ts, text.ts   user settings and wording
src/pixling/     The anti-corruption layer towards Pixling
  Desk.ts          the CLI's commands, exit codes and JSON, as a typed service
src/extensions/  What a plugin adds on top of the proxy, through a service core offers
  emote/           the resident reacts to each reply, once its settings are on (core's Expression)
  voice/           and says it aloud: the parts of a reply worth hearing, through Fish Audio
src/bin/         Process entries shared by hosts, and (hooks.ts) the list of hook adapters
Dependencies point inwards (`adapters` → `runtimes` → `core` → `pixling`; an
extension sits beside the adapters and no adapter knows of it), and
`npm run check` rejects an import that points the other way, or one adapter
importing another. The proxy is written with [Effect](https://effect.website):
read [AGENTS.md](AGENTS.md) before changing `core` or `runtimes`. An adapter needs
little of it: a hook adapter is a `Schema` for its payload and a few functions, and
a plugin adapter calls `makeLive`, which is plain Promises.

An adapter only translates: it says what happened as an `Activity`, and never decides
what shows, which is the user's `show` setting, read in `core`. A host with nothing to
say about tools or reasoning simply never reports them, so a first version can start
with `text`.

## Adding a host

1. Copy `hosts/claude-code/` to `hosts/<id>/` and fill in `host.json`:
   - `verified`: the host version and the date you tried it.
   - `skills.paths`: where the host reads skills.
   - `proxy` (optional): how the proxy reaches the host.
     - `status`: `experimental` until a maintainer says otherwise.
     - `kind`: `plugin`, `package` or `hooks`.
     - `package`: the npm name, for `package`.
     - `fromResident`: when what the user types reaches the agent: `anytime`,
       `turn-end`, `next-prompt` or `none`.
     - `install`: the exact steps.
2. Write `notes.md`. It becomes the host's page in the Pixling docs
   (`pixling.app/docs/plugins/<id>/`): setup, what works, and known limits. Write
   it the way those docs are written: plain words, real commands, headings in
   sentence case, tables with a header row, and `code` (not bold) for names.
   In `host.json`, `docs.summary` is the page's one-sentence description and
   `docs.order` its place in the sidebar.
3. Write the adapter in `src/adapters/<id>/`. How depends on the host, and
   adapters do not share code: a change for one host never touches another.

   **A host with command hooks:**
   - Start from `src/adapters/antigravity/index.ts`, the smallest one. Codex also
     has a forwarder, which only makes sense for its `codex queue`.
   - List the adapter in `src/bin/hooks.ts`.
   - Add a hook file, with `plugins/pixling-proxy/hooks/hooks.json` as the example
     (Antigravity's format: `plugins/pixling-proxy/hooks.json`). Each `timeout`
     must be over that event's budget in `src/runtimes/hook/budgets.ts`.
   - Add a manifest, `plugins/pixling-proxy/.<host>-plugin/plugin.json`, with the
     same `version`, and the host's marketplace file if it has one.
   - Test the adapter in `test/adapters.test.ts`, and each event with the fake CLI
     in `test/hook.test.ts`.

   **A host that loads JS plugins:**
   - Start from `src/adapters/pi/index.ts` and `packages/pi/`. `makeLive` is a plain
     Promise API. A host usually waits for its handlers, so do not await Pixling in
     one unless the host's next step needs the answer.
   - Add the package to `pack` in `vite.config.ts`, with `receiver-daemon` in its
     entry: without it, what the user writes never arrives.
   - Test it with a fake host and the fake CLI, like `test/pi.test.ts`. If the host
     runs several sessions in one process, add it to the two-session test in
     `test/live-process.test.ts`.

4. Try it in the real host with **two sessions at once**, and put the version and
   date in `verified`.
5. Add the host to the table in `README.md`, its uninstall line, and, if it uses
   hooks, the list in `plugins/pixling-proxy/README.md`.
6. Run `npm run bump`, `npm run notices` (for a new package), `npm run check` and
   `npm test`.

`npm run check` catches what is easy to forget: a host without an adapter or
docs page, an adapter nothing runs, a hook timeout shorter than its budget, or a
package without the receiver.

The proxy must never get in the agent's way. Every failure is silent and exits 0,
and a hook answers within its budget even when the CLI hangs.

## Releasing a change

Anything under `src/`, `plugins/pixling-proxy/` or `packages/` needs a new version
(`npm run bump`); `node scripts/check-version.ts origin/main` fails without one. Claude Code and Codex cache a plugin by
its version, so new contents under the same number never reach anyone. If two pull
requests collide on the version or the built files, rebase and run both commands
again. Publishing is in [RELEASING.md](RELEASING.md).

## Commits and pull requests

Pull requests are squash-merged, and the title becomes the commit message, so
give the PR a title that says what changes for users.

By contributing you agree that your work is released under the [MIT License](LICENSE).
