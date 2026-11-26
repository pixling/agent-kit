// What an adapter gives the hook runtime: its host's payloads as the proxy's input,
// and the proxy's answers in its host's format.
import { Context, type Effect, type Schema } from 'effect';
import type { Activity } from '../../core/Activity.ts';
import type { Config } from '../../core/config.ts';
import type { PermissionAnswer } from '../../core/Conversation.ts';
import type { Daemons } from '../Daemons.ts';

// The fields of a hook payload the proxy reads, in the proxy's words.
export interface HookInput {
  readonly sessionId: string;
  readonly source?: string | null | undefined;
  readonly reason?: string | null | undefined;
  readonly finalText?: string | null | undefined;
  readonly transcriptPath?: string | null | undefined;
  readonly toolName?: string | null | undefined;
  readonly toolInput?: unknown;
  readonly toolUseId?: string | null | undefined;
  // The hook fired inside a subagent: the resident shows only the main thread.
  readonly inSubagent?: boolean | undefined;
  // A Stop hook that already continued the turn once.
  readonly turnContinued?: boolean | null | undefined;
}

// What a hook process hands back to its host.
export interface HookOutput {
  // Written to stdout. Hosts expect JSON there; `{}` decides nothing.
  readonly stdout: object;
  // Written to stderr with exit code 2, for hosts that wake on it.
  readonly wake?: string | undefined;
}

export const NOTHING: HookOutput = { stdout: {} };

export class HookHost extends Context.Service<
  HookHost,
  {
    readonly id: string;
    readonly author: string;
    // The host process, which the proxy's daemons follow.
    readonly pid: Effect.Effect<number | null>;
    // A one-shot run: nobody is there to type.
    readonly unattended: Effect.Effect<boolean>;
    // The host waits for every hook: slow work goes to a detached process.
    readonly waitsForHooks: boolean;
    // The `prompt` event fires before every model call, not only when the user prompts.
    readonly promptEachStep?: boolean | undefined;
    payload(raw: unknown): Effect.Effect<HookInput, Schema.SchemaError>;
    // What a main-thread line of the host's transcript (JSONL) shows the agent doing.
    // Translates only: what to show is not an adapter's to decide. Tool calls come
    // from the hook payload, which is there before the transcript has them.
    activitiesOf(row: unknown): ReadonlyArray<Activity>;
    // Text handed to the agent: the binding at session start, or what the user wrote.
    tell(kind: 'session-start' | 'user', text: string): HookOutput;
    // Continues a turn that was about to end, with what the user wrote.
    resume(text: string): HookOutput;
    // For hosts with no idle wake-up API: hold open in `post-invocation` once the model
    // finishes without tool calls, and inject what the user wrote as the next step.
    readonly holdAtStepEnd?: ((config: Config) => number) | undefined;
    readonly stepEndedReply?:
      | ((transcriptPath: string | null | undefined) => { readonly text: string | null } | null)
      | undefined;
    readonly continueStep?: ((text: string) => HookOutput) | undefined;
    // Ends step-end waiting early when the host has pending local work or input
    // (background task completions, subagent replies, timers, or queued terminal prompts).
    readonly waitInterrupted?: ((input: HookInput) => Effect.Effect<void>) | undefined;
    // What a hook before a tool call answers to leave the call to the host's own checks.
    readonly passTool: HookOutput;
    permission(answer: PermissionAnswer): HookOutput;
    // Tools whose "permission" is the user's own reply (a question, a plan to approve).
    // Answering Allow on a card would skip that reply, so the host handles them.
    readonly toolsThatAskTheUser?: ReadonlyArray<string> | undefined;
    // A long-running hook can wake an idle session: blocks in the `wait` event, and
    // answers with this. Without it, a turn may be held open instead (`turnEndWaitMs`).
    readonly wakesFromWait?: ((text: string) => HookOutput) | undefined;
    // Starts whatever else carries the user's messages to an idle session.
    onSessionStart?:
      | ((context: {
          readonly sessionId: string;
          readonly hostPid: number | null;
        }) => Effect.Effect<void, never, Daemons>)
      | undefined;
    readonly onSessionEnd?: Effect.Effect<void, never, Daemons> | undefined;
  }
>()('pixling-proxy/runtimes/hook/HookHost') {}
