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
| Your reply to the agent | Before the agent's next step: while it works, at its next model call (`PreInvocation`); when it is idle, with your next prompt |
| What the agent writes | As it goes: the text before each tool call (`PreToolUse`, read from the transcript in a detached process so agy does not wait), and the reply at the end of the turn (`Stop`). `show` in the settings decides which of it shows. Tool names come from `PreToolUse` |
| Permission prompts | Not relayed. agy asks as usual |

`agy -p` runs get no resident (see `unattended`).

## Going further

- `turnEndWaitMs`: after each reply, wait this long for your answer on the
  resident and continue the turn with it. agy looks busy while it waits.

## Limits

- Experimental, and for the CLI (`agy`) only. The Antigravity app and IDE are
  not supported.
- Hooks alone cannot wake an idle agy session, so what you type while it is
  idle waits for your next prompt.
- A resident binds at your first prompt, when agy starts the conversation.
