// How long a hook process may take, by event, counted from the process's start (the
// host's own timer starts there too, and a busy machine can spend seconds loading the
// program): under the timeout each host's hook file sets, so that the hook answers
// rather than being killed (on Antigravity, a hook before a tool call that does not
// answer denies the call). `npm run check` compares these with the hook files. Null:
// as long as it takes.
export const BUDGET_SECONDS = {
  'session-start': 12,
  stop: 12,
  'post-invocation': 12,
  wait: null,
  prompt: 8,
  'before-tool': 8,
  'before-tool-now': 30,
  permission: 85,
  'session-end': 1.5,
} as const;

// What of the prompt's budget may go to its optional part (connecting, the reaction to
// the turn's start, looking at the inbox): the user waits for this hook before every
// turn. Reading what the user wrote marks it read, so once begun it is never cut short
// by this, only by the event's budget.
export const PROMPT_OPTIONAL_SECONDS = 3;
