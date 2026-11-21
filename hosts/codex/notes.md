# Codex

## Install

```sh
codex plugin marketplace add pixling/agent-kit
npx skills add pixling/agent-kit -a codex   # optional: the skills
```

Then in Codex, open `/plugins`, install `pixling-proxy`, and approve its hooks
in `/hooks`. Codex asks again whenever the hooks change.

For the resident to also react to each reply, cheering when the work is done or
tilting its head at a question, turn reactions on in the settings
([reactions](https://pixling.app/docs/plugins/#reactions)). There is nothing else to install.

## What works

| What | How |
| --- | --- |
| Your reply to the agent | Any time. The proxy queues it into the session with `codex queue`, and an idle TUI session starts a turn for it. Anything still unread goes with your next prompt (`UserPromptSubmit`) |
| What the agent writes | As it goes: the commentary before each tool call (`PreToolUse`, read from the session file in a detached process so Codex does not wait), and the reply at the end of the turn (`Stop`). `show` in the settings decides which of it shows. Tool names come from `PreToolUse` |
| Permission prompts | Asked on the resident (`PermissionRequest`). No answer in time: Codex asks as usual |

`codex exec` runs get no resident (see `unattended`).

## Going further

- `turnEndWaitMs`: after each reply, wait this long for your answer on the
  resident and continue the turn with it. Codex looks busy while it waits.
- `codexQueue: false`: stop using `codex queue`; what you type arrives with
  your next prompt instead. Hooks alone cannot wake an idle Codex session.
- A session that is not open keeps the queued message until it is opened again.

## Limits

- Lifecycle hooks in plugins cannot be listed in OpenAI's public plugin
  directory, so install from this repository's marketplace.
