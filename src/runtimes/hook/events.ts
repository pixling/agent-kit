// One handler per hook event: hosts are only ever seen through HookHost.
import { spawn } from 'node:child_process';
import { Effect, Fiber, Layer, Option, Schema } from 'effect';
import { watches, wantsProse } from '../../core/Activity.ts';
import {
  askPermission,
  ensureResident,
  noticeStart,
  noticeTurn,
  observed,
  showPending,
  takeUserMessages,
  turnEnded,
  turnStarted,
  waitForUser,
} from '../../core/Conversation.ts';
import { CurrentSession, Expression, ProxyConfig, SessionStore } from '../../core/services.ts';
import { boundContext, type Relayed, userMessageForAgent } from '../../core/text.ts';
import type { Desk } from '../../pixling/Desk.ts';
import { hostGone, type SessionExtension } from '../base.ts';
import { Daemons, DaemonsLive, RECEIVER } from '../Daemons.ts';
import { PROMPT_OPTIONAL_SECONDS } from './budgets.ts';
import { forgetOldSessions, lastActive, SessionLocks, sessionFiles } from '../SessionFiles.ts';
import { log } from '../log.ts';
import { nodeRuntime } from '../process.ts';
import { HookHost, type HookInput, type HookOutput, NOTHING } from './HookHost.ts';
import { lastAssistantText, startReading, transcriptActivities, untilWritten } from './transcript.ts';

// The waiter leaves before its hook's timeout (6 h in hooks.json), so a timeout never shows as an error.
const WAIT_MS = 6 * 3600 * 1000 - 60_000;
// Marks a reply already flushed and reacted to in `post-invocation`, so the trailing
// `stop` event does not show or react to it a second time.
const STEP_ENDED_MEMO = 'step-ended';

const clearStepEnded = Effect.gen(function* () {
  const store = yield* SessionStore;
  if ((yield* store.memo(STEP_ENDED_MEMO)) === true) yield* store.setMemo(STEP_ENDED_MEMO, false);
});

const watching = Effect.map(ProxyConfig, ({ show }) => watches(show));
// Tool calls are wanted: to show, or for a bound resident to react to.
const wantsTools = Effect.gen(function* () {
  if (yield* watching) return true;
  const { noticesTools } = yield* Expression;
  return noticesTools && (yield* (yield* SessionStore).isBound);
});

// Starts what lets the user write to the resident. Safe to run again: each daemon is
// held by a lock, so a running one is left alone.
const listen = Effect.fn('hook.listen')(function* (input: HookInput) {
  const host = yield* HookHost;
  const daemons = yield* Daemons;
  const hostPid = yield* host.pid;
  yield* daemons.start(RECEIVER, { hostPid });
  if (host.onSessionStart) yield* host.onSessionStart({ sessionId: input.sessionId, hostPid });
});

// Binds the resident and starts what lets the user write to it.
const connect = Effect.fn('hook.connect')(function* (input: HookInput, unattended: boolean) {
  const state = yield* ensureResident();
  if (state === 'onDesk' && !unattended) yield* listen(input);
  return state;
});

const sessionStart = Effect.fn('hook.sessionStart')(function* (input: HookInput, unattended: boolean) {
  const host = yield* HookHost;
  yield* forgetOldSessions;
  const state = yield* connect(input, unattended);
  yield* Effect.logInfo(`session-start ensure=${state}`);
  if (state !== 'onDesk') return NOTHING;
  // After a compaction the conversation goes on, and what waits still has to show.
  if ((yield* watching) && input.source !== 'compact') yield* startReading(input.transcriptPath);
  // A session that begins, not one that goes on (resumed, cleared, compacted).
  if (!input.source || input.source === 'startup') yield* noticeStart;
  return host.tell('session-start', boundContext(yield* CurrentSession));
});

