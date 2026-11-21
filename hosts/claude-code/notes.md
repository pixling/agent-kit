# Claude Code

## Install

```sh
claude plugin marketplace add pixling/agent-kit
claude plugin install pixling-proxy@pixling
npx skills add pixling/agent-kit -a claude-code   # optional: the skills
```

Start a new session afterwards; a running one does not load new hooks.

For the resident to also react to each reply, cheering when the work is done or
tilting its head at a question, turn reactions on in the settings
([reactions](https://pixling.app/docs/plugins/#reactions)). There is nothing else to install.

## What works

| What | How |
| --- | --- |
| Your reply to the agent | Any time. An `asyncRewake` hook waits for what you type and wakes the session, even when it is idle |
| What the agent writes | As it goes: the text before each tool call (`PreToolUse`, async, read from the transcript), and the reply at the end of the turn (`Stop`). `show` in the settings decides which of it shows. Tool names come from `PreToolUse` |
| Permission prompts | Asked on the resident (`PermissionRequest`). No answer within `permissionWaitMs`: Claude Code asks as usual |

## Limits

- A waiting hook lasts up to 6 hours. After that, what you type reaches the agent
  with your next prompt.
- `/clear` starts a new session, so a new resident appears. Put the old one away
  from its menu.
- `claude -p` and SDK runs get no resident, so workers an agent starts do not
  fill the desk. Set `unattended: true` to bind one anyway (replies show, but
  nothing wakes the session).
