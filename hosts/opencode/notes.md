# OpenCode

## Install

Add the plugin to `opencode.json` (project) or `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["@pixling/opencode-proxy"] }
```

OpenCode installs it at startup. Skills: `npx skills add pixling/agent-kit -a opencode`.

For the resident to also react to each reply, cheering when the work is done or
tilting its head at a question, turn reactions on in the settings
([reactions](https://pixling.app/docs/plugins/#reactions)). There is nothing else to install.

## What works

| What | How |
| --- | --- |
| Your reply to the agent | Any time, even when the session is idle |
| What the agent writes | As it goes: each text as it ends, and the reply when the turn ends (skipped if it just showed). `show` in the settings decides which of it shows, including tool names and reasoning |
| Permission prompts | Asked on the resident while the TUI asks too. The first answer wins, and the other side stops asking |

Only your own conversation gets a resident; subagent sessions do not, including
ones from before the background server restarted.

## Limits

- Experimental. Tried on OpenCode 2.2.5.
- `opencode run` may exit before a short reply reaches the resident. The TUI does not.
- The background server keeps running with no session open, so a session left alone
  for 6 hours (`idleCloseMs`) stops listening until its next activity.
- A local copy for testing goes in `.opencode/plugins/` as a file that re-exports
  the package.
  `opencode` hands the run to its background server, which keeps the plugins it has
  loaded and its own environment: restart it (`opencode service`) after changing the
  copy, and do not expect variables set on the command to reach the plugin.