// Pixling may start after the session did: the next event connects instead. True
// when this one did.
const connectLate = Effect.fn('hook.connectLate')(function* (input: HookInput, unattended: boolean) {
  const store = yield* SessionStore;
  if ((yield* store.isBound) || (yield* store.isStowed)) return false;
  if ((yield* connect(input, unattended)) !== 'onDesk') return false;
  if (yield* watching) yield* startReading(input.transcriptPath);
  yield* Effect.logInfo(`connected late`);
  return true;
});

const stop = Effect.fn('hook.stop')(function* (input: HookInput, unattended: boolean) {
  const host = yield* HookHost;
  const store = yield* SessionStore;
  if ((yield* store.memo(STEP_ENDED_MEMO)) === true) {
    yield* clearStepEnded;
    return NOTHING;
  }
  const late = yield* connectLate(input, unattended);
  if (yield* store.isStowed) return NOTHING;
  yield* turnEnded(input.finalText ?? lastAssistantText(input.transcriptPath, host.activitiesOf));
  // A daemon that took the session for gone (its host unknown, quiet for hours: see
  // hostGone) is back by the end of the next turn, after the reply, which never waits
  // for it.
  if (!late && !unattended && (yield* store.isBound)) yield* listen(input);
  // Optionally hold the turn open for the user's answer on the resident, where
  // nothing else wakes an idle session for it.
  const config = yield* ProxyConfig;
  const holdMs = host.wakesFromWait || host.holdAtStepEnd ? 0 : config.turnEndWaitMs;
  if (holdMs > 0 && !input.turnContinued) {
    const texts = yield* waitForUser(holdMs);
    if (texts.length) {
      yield* turnStarted;
      return host.resume(userMessageForAgent(texts, yield* CurrentSession));
    }
  }
  return NOTHING;
});

// For hosts without an idle wake-up API: once the model finishes a step with no tool
// calls, show the reply and hold the execution open for what the user writes on the
// resident, injecting it as the next user message.
const postInvocation = Effect.fn('hook.postInvocation')(function* (input: HookInput, unattended: boolean) {
  const host = yield* HookHost;
  const config = yield* ProxyConfig;
  const store = yield* SessionStore;
  const locks = yield* SessionLocks;
  const holdMs = host.holdAtStepEnd?.(config) ?? 0;
  if (unattended || holdMs <= 0 || !config.receive || !host.stepEndedReply || !host.continueStep) return NOTHING;
  const ended = host.stepEndedReply(input.transcriptPath);
  if (!ended) return NOTHING;
  const late = yield* connectLate(input, unattended);
  if (yield* store.isStowed) return NOTHING;
  yield* turnEnded(ended.text);
  yield* store.setMemo(STEP_ENDED_MEMO, true);
  if (!late && (yield* store.isBound)) yield* listen(input);
  if ((yield* store.isStowed) || !(yield* store.isBound)) return NOTHING;
  // A previous waiter left behind by an interrupted turn is replaced cleanly.
  yield* locks.stopHolder('waiter');
  if (!(yield* locks.lock('waiter'))) return NOTHING;
  return yield* Effect.gen(function* () {
    const gone = hostGone((yield* host.pid) ?? 0, lastActive(host.id, input.sessionId)).pipe(
      Effect.as<ReadonlyArray<Relayed>>([]),
    );
    const texts = yield* waitForUser(holdMs).pipe(Effect.raceFirst(gone));
    yield* Effect.logInfo(`post-invocation woke texts=${texts.length}`);
    if (!texts.length) return NOTHING;
    yield* clearStepEnded;
    yield* turnStarted;
    yield* noticeTurn;
    return host.continueStep!(userMessageForAgent(texts, yield* CurrentSession));
  }).pipe(Effect.ensuring(locks.unlock('waiter')));
});

