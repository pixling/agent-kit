// pixling-proxy for pi (earendil-works/pi), as a pi extension.
// Bundled into packages/pi/dist with no runtime dependencies. The pi types below
// cover only the parts this extension uses.
import { loadConfig } from '../../core/config.ts';
import type { SessionExtension } from '../../runtimes/base.ts';
import { makeLive } from '../../runtimes/live/index.ts';

interface PiContext {
  mode: 'tui' | 'rpc' | 'json' | 'print';
  isIdle(): boolean;
  sessionManager: { getSessionId(): string };
}

interface PiMessage {
  role: string;
  content?: string | { type: string; text?: string; thinking?: string }[];
}

interface ExtensionAPI {
  on(event: 'session_start', fn: (ev: { reason: string }, ctx: PiContext) => unknown): void;
  on(event: 'session_shutdown', fn: (ev: { reason: string }, ctx: PiContext) => unknown): void;
  on(event: 'message_end', fn: (ev: { message: PiMessage }, ctx: PiContext) => unknown): void;
  on(event: 'tool_execution_start', fn: (ev: { toolName: string }, ctx: PiContext) => unknown): void;
  on(event: 'agent_end', fn: (ev: { messages: PiMessage[] }, ctx: PiContext) => unknown): void;
  on(event: 'agent_settled', fn: (ev: { aborted?: boolean }, ctx: PiContext) => unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
}

function textOf(message: PiMessage | undefined): string | undefined {
  if (message?.role !== 'assistant') return undefined;
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

function reasoningOf(message: PiMessage): string {
  if (message.role !== 'assistant' || typeof message.content === 'string') return '';
  return (message.content ?? [])
    .filter((c) => c.type === 'thinking')
    .map((c) => c.thinking ?? '')
    .join('\n');
}

// The extension, with what `extension` adds to every session (src/bin passes the
// emote extension; the adapter knows nothing of it).
export const piProxy = (extension?: SessionExtension) =>
  function pixlingProxy(pi: ExtensionAPI): void {
    // pi rebuilds extensions on /new, /resume and reload, so all state lives
    // between session_start and session_shutdown.
    let live: ReturnType<typeof makeLive> | null = null;
    let id = '';
    let listen = false;
    let lastText: string | undefined;

    // pi waits for its handlers, so none of them waits for Pixling. Each session's texts
    // still show in order, and closing lets them finish.
    pi.on('session_start', (_ev, ctx) => {
      const config = loadConfig();
      // print and json runs (including subagents pi starts) have nobody to talk to:
      // no resident, or with `unattended` one that only shows replies.
      const interactive = ctx.mode === 'tui';
      if (!interactive && !config.unattended) return;
      id = ctx.sessionManager.getSessionId();
      // What the user writes starts a turn when pi is idle, and waits its turn otherwise.
      live = makeLive(
        {
          namespace: 'pi',
          author: 'pi',
          deliver: (_id, text) => pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: 'followUp' }),
        },
        extension,
      );
      listen = interactive;
      void live.start(id, { listen });
    });

    // Each assistant message as it ends: what the agent says between tool calls.
    pi.on('message_end', (ev) => {
      // Pixling may have started since.
      void live?.start(id, { listen });
      void live?.observe(id, { kind: 'reasoning', form: 'full', text: reasoningOf(ev.message) });
      void live?.observe(id, { kind: 'text', text: textOf(ev.message) ?? '' });
    });

    pi.on('tool_execution_start', (ev) => {
      void live?.observe(id, { kind: 'tool', name: ev.toolName });
    });

    pi.on('agent_end', (ev) => {
      lastText = textOf(ev.messages.filter((m) => m.role === 'assistant').at(-1));
    });

    // Once nothing else will run on its own: the reply the user is waiting for.
    pi.on('agent_settled', (ev) => {
      const text = lastText;
      lastText = undefined;
      if (!ev.aborted) void live?.finish(id, text);
    });

    pi.on('session_shutdown', () => {
      live?.closeAll();
      live = null;
    });
  };

export default piProxy();
