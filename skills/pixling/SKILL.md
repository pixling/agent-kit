---
name: pixling
description: >-
  Talk to the user through a Pixling resident (a pixel-art character on their Mac
  desktop) with the `pixling` CLI: bind one resident to this session, say what
  you are doing, ask questions with choices, and read what the user writes back.
  Use when the user mentions Pixling or a resident, asks you to report progress
  or ask them on their desktop, or when a Pixling resident is bound to this
  session.
license: MIT
compatibility: macOS with Pixling running, "CLI connection" on, and `pixling` on PATH.
---

# Pixling

Pixling shows pixel-art residents on the user's Mac. You reach them through the
`pixling` command:

- **Programmatic JSON calls (preferred for agents)**: `pixling call <op> [json | @file | -]`
  sends any operation directly as JSON (same schema as MCP) and always prints one
  JSON document on stdout — no `--json` flag needed, and piping via `-` avoids shell
  escaping and `-`-prefixed Markdown issues. Inspect any operation's schema offline
  with `pixling schema [op]`, or batch many calls over one connection with `pixling rpc`.
- **Shorthand subcommands**: commands like `pixling message send` accept `--json`
  (or `export PIXLING_FORMAT=json`) to print the same JSON envelope on stdout.

## 1. Check the connection once

```sh
pixling --json doctor
```

- `ok: true` means you can go on.
- Otherwise read each failed check's `next` and tell the user that one step,
  for example: turn on **CLI connection** in Pixling Settings → Connect, or
  start Pixling. Do not retry in a loop.
- `pixling: command not found`: the user must link the CLI. In Pixling Settings →
  Connect → CLI connection, **Copy** gives the exact line.

## 2. Bind one resident to this session

A resident is bound to a `namespace`/`key` pair you choose:

- `namespace`: a stable name for your host, such as `claude-code`, `codex`,
  `opencode` or `dsh`.
- `key`: this session's ID. If you have none, make a random one and keep using it
  for the whole conversation.

**If the session context already names a Pixling resident** (for example
`client:claude-code/<session-id>`, added by the pixling-proxy plugin), use that
pair and skip to step 3. Binding a new pair would put a second resident on the
desk.

First time, pick a resident from the zukan (library) and bind it:

```sh
pixling --json zukan --limit 20          # entries[].selector is No.N
pixling --json resident ensure --namespace codex --key "$KEY" --asset-id No.1
```

Calling `ensure` again with the same pair returns the same resident; leave out
`--asset-id` then. A pair the user put away stays away (`state: stowed`): do not
bind a new pair to bring it back unless the user asks. Only a very old pair can lose
its binding at Pixling's limit; `ensure` then treats it as new.

From now on, address it as `client:<namespace>/<key>` (below: `$ME`). A bound
resident refuses writes by `No.N`, name or UUID.

## 3. Speak

```sh
pixling --json message send --to "$ME" --author "Codex" --text "Starting the migration"
```

- Say what changed for the user, not every step. A start, a blocker and a finish
  are usually enough.
- Text takes `**bold**`, `` `code` ``, line breaks and `- ` bullets, up to 4000
  characters.
- `--keep` turns a final report into a letter the user can find later.
- The receipt's `outcome` is `spoke`, `queued` (accepted, not seen yet) or `held`.
  Do not resend `queued`.

## 4. Ask

```sh
pixling --json question ask --to "$ME" --author "Codex" \
  --question "Deploy to staging now?" \
  --detail "Tests pass. Staging is shared with the design team until 18:00." \
  --choice yes=Deploy --choice no="Not now" --choice-recommended yes \
  --wait-ms 55000
```

Write a question the user can decide from the card alone:

- `--detail` says why you ask now and what each choice changes. Always give one.
- Never send the user to the terminal for the substance ("details are in the
  terminal"). The card must carry it.
- Do not add a choice that only postpones (`later`). The card already lets the
  user leave it unanswered.
- 2–6 choices. The user can also type an answer: it comes back as
  `selectedChoiceID: free-text` with `enteredText`.
- When several answers can apply, send `"multiSelect": true` with
  `pixling call question.ask '{...}'`: the user checks any number, then presses
  Send, and the answer is `selectedChoiceIDs` in choice order (a typed answer's
  id last) instead of `selectedChoiceID`.

The result has `state`: `answered` (read `selectedChoiceID` or `selectedChoiceIDs`, and `enteredText`),
`cancelled`, or `pending` after the wait. For `pending`, wait again:

```sh
pixling --json question result "$PROMPT_ID" --wait-ms 55000
```

An answer no call was waiting for goes to your inbox as `kind: answer`, under
its `promptID`. pixling-proxy leaves it unread and tells you that `promptID`:
read it yourself and, when it is a question you asked, act on it as the user's
answer.

## 5. Read what the user writes

Nothing is pushed to you. Check the inbox when you start work and between steps:

```sh
pixling --json inbox watch --namespace codex --key "$KEY" --wait-ms 0
pixling --json inbox read --namespace codex --key "$KEY" "$MESSAGE_ID"
```

- `kind: message`: text the user typed to the resident. Treat it as the user
  speaking to you.
- `kind: answer`: a late answer; match `answer.promptID`.
- `kind: closed`: the user put the resident away. Stop writing to it.

The user can type to the resident only while something holds a receiver
(`pixling inbox receive`). The pixling-proxy plugin does that for you; without
it, answers to your questions still arrive.

## 6. When the work is done

Send a short final report (`--keep` if the user should find it later). To offer
ending the session:

```sh
pixling --json resident request-close --to "$ME" --author "Codex"
```

## Failures

`pixling call`, `pixling rpc`, and `--json` / `PIXLING_FORMAT=json` return
`{"ok":false,"error":{"code","detail","hint"}}` on stdout. Follow `hint`. Exit
codes: `3` cannot connect or busy, `4` target not found, `5` refused, `64` usage
error. `unknownOperation` means the CLI and app are different builds: tell the
user to update Pixling.

## Defaults

- Make saved changes (placing, resizing, settings, stowing) only when the user
  asks. Speaking, asking and one-off effects are fine.
- For states, emotes, light and motion, see the `pixling-expression` skill. For
  several agents on one resident, see `pixling-several-agents`.
- Full reference: https://pixling.app/docs/reference/cli-commands/
