# Pixling agent kit

Plugins and skills that let coding agents talk with you through a
[Pixling](https://pixling.app) resident, a pixel-art character on your Mac
desktop.

- **pixling-proxy** relays the conversation both ways. The agent's replies show
  on the resident, permission prompts become questions you answer there, and what
  you type to the resident goes back to the agent. Turned on in its settings, the
  resident also shows what the agent is busy with, reacts to each reply in a way
  that fits it, and can say the reply aloud.
- **Skills** teach an agent to use the resident on its own: speak, ask, show a
  state, animate, and share one resident between several agents.

Everything runs on your Mac. The proxy and the skills drive the `pixling`
command, which talks to the running app over a local socket.

## Requirements

- Pixling running, with **CLI connection** on (Settings → Connect).
- `pixling` on your PATH. **Copy** under CLI connection gives the line, for example:
  `mkdir -p ~/.local/bin && ln -sf '/Applications/Pixling.app/Contents/Helpers/PixlingCLI.app/Contents/MacOS/pixling' ~/.local/bin/pixling`
- Node.js 22.19 or later for pixling-proxy.

Check with `pixling doctor`.

## pixling-proxy

| Host | Install | Your replies to the agent arrive | Status |
| --- | --- | --- | --- |
| [Claude Code](hosts/claude-code/notes.md) | `claude plugin marketplace add pixling/agent-kit`<br>`claude plugin install pixling-proxy@pixling` | Any time, even when the session is idle | Stable |
| [Codex](hosts/codex/notes.md) | `codex plugin marketplace add pixling/agent-kit`, then `/plugins` and trust the hooks in `/hooks` | Any time, through `codex queue` | Experimental |
| [pi](hosts/pi/notes.md) | `pi install npm:@pixling/pi-proxy` | Any time | Experimental |
| [OpenCode](hosts/opencode/notes.md) | Add `"@pixling/opencode-proxy"` to `plugin` in `opencode.json` | Any time | Experimental |
| [DeepSeek Harness (dsh)](hosts/dsh/notes.md) | `dsh plugin --profile web add @pixling/dsh-proxy` | Any time | Experimental |
| [Antigravity CLI](hosts/antigravity/notes.md) | `git clone https://github.com/pixling/agent-kit`<br>`agy plugin install agent-kit/plugins/pixling-proxy` | At the agent's next step, or with your next prompt when idle | Experimental |

Each session gets its own resident, bound as `client:<host>/<session id>`. Put
it away from its menu when you no longer want it; the proxy then stays quiet for
that session.

### Settings

Optional, in `~/.config/pixling/proxy.json` (or `PIXLING_PROXY_*` environment
variables):

```json
{
  "asset": ["No.1", "No.2", "No.7"],
  "show": { "tools": "all", "everyMs": 5000 },
  "permissionWaitMs": 60000,
  "receive": true,
  "language": "ja"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `asset` | `No.1` | The resident for a new session: a zukan number (`No.N`), exact name or id, or a list such as `["No.1", "No.2", "No.7"]`. With a list, each session gets one of them (always the same one for that session), and one that is not in your zukan is skipped. `random` stands for any resident in your zukan (again one per session), alone or in a list. Environment: `PIXLING_PROXY_ASSET=No.1,No.2,No.7` or `PIXLING_PROXY_ASSET=random` |
| `show` | see below | What shows on the resident, and how often |
| `permissionWaitMs` | `60000` | How long a permission question waits on the resident before the host asks as usual. `0` turns it off. Hooks are cut at about 85 seconds, so more than that does not help on Claude Code and Codex |
| `receive` | `true` | Let you type to the resident and relay it to the agent |
| `unattended` | `false` | Also bind a resident in non-interactive runs (`claude -p`, SDK workers, `codex exec`, `pi -p`, `agy -p`). Off, so workers started by an agent do not fill the desk. Environment: `PIXLING_PROXY_UNATTENDED=1` |
| `language` | from `LC_ALL`, `LC_MESSAGES` or `LANG` | `en`, `ja`, `zh-Hant` or `ko`, for the permission question |
| `turnEndWaitMs` | `0` | Codex and Antigravity: hold each turn open this long for your answer on the resident. The host ends a hook at its own limit: 600 s on Codex, 3600 s on Antigravity |
| `idleCloseMs` | 6 hours | pi, OpenCode and dsh: a session with no activity for this long stops listening, and holds no process, until its next activity. Claude Code's wake-up lasts 6 hours too. `0`: never |
| `codexQueue` | `true` | Codex only: relay your messages into the session with `codex queue`, which wakes an idle TUI session. Off: they arrive with your next prompt |

A value that does not fit (`"permissionWaitMs": "soon"`) keeps its default.

### Reactions and voice

Off until you turn them on, on every host. With an `emote` object and a key in
the settings, an emoji pops over the resident while the agent reads, edits or
runs something, and at the end of each turn the resident reacts to the reply: it
cheers when the work is done, droops when something failed, tilts its head when
the agent asks you something. With a `voice` object and a Fish Audio key as well,
it says the parts of the reply worth hearing aloud.

The reply, and nothing else, is sent to an evaluation API (by default jev
through the Vercel AI Gateway) that says what kind of reply it is; the parts to
be said go to Fish Audio. Without those settings nothing is sent. The settings
and what each sends:
[plugins/pixling-proxy](plugins/pixling-proxy/README.md#reactions-and-voice).

### What shows on the resident

Set only the keys you want to change under `show`:

| Key | Default | Meaning |
| --- | --- | --- |
| `reply` | `true` | The agent's reply at the end of each turn. Environment: `PIXLING_PROXY_REPLY=0` |
| `text` | `true` | What the agent writes between tool calls. Environment: `PIXLING_PROXY_TEXT=0` |
| `reasoning` | `"none"` | `"summary"`: what the host writes about its reasoning. `"all"`: the reasoning itself too. Shows as a quote, and only when the host has some (see the table below). Environment: `PIXLING_PROXY_REASONING=all` |
| `tools` | `"none"` | `"all"`, or a list of names (below). Only the name shows, never the input: `` `Bash` ×2 · `Edit` ``. Environment: `PIXLING_PROXY_TOOLS=all` or `PIXLING_PROXY_TOOLS=Bash,Edit` |
| `everyMs` | `0` | At most one message in this time: what happens meanwhile waits, and shows together. The reply and a permission prompt never wait, and everything waiting shows before them. It is checked when something happens, so during one long tool call nothing shows. Environment: `PIXLING_PROXY_EVERY_MS=10000` |
| `maxChars` | `4000` | One text longer than this is cut with `…` (the resident shows at most 4000). What fits in no single message goes in several, at most 5 at a time, the newest |

`tools` lists names as your host spells them, with `*` for any characters and `!` to
hide. The last match decides, and a list starting with `!` starts from every tool:

```json
{ "show": { "tools": ["Bash", "run_command", "mcp__*", "!mcp__pixling__*"] } }
{ "show": { "tools": ["!Read", "!Grep"] } }
```

Each host names its tools its own way, and a name that does not match is simply not
shown, so one list can cover several hosts. A run of a shell command is `Bash` on Claude
Code and Codex, `run_command` on Antigravity, `shell` on OpenCode and `bash` on pi and dsh.

What each host has to show:

| Host | `reasoning` |
| --- | --- |
| Claude Code | `summary` only, and rarely: mostly the blocks are empty. `showThinkingSummaries: true` in its settings gives more |
| Codex | `summary` only, and only with `model_reasoning_summary` set. Even then it is a heading at most, and often nothing |
| Antigravity | `all`, depending on the model |
| OpenCode, pi, dsh | `all`, depending on the model |

### When something is off

- `pixling doctor` checks Pixling and the CLI connection.
- The proxy keeps a log at `~/.cache/pixling-proxy/proxy.log`, with what happened but
  never what was said. `PIXLING_PROXY_DEBUG=<path>` moves it and `PIXLING_PROXY_DEBUG=0`
  turns it off. A session's memory is in the same folder, and goes after 30 days unused.
- Started Pixling after the session? It connects at the session's next activity.
- `ensure refused rejected clientBindingLimit` in the log: Pixling remembers at most
  4096 session bindings and makes room by forgetting the oldest whose resident is off
  the desk. This means all 4096 residents are on the desk: put some away.
- The text you send and the tool calls on a permission card travel to the `pixling`
  command as arguments, so another process of your own user can see them with `ps`.

### Uninstall

| Host | Command |
| --- | --- |
| Claude Code | `claude plugin uninstall pixling-proxy@pixling` |
| Codex | `codex plugin remove pixling-proxy@pixling` |
| pi | `pi remove npm:@pixling/pi-proxy` |
| OpenCode | Remove `"@pixling/opencode-proxy"` from `plugin` in `opencode.json` |
| dsh | `dsh plugin --profile web remove @pixling/dsh-proxy` |
| Antigravity CLI | `agy plugin uninstall pixling-proxy` |

Residents stay on your desk until you put them away. `rm -rf ~/.cache/pixling-proxy
~/.config/pixling/proxy.json` removes the proxy's memory and settings.

## Skills

```sh
npx skills add pixling/agent-kit
```

| Skill | What it teaches |
| --- | --- |
| [pixling](skills/pixling/SKILL.md) | Bind a resident, speak, ask, read what you write back |
| [pixling-expression](skills/pixling-expression/SKILL.md) | States, emotes, light and planned motion |
| [pixling-several-agents](skills/pixling-several-agents/SKILL.md) | Several agents reporting to one resident |

The skills use the `pixling` CLI, so they work in any agent that can run shell
commands. With pixling-proxy installed, they reuse the resident the proxy bound.

## Repository layout

```
skills/                  Agent Skills (SKILL.md)
plugins/pixling-proxy/   The hooks plugin for Claude Code, Codex and Antigravity
packages/pi/             The pi extension (npm)
packages/opencode/       The OpenCode plugin (npm)
packages/dsh/            The dsh plugin (npm)
src/                     The proxy in TypeScript, bundled into the above by `npm run build`
hosts/<id>/              One folder per host: host.json (ledger) and notes.md (docs)
RELEASING.md             How a change reaches people
```

## Contributing

Adding a host, fixing a skill or reporting what works on your setup are all
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
