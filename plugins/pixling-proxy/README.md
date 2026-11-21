# pixling-proxy

Talk with your agent through a [Pixling](https://pixling.app) resident on your
Mac desktop, for Claude Code, Codex and the Antigravity CLI.

- What the agent writes shows on the resident as it goes: the text before
  each tool call, then the reply at the end of the turn.
- A permission prompt becomes a question on the resident: **Allow**, **Deny**,
  or type what to do instead. With no answer in time, the host asks as usual.
- What you type to the resident goes back to the agent. Claude Code wakes up
  for it even when the session is idle; Codex receives it through `codex queue`, which also wakes an idle session;
  Antigravity receives it before the agent's next step.
- Optional, once you turn them on in the [settings](#settings): the resident
  shows what the agent is busy with, [reacts](#reactions) to each reply in a way
  that fits it (cheers when the work is done, droops when something failed, tilts
  its head when the agent asks you something), and can [say the reply
  aloud](#voice).

Each session binds its own resident as `client:<host>/<session id>`. Put it away
from its menu to silence the proxy for that session.

## Install

Claude Code:

```sh
claude plugin marketplace add pixling/agent-kit
claude plugin install pixling-proxy@pixling
```

Codex: `codex plugin marketplace add pixling/agent-kit`, then install
**pixling-proxy** from `/plugins` and approve its hooks in `/hooks`.

Antigravity CLI: clone https://github.com/pixling/agent-kit, then
`agy plugin install agent-kit/plugins/pixling-proxy`.

## Requirements

Requires Pixling with **CLI connection** on, `pixling` on your PATH, and
Node.js 22.19 or later. Out of the box everything stays on your Mac; reactions
and the voice send only what is described below, and only once you turn them on.

## Reactions and voice

Off until you turn them on: without the settings below, the resident moves for
the reply as for any message and nothing leaves your Mac.
On pi, OpenCode and dsh the settings are read when a session starts: turning
them on or off takes effect in the next session.

### How it decides

The reply (and only the reply, at most 2000 characters) is sent to an
evaluation API, by default [jev](https://vercel.com/ai-gateway) through the
Vercel AI Gateway, which says what kind of reply it is. Nothing else in the
conversation leaves your Mac. Nothing is sent until the settings have an
`emote` object and a key is found: until then the resident moves for the reply
as for any message, and does so too whenever the judge cannot be reached.

Unless the voice is on, the reply is not sent at all when nobody would see the reaction (the resident is
on another desktop, hidden or off the screen), nor when a question waits on the
resident: that already says the turn ended in a question, so it pops ❓.

### While the agent works

Once the [settings](#settings) turn reactions on, an emoji pops over the resident
when a session begins (👋, on Claude Code, Codex and the Antigravity CLI), when a turn starts (👀), when the agent turns to another kind of tool, and when
it asks for permission (❗):

| Tools | Emoji |
| --- | --- |
| Reading and searching files | 🔍 |
| Editing and writing files | ✏️ |
| Running commands | ⚙️ |
| The web | 🌐 |
| Handing work to another agent | 🤝 |
| Asking you something | ❓ |

At most one every 6 seconds, and the same kind again only after 30 seconds. Only
the tool's name is read, never what it is given, and nothing leaves your Mac for
it. These show whatever the `show` setting says about tools. The Antigravity CLI,
pi, OpenCode and dsh show the tools, but not the turn's start.

#### States

A resident can also hold a look for as long as the agent works. The plugin sets a
state by name, and the state shows on a resident whose asset has a look for that
name; it saves no looks itself, so until you define one nothing changes.

| State | When |
| --- | --- |
| `working` | From the turn's start (on the Antigravity CLI, pi, OpenCode and dsh: its first tool call) to its end |
| `working.read`, `working.write`, `working.run`, `working.web`, `working.delegate`, `working.ask` | While the agent uses that kind of tool (the table above). Without a look of its own, `working` stays |
| `asking` | While a permission question waits on the resident |

Give a state its look with `pixling status define`, for example a clip to hold
or a pose: `pixling status define --to No.7 --name working --hold-animation m2`
(`pixling resident describe` lists the clips and poses), or ask an agent that has
the Pixling skills. The look is read once a turn. A turn you interrupt keeps its
state until the next turn ends, or for 10 minutes.

### Reactions

Each kind of reply has a few reactions, and each time a kind comes up again it
gets the next one, so it never looks the same twice in a row. A hop squashes
as it leaves the floor and as it lands, and a droop sinks a little.

Each reaction lights up in a style picked at random: its mood's own light, the
resident's own colours brightened, a light rising from the feet, a ring from the
centre, a shower from above, a twinkle, or (when the work is done, on a greeting or an
idea) a rainbow passing through.

How big the reaction to finished work is follows how weighty the judge finds the
reply, out of five: up to 2.5 it is quiet (one emoji at a time, shallow squashes),
from 3.5 it is loud, with an encore when the work is done. Between, how long the
turn took decides: quiet under 45 seconds, loud from 8 minutes on. A resident with its own
motions also plays one: a clip named for joy (dance, jump, よろこぶ, 開心, 춤, ...) faster when
it is pleased, one named for gloom (droop, fluster, しょんぼり, 難過, 시무룩, ...) slower and
greyer when it is not, and its usual motion when no name fits.

A resident the plugin creates starts with **Motion** on, so the turns, shakes,
clips and states show. One that already exists keeps your setting: with Motion
off, a reaction keeps its emoji, lights and hops only.

While something of yours is open on the resident (a question, your writing, its
settings), it takes no reaction, and pops one emoji for the kind of reply instead.

To give a resident reactions of its own, save a sequence for it named
`emote.<kind>`: `emote.done`, `emote.partial`, `emote.failed`, `emote.asking`,
`emote.running`, `emote.sorry`, `emote.suggesting`, `emote.explaining` or
`emote.greeting` (with `pixling sequence save`, or by asking an agent that has
the Pixling skills). It plays instead of the built-in reaction for that kind.

### Voice

The resident can also say the reply aloud, through [Fish Audio](https://fish.audio).
It is off until the [settings](#settings) have a `voice` object and a key is found.

Not all of a reply is worth hearing. Its Markdown is taken apart first: code
blocks, tables, addresses and pictures are left out, and the rest becomes parts
(a heading, a paragraph, a whole list). The judge is asked about each part, and
only those worth hearing are said: a result, a question to you, what happens
next, and not a list of files. At most 200 characters of one reply are said,
ending on a sentence. A reply the judge would say none of stays silent.

The voice takes the tone of the reply (cheerful when the work is done,
apologetic when the agent is sorry, ...), which Fish Audio's S2 models read from
a cue before the text.

A permission card is heard too, by its question alone ("Allow Bash?"): nobody
judges it, and nothing of the call itself is said or sent.

Your next prompt stops what is still being said, and so does the session's next
reply. Two sessions never talk over each other: the second waits for the first.
The voice is heard whether or not the resident is in view.

The parts that are said (and only those, with the cue) are sent to Fish Audio,
and so is a permission card's question.
The audio is played with `afplay` and kept nowhere.

### Settings

In `~/.config/pixling/proxy.json`, next to the [proxy settings](https://github.com/pixling/agent-kit#settings):

```json
{
  "emote": {
    "endpoint": "https://ai-gateway.vercel.sh/v4/ai",
    "model": "typesafe-ai/jev",
    "apiKeyEnv": "AI_GATEWAY_API_KEY"
  }
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `endpoint` | `https://ai-gateway.vercel.sh/v4/ai` | Where the reply is judged: `POST <endpoint>/evaluation-model`, in the AI Gateway's form |
| `model` | `typesafe-ai/jev` | The evaluation model |
| `apiKey` | none | The key itself. Prefer `apiKeyEnv` if you share your dotfiles |
| `apiKeyEnv` | `AI_GATEWAY_API_KEY` | The environment variable that holds the key, when `apiKey` is not set |
| `threshold` | `0.5` | How sure the judge must be that the reply deserves a reaction, 0 to 1 |

The voice has an object of its own, `voice`, and needs the `emote` settings on:

```json
{
  "emote": {},
  "voice": {
    "voice": "<a voice's id in Fish Audio's library>"
  }
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `apiKey` | none | The Fish Audio key itself. Prefer `apiKeyEnv` if you share your dotfiles |
| `apiKeyEnv` | `FISH_API_KEY` | The environment variable that holds the key, when `apiKey` is not set |
| `voice` | the model's own | The voice, by its id in [Fish Audio's library](https://fish.audio/discovery) |
| `model` | `s2.1-pro` | The speech model |
| `speed` | `1` | How fast it speaks, 0.5 to 2 |
| `volume` | `0` | Louder or quieter, in dB, -20 to 20 |
| `maxChars` | `200` | How much of one reply is said at most, in characters |
| `threshold` | `0.5` | How sure the judge must be that a part is worth saying, 0 to 1 |
| `tone` | `true` | The voice takes the tone of the reply |
| `endpoint` | `https://api.fish.audio` | Where speech is made: `POST <endpoint>/v1/tts` |

The `emote` object turns it on, even empty (`"emote": {}` with the key in
`AI_GATEWAY_API_KEY`): a key in the environment alone sends nothing. An
`endpoint` must be `https:`, or `http:` to this Mac only, since the key travels
with each request.

Setup, the other settings and limits: https://github.com/pixling/agent-kit
