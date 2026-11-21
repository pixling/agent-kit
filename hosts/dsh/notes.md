# DeepSeek Harness (dsh)

dsh runs in its Web UI (`dsh web`) or the Desktop app. It has no terminal UI of
its own; a separate TUI plugin exists but is not part of dsh.

## Install

```sh
dsh plugin --profile web add @pixling/dsh-proxy
```

Restart the profile afterwards. To load a local build instead, add a patch with
`dsh --patch <file> --profile web`:

```yaml
- insert:
    - id: pixling-proxy
      name: /path/to/agent-kit/packages/dsh/dist/index.mjs
```

Skills: copy `skills/<name>` into `.agents/skills` or `$DSH_HOME/skills`.

For the resident to also react to each reply, cheering when the work is done or
tilting its head at a question, turn reactions on in the settings
([reactions](https://pixling.app/docs/plugins/#reactions)). There is nothing else to install.

## What works

| What | How |
| --- | --- |
| Your reply to the agent | Any time. It steers the session: an idle one starts a turn, a running one reads it at its next step |
| What the agent writes | As it goes: each assistant message as it ends (`assistant/message`), and the reply when a turn completes (`turn/end`, skipped if it just showed). `show` in the settings decides which of it shows, including tool names (`tool/call`) and reasoning |
| Permission prompts | Asked on the resident while the dsh UI asks too (`approval/request`); the first answer wins and the other is withdrawn |

Each conversation gets its own resident, bound as `client:dsh/<session id>`, once
it starts a turn. Subagents get none. Headless, SDK and ACP runs get none either,
since nobody is there to type; with `unattended` they get one that only shows replies.

## Limits

- Experimental. dsh is in developer preview and says its APIs will change.
- dsh does not say when a session ends, so one left alone for 6 hours (`idleCloseMs`)
  stops listening until its next turn.
- Tried on dsh 0.2.1-rc with the Web UI: replies show, the resident takes
  messages, and permission questions work from either side.
