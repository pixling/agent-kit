# pi

## Install

```sh
pi install npm:@pixling/pi-proxy
```

Add `-l` to install it for the current project only. To try it for one run:
`pi -e npm:@pixling/pi-proxy`. Skills: `npx skills add pixling/agent-kit -a pi`.

For the resident to also react to each reply, cheering when the work is done or
tilting its head at a question, turn reactions on in the settings
([reactions](https://pixling.app/docs/plugins/#reactions)). There is nothing else to install.

## What works

| What | How |
| --- | --- |
| Your reply to the agent | Any time. When pi is idle it starts a turn; while it works, it waits as a follow-up |
| What the agent writes | As it goes: each assistant message as it ends (`message_end`), and the reply once pi has finished everything it will do on its own (`agent_settled`, skipped if it just showed). `show` in the settings decides which of it shows, including tool names (`tool_execution_start`) and reasoning |
| Permission prompts | Not relayed. pi does not ask before running tools |

Only the interactive TUI gets a resident. `pi -p`, `--mode json` and the
subagents pi starts get none. A new session (`/new`, `/resume`) binds its own.

## Limits

- Experimental. Requires Node.js 22.19 or later, like pi itself.