// Blocks until the user writes, then wakes the session with the message. One waiter per session.
const wait = Effect.fn('hook.wait')(function* (input: HookInput, unattended: boolean) {
  const host = yield* HookHost;
  const config = yield* ProxyConfig;
  const store = yield* SessionStore;
  const locks = yield* SessionLocks;
  const wake = host.wakesFromWait;
  if (!wake || unattended || !config.receive || (yield* store.isStowed) || !(yield* locks.lock('waiter'))) {
    return NOTHING;
  }
  return yield* Effect.gen(function* () {
    // SessionStart runs its hooks in parallel: bind here too, so waiting never
    // starts on a pair that is not bound yet.
    if ((yield* connect(input, unattended)) !== 'onDesk') return NOTHING;
    // A host that crashed never ends this hook itself.
    const gone = hostGone((yield* host.pid) ?? 0, lastActive(host.id, input.sessionId)).pipe(
      Effect.as<ReadonlyArray<Relayed>>([]),
    );
    const texts = yield* waitForUser(WAIT_MS).pipe(Effect.raceFirst(gone));
    yield* Effect.logInfo(`wait woke texts=${texts.length}`);
    if (!texts.length) return NOTHING;
    yield* turnStarted;
    yield* noticeTurn;
    return wake(userMessageForAgent(texts, yield* CurrentSession));
  }).pipe(Effect.ensuring(locks.unlock('waiter')));
});

// Messages that arrived while nothing was waiting reach the agent with the next
// prompt (or before the next model call, on hosts whose event fires then).
// Its optional part gets what is left of PROMPT_OPTIONAL_SECONDS since the process
// started (the user is waiting); reading what the user wrote, once begun, finishes.
const promptLeftMs = () => Math.max(0, PROMPT_OPTIONAL_SECONDS * 1000 - process.uptime() * 1000);
// The inbox gets a look even when starting up took all of that (a slow machine every
// time): what the user wrote would otherwise wait for the waiter, turn after turn. A
// best effort: a machine that slow may take longer than this to start the CLI too.
const MIN_LOOK_MS = 500;

const prompt = Effect.fn('hook.prompt')(function* (input: HookInput, unattended: boolean) {
  const host = yield* HookHost;
  yield* clearStepEnded;
  // Cut short once bound, it still bound here: an already bound session returns at once.
  const connected = yield* Effect.timeoutOption(connectLate(input, unattended), promptLeftMs());
  const late = Option.isSome(connected) ? connected.value : yield* (yield* SessionStore).isBound;
  yield* turnStarted;
  // The reaction to the turn's start runs alongside and never holds the messages back:
  // it gets what time is left once they are in hand, and is cut off with the hook.
  const reaction = yield* Effect.forkChild(host.promptEachStep ? Effect.void : noticeTurn);
  const texts = yield* takeUserMessages(Math.max(promptLeftMs(), MIN_LOOK_MS));
  yield* Effect.timeoutOption(Fiber.join(reaction), promptLeftMs());
  const session = yield* CurrentSession;
  if (!texts.length) return late ? host.tell('session-start', boundContext(session)) : NOTHING;
  const message = userMessageForAgent(texts, session);
  return host.tell('user', late ? `${boundContext(session)}\n\n${message}` : message);
});

