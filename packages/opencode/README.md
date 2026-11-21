# @pixling/opencode-proxy

Talk with OpenCode through a [Pixling](https://pixling.app) resident on your Mac
desktop: replies show on it, permission prompts become questions on it, and what
you type there goes back to the session, even when it is idle.

```json
{ "plugin": ["@pixling/opencode-proxy"] }
```

Add that to `opencode.json`. Requires Pixling with **CLI connection** on and
`pixling` on your PATH. Experimental: tried on OpenCode 2.2.5, and written for
the 1.x plugin API too.

More: https://github.com/pixling/agent-kit
