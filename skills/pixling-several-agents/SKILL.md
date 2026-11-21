---
name: pixling-several-agents
description: >-
  Let several agents (subagents, parallel sessions, a team of workers) report to
  one Pixling resident so their progress collects in one window, told apart by
  author, with the `pixling` CLI. Use when you coordinate other agents and the
  user wants one place on the desktop to follow them.
license: MIT
compatibility: macOS with Pixling running, "CLI connection" on, and `pixling` on PATH.
---

# Several agents, one resident

Every agent binds the same `namespace`/`key` pair and writes with its own
`--author`. See the `pixling` skill for binding and speaking.

## Choose the group's pair

Pick a pair for the group, separate from any one agent's own pair, so that
putting one agent's resident away does not take the group's with it:

```sh
GROUP_NS=my-team
GROUP_KEY=release-1
pixling --json resident ensure --namespace "$GROUP_NS" --key "$GROUP_KEY" --asset-id No.7   # first agent only
```

Give `GROUP_NS`, `GROUP_KEY` and an author name to every agent you start. They
bind with the pair alone (no `--asset-id`) and get the same resident. A
different `--asset-id` for an existing pair is refused as `clientKeyConflict`.

## Every agent names itself

```sh
pixling --json message send --to "client:$GROUP_NS/$GROUP_KEY" --author "Builder" --text "Build passed, 312 tests"
```

The window keeps every card in order and shows the author where the writer
changes. Agents that send the same author, or none, look like one sender.

## Questions

Any agent can ask on the pair with its own `--author`. The answer returns to
the call that waits for it. One resident takes 4 waiting questions; a fifth is
refused with `residentBusy`, so let workers ask through the coordinator when
there are many.

## One reader, one state

- The pair has one inbox, and reading marks an entry read for everyone. Let the
  coordinator watch and read (`pixling inbox watch` / `inbox read`) and pass the
  work on.
- The user can type to the resident only while a receiver is held. Hold it from
  the coordinator: `pixling inbox receive --namespace "$GROUP_NS" --key "$GROUP_KEY"`
  in the background.
- `resident status` shows one state, and the newest call wins. Let the
  coordinator set it.

## Clean up

When the group's work is done, the coordinator sends the final report (`--keep`)
and, if the user wants, `pixling resident request-close --to "client:$GROUP_NS/$GROUP_KEY"`.

Reference: https://pixling.app/docs/connect/several-agents/
