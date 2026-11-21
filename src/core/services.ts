// What the conversation needs from the world, in no host's terms. Runtimes and
// adapters provide these; `Desk` (src/pixling) is the other half.
import { Context, Effect } from 'effect';
import type { Pair } from '../pixling/Desk.ts';
import type { Activity } from './Activity.ts';
import type { Config } from './config.ts';

export class ProxyConfig extends Context.Service<ProxyConfig, Config>()('pixling-proxy/core/ProxyConfig') {}

export class CurrentSession extends Context.Service<
  CurrentSession,
  Pair & { readonly selector: string; readonly author: string }
>()('pixling-proxy/core/CurrentSession') {}

export interface Shown {
  readonly at: number;
  readonly said?: string | undefined;
}

// What the proxy remembers about a session between events and across processes.
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly isBound: Effect.Effect<boolean>;
    readonly markBound: Effect.Effect<void>;
    readonly isStowed: Effect.Effect<boolean>;
    readonly markStowed: Effect.Effect<void>;
    readonly since: Effect.Effect<number>;
    setSince(sequence: number): Effect.Effect<void>;
    // True for exactly one caller per inbox entry, across processes.
    claim(messageID: string): Effect.Effect<boolean>;
    unclaim(messageID: string): Effect.Effect<void>;
    // When something last showed, and the fingerprint of the last text that did.
    readonly shown: Effect.Effect<Shown>;
    setShown(shown: Shown): Effect.Effect<void>;
    // What an extension remembers for the session: a small JSON value under its name.
    memo(name: string): Effect.Effect<unknown>;
    setMemo(name: string, value: unknown): Effect.Effect<void>;
  }
>()('pixling-proxy/core/SessionStore') {}

// What a runtime has seen the agent do and not yet had shown. `position` names this
// stretch of it: a retry has the same one, and what follows a shown stretch never does.
export interface Batch {
  readonly items: ReadonlyArray<Activity>;
  readonly position: string;
}

export class ActivitySource extends Context.Service<
  ActivitySource,
  {
    // Something the agent did that the runtime cannot read back later.
    observe(activity: Activity): Effect.Effect<void>;
    // Hands over what waits. It stays waiting unless `show` answers true, and is left
    // alone while another process of the session is at it.
    drain<R>(show: (batch: Batch) => Effect.Effect<boolean, never, R>): Effect.Effect<void, never, R>;
    // A reply shown ahead of the source: when its text comes in, it is not handed over.
    replied(text: string): Effect.Effect<void>;
  }
>()('pixling-proxy/core/ActivitySource') {}

// Whatever keeps the inbox open so the user can type to the resident.
export class Receiver extends Context.Service<Receiver, { readonly stop: Effect.Effect<void> }>()(
  'pixling-proxy/core/Receiver',
) {}

// Something the resident may show: the session starting, and during a turn its start,
// a tool call (by name only), a permission prompt, its end (once its reply shows).
export type Moment =
  | { readonly kind: 'start' }
  | { readonly kind: 'turn' }
  | { readonly kind: 'tool'; readonly name: string }
  // `question`: what its card asks, which names the tool and nothing of the call.
  | { readonly kind: 'permission'; readonly question: string }
  | { readonly kind: 'end' };

// How the resident takes the turn's reply. By default it moves for it as for any
// message; a plugin built with an extension (src/extensions) can take that over.
export interface ExpressionService {
  // The reply arrives still, because `replied` moves the resident for it.
  readonly movesForReply: boolean;
  // The reply is on the resident. Returns at once: the host is waiting for the turn to end.
  replied(text: string): Effect.Effect<void>;
  // Tool calls are wanted even when the user's `show` settings show none.
  readonly noticesTools: boolean;
  // Something happened during the turn. Quick: the host may be waiting.
  noticed(moment: Moment): Effect.Effect<void>;
  // Settings for a resident the proxy creates (never for one that exists).
  readonly initialSettings: Record<string, unknown> | null;
  // The resident's state while a permission card waits on it, by name.
  readonly askingStatus: Effect.Effect<string | null>;
}

export const Expression = Context.Reference<ExpressionService>('pixling-proxy/core/Expression', {
  defaultValue: () => ({
    movesForReply: false,
    replied: () => Effect.void,
    noticesTools: false,
    noticed: () => Effect.void,
    initialSettings: null,
    askingStatus: Effect.succeed(null),
  }),
});
