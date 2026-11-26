---
name: pixling-expression
description: >-
  Make your Pixling resident show how the work is going without words: a lasting
  state (working, waiting, done), a one-off emote or light, or a short planned
  motion, with the `pixling` CLI. Use after the `pixling` skill has bound a
  resident, when the user wants the resident to react, animate or show status.
license: MIT
compatibility: macOS with Pixling running, "CLI connection" on, and `pixling` on PATH.
---

# Pixling expression

Assumes a bound resident `$ME` = `client:<namespace>/<key>` (see the `pixling`
skill). Pixling does not decide what "working" or "done" look like: you choose
from what this resident can do, so look first.

## Look before you move

```sh
pixling --json resident describe --to "$ME" --section options --section sequence
pixling resident sketch --to "$ME"
```

`options` lists the idle animations and poses this resident takes.
`sequence` lists its motions, frame counts and colour groups. Use only ids you
read there.

A resident bound with `resident ensure` starts with **Motion** off. A state or
motion shows only after you turn it on, which is a saved setting, so do it once
and only when the user wants the resident to move:

```sh
pixling --json resident set --to "$ME" --motion true
```

## A lasting state

Define a state name's look once per asset, then switch by name. Definitions are
saved and shared by every resident of the same asset, so reuse a name if it
already exists (`yieldsTo` in the result tells you why nothing changed).

```sh
pixling --json status define --to "$ME" --name working --hold-animation <idleAnimation id>
pixling --json resident status --to "$ME" --name working          # lasts 10 min; send again to extend
pixling --json resident status --to "$ME" --clear                  # back to normal
```

`message send` and `question ask` take `--status <name>` too. A question's state
lasts while the card is open.

Set the state from one place. If several agents share the resident, the newest
call wins.

## A one-off signal

Forgotten as soon as it plays, nothing saved:

```sh
pixling --json resident emote --to "$ME" --text "🎉" --count 3
pixling --json resident glow --to "$ME" --shape pulse --color "#FFD54A" --duration-ms 600
pixling --json resident glow --to "$ME" --steps-json '[{"select":"all","shape":"sweep","direction":"bottom-to-top","color":"#FFF3B0","durationMs":800}]'
```

- Emote text: one line, up to 12 characters.
- Glow: `pulse`, `sweep` or `blink`; up to 8 steps and 10 s.

Good defaults: a short pulse when you finish, a cool sweep when something fails,
an emote when you need the user's eyes. Do not signal on every step.

## A planned motion

Send the whole plan at once; the app keeps the time. Validate first with
`--dry-run`, then send again without it.

```sh
pixling --json sequence start --to "$ME" --commit restore --dry-run --steps '[
  {"kind":"repeat","times":2,"steps":[
    {"kind":"cut","holdMs":180,"move":{"dx":0,"dy":30},"easing":"smooth"},
    {"kind":"cut","holdMs":220,"move":{"dx":0,"dy":-30},"easing":"smooth"}
  ]}
]'
```

- `--commit restore` puts the resident back where it started when the run ends.
  Use it unless the user asked you to move the resident for good.
- Up to 32 steps (128 after `repeat`), 30 s in total, each cut at most 10 s.
- `turn` is relative to the previous cut: undo every tilt with its opposite.
- A refusal names the step (`at steps[2]…`) and the reason on the next line.

Run `pixling schema sequence.start` or `pixling sequence start --help` for every
field. Complex JSON payloads (including full `resident.set` appearance fields,
groups, or relations) can also be sent directly with `pixling call <op> '{...}'`
or piped to `pixling call <op> -`.

## Saved changes

`resident set`, `status define`, `sequence save` and `resident place` are
saved. Make them only when the user asks or agrees; states, emotes, light and
`--commit restore` runs are not saved.

Reference: https://pixling.app/docs/connect/expression/