// The child reads the proxy's own fields, not the host's payload (see BeforeToolNow).
const detach = (hostId: string, input: BeforeToolInput) =>
  Effect.sync(() => {
    const child = spawn(nodeRuntime(), [process.argv[1], hostId, 'before-tool-now'], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    child.on('error', (e) => log(`detach before-tool-now failed: ${e.message}`));
    child.stdin?.end(JSON.stringify(input));
    child.unref();
  });

// The tool call, and what the agent wrote since the last one. The text before it is
// only sure to be in the transcript once the call's own line is.
const showBeforeTool = Effect.fn('hook.showBeforeTool')(function* (input: HookInput) {
  const { show } = yield* ProxyConfig;
  if (wantsProse(show) && input.transcriptPath && input.toolUseId) {
    yield* untilWritten(input.transcriptPath, input.toolUseId);
  }
  if (input.toolName) yield* observed({ kind: 'tool', name: input.toolName });
  else yield* showPending();
});

// A host that waits for its hooks gets its answer at once, and a detached copy does the work.
const beforeTool = Effect.fn('hook.beforeTool')(function* (input: HookInput) {
  const host = yield* HookHost;
  if (!(yield* wantsTools) || input.inSubagent) return host.passTool;
  if (host.waitsForHooks) {
    yield* detach(host.id, {
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath ?? undefined,
      toolUseId: input.toolUseId ?? undefined,
      toolName: input.toolName ?? undefined,
    });
  } else {
    yield* showBeforeTool(input);
  }
  return host.passTool;
});

const beforeToolNow = Effect.fn('hook.beforeToolNow')(function* (input: HookInput) {
  if (yield* wantsTools) yield* showBeforeTool(input);
  return NOTHING;
});

const permission = Effect.fn('hook.permission')(function* (input: HookInput) {
  const host = yield* HookHost;
  if (input.toolName && host.toolsThatAskTheUser?.includes(input.toolName)) return NOTHING;
  const answer = yield* askPermission({ tool: input.toolName || 'tool', input: input.toolInput });
  return answer ? host.permission(answer) : NOTHING;
});

const sessionEnd = Effect.fn('hook.sessionEnd')(function* (input: HookInput) {
  const host = yield* HookHost;
  const daemons = yield* Daemons;
  const locks = yield* SessionLocks;
  yield* Effect.logInfo(`session-end reason=${input.reason ?? ''}`);
  yield* daemons.stop(RECEIVER);
  if (host.onSessionEnd) yield* host.onSessionEnd;
  yield* locks.stopHolder('waiter');
  return NOTHING;
});

const EVENTS = {
  'session-start': sessionStart,
  stop,
  'post-invocation': postInvocation,
  wait,
  prompt,
  'before-tool': beforeTool,
  'before-tool-now': beforeToolNow,
  permission,
  'session-end': sessionEnd,
};

export type HookEvent = keyof typeof EVENTS;
export const isHookEvent = (event: string): event is HookEvent => Object.hasOwn(EVENTS, event);

// The proxy's own fields, as a detached copy of the hook receives them.
const BeforeToolNow = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  transcriptPath: Schema.optional(Schema.String),
  toolUseId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
});
type BeforeToolInput = typeof BeforeToolNow.Type;

// What the hook answers when the proxy has nothing to do: a hook before a tool call
// must still leave the call to the host (on some hosts no answer denies it).
export const idle = (event: HookEvent) =>
  Effect.map(HookHost, (host): HookOutput => (event === 'before-tool' ? host.passTool : NOTHING));

export const handleEvent = Effect.fn('hook.event')(function* (
  event: HookEvent,
  raw: unknown,
  extension: SessionExtension = Layer.empty,
) {
  const host = yield* HookHost;
  const config = yield* ProxyConfig;
  const input: HookInput =
    event === 'before-tool-now' ? yield* Schema.decodeUnknownEffect(BeforeToolNow)(raw) : yield* host.payload(raw);
  // A worker started in a one-shot run is not a conversation with the user.
  const unattended = yield* host.unattended;
  if (unattended && !config.unattended) return yield* idle(event);
  yield* Effect.logInfo(`${host.id} ${event} ${input.sessionId} unattended=${unattended} source=${input.source ?? ''}`);
  const files = sessionFiles({ namespace: host.id, key: input.sessionId, author: host.author });
  const session = Layer.mergeAll(DaemonsLive, transcriptActivities(input.transcriptPath), extension).pipe(
    Layer.provideMerge(files),
  );
  const program: Effect.Effect<HookOutput, never, Layer.Success<typeof session> | HookHost | ProxyConfig | Desk> =
    EVENTS[event](input, unattended);
  return yield* program.pipe(Effect.provide(session));
});
