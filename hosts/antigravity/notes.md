# Antigravity CLI

## Install

agy installs plugins from a folder, so clone this repository first:

```sh
git clone https://github.com/pixling/agent-kit
agy plugin install agent-kit/plugins/pixling-proxy
npx skills add pixling/agent-kit -a antigravity   # optional: the skills
```

agy copies the plugin to `~/.gemini/config/plugins/pixling-proxy`. To update,
`git pull` and run `agy plugin install` again. Start a new session afterwards.

For the resident to also react to each reply, cheering when the work is done or
tilting its head at a question, turn reactions on in the settings
([reactions](https://pixling.app/docs/plugins/#reactions)). There is nothing else to install.

## What works

| What | How |
| --- | --- |
| Your reply to the agent | After each reply, `PostInvocation` holds the execution open (up to 59 minutes by default) and continues the conversation with what you write on the resident (`force_continue` + an injected `userMessage`). While the agent is working, `PreInvocation` also picks up messages before the next model call; once the wait ends or is interrupted, unread messages arrive with your next terminal prompt |
| What the agent writes | As it goes: the text before each tool call (`PreToolUse`, read from the transcript in a detached process so agy does not wait), and the reply when the agent finishes (`PostInvocation`, with `Stop` as fallback). `show` in the settings decides which of it shows. Tool names come from `PreToolUse` |
| Permission prompts | Not relayed. agy asks as usual |

`agy -p` runs get no resident (see `unattended`) and never hold open.

## Going further

- `turnEndWaitMs`: how long `PostInvocation` waits for your answer on the
  resident after each reply. Defaults to 59 minutes on Antigravity (just under
  the 3600 s hook timeout). Set `turnEndWaitMs` to `0` (or
  `PIXLING_PROXY_TURN_END_WAIT_MS=0`) to disable waiting so agy returns to idle
  immediately and picks up resident messages on your next prompt instead.

## Limits

- Experimental, and for the CLI (`agy`) only. The Antigravity app and IDE are
  not supported.
- **TUI stays busy while waiting**: because `agy` runs hooks synchronously, the
  terminal looks busy while `PostInvocation` waits for your message on the
  resident. Typing in the terminal during that wait is queued until the wait
  ends unless you press `Esc` to interrupt the hook (or configure agy to submit
  immediately). Turn waiting off with `turnEndWaitMs: 0` if you prefer an idle
  terminal.
- Holding the turn open does not spend tokens while waiting, and prompt caching
  still works across injected replies, but every continued reply counts toward
  one agy execution loop (so very long continuous stretches can eventually hit
  agy's internal invocation or token budget limits, and TUI slash commands need
  `Esc` first).
- A resident binds at your first prompt, when agy starts the conversation.

## Migration plan (when native turn-start arrives)

This `PostInvocation` hold-open design is an intentional bridge: Antigravity CLI
does not yet expose a public API to start a new turn in an idle TUI session from
a plugin (unlike Claude Code's `asyncRewake` hooks or Codex's `codex queue`;
Antigravity's `agentapi` sidecars and MCP Apps `ui/message` are Antigravity App
only).

Once Antigravity CLI exposes an official turn-start / idle wake-up mechanism
(such as an `asyncRewake`-style hook or a CLI queue command), `pixling-proxy`
will migrate the Antigravity adapter off `PostInvocation` holding (`holdAtStepEnd`
/ `stepEndedReply` / `continueStep` in `src/adapters/antigravity/index.ts`) so
the TUI can stay idle between replies just like Claude Code and Codex.
