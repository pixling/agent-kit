// What the agent does during a turn, in no host's terms, and which of it the user
// wants to see, how often and in what words. Pure: no Effect, no I/O.
//
// The turn's reply and permission prompts are not activities: each has its own
// guarantee (see turnEnded and askPermission in Conversation.ts).
import { createHash } from 'node:crypto';
import { clip } from './text.ts';

export type Activity =
  | { readonly kind: 'text'; readonly text: string }
  // `summary`: what the host wrote about its reasoning. `full`: the reasoning itself.
  | { readonly kind: 'reasoning'; readonly form: 'full' | 'summary'; readonly text: string }
  // The name as the host spells it. The input is left out on purpose: it can hold
  // secrets, and what is sent travels to the CLI as arguments.
  | { readonly kind: 'tool'; readonly name: string };

export interface ShowPolicy {
  readonly reply: boolean;
  readonly text: boolean;
  readonly reasoning: 'none' | 'summary' | 'all';
  // A list of globs, the last match decides. `!` hides. A list starting with `!`
  // starts from everything: ["!Read"] is every tool but Read.
  readonly tools: 'none' | 'all' | ReadonlyArray<string>;
  // At most one flush in this time. The turn's end and a permission prompt do not wait.
  readonly everyMs: number;
  readonly maxChars: number;
}

const globMatches = (glob: string, name: string): boolean =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name);

export const showsTool = (tools: ShowPolicy['tools'], name: string): boolean => {
  if (typeof tools === 'string') return tools === 'all';
  let shown = tools[0]?.startsWith('!') ?? false;
  for (const rule of tools) {
    const hides = rule.startsWith('!');
    if (globMatches(hides ? rule.slice(1) : rule, name)) shown = !hides;
  }
  return shown;
};

export const admits = (policy: ShowPolicy, activity: Activity): boolean => {
  switch (activity.kind) {
    case 'text':
      return policy.text && !!activity.text.trim();
    case 'reasoning':
      return (
        !!activity.text.trim() &&
        (policy.reasoning === 'all' || (policy.reasoning === 'summary' && activity.form === 'summary'))
      );
    case 'tool':
      return !!activity.name && showsTool(policy.tools, activity.name);
  }
};

// Whether anything between replies is wanted at all.
export const watches = (policy: ShowPolicy): boolean =>
  policy.text || policy.reasoning !== 'none' || policy.tools !== 'none';

// Whether the transcript's prose is wanted, as opposed to only tool names.
export const wantsProse = (policy: ShowPolicy): boolean => policy.text || policy.reasoning !== 'none';

export const isDue = (policy: ShowPolicy, lastShownAt: number, now: number): boolean =>
  now - lastShownAt >= policy.everyMs;

export const fingerprint = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);

const toolLine = (names: ReadonlyArray<string>): string => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => `\`${name.replaceAll('`', '')}\`${count > 1 ? ` ×${count}` : ''}`)
    .join(' · ');
};

const quoted = (text: string): string =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

interface Part {
  readonly text: string;
  readonly toolsOnly: boolean;
}

// In order, tool calls in a row as one line.
const partsOf = (items: ReadonlyArray<Activity>): Part[] => {
  const parts: Part[] = [];
  let names: string[] = [];
  const endTools = () => {
    if (names.length) parts.push({ text: toolLine(names), toolsOnly: true });
    names = [];
  };
  for (const item of items) {
    if (item.kind === 'tool') {
      names.push(item.name);
      continue;
    }
    endTools();
    parts.push({ text: item.kind === 'text' ? item.text.trim() : quoted(item.text), toolsOnly: false });
  }
  endTools();
  return parts;
};

export interface Bubble {
  readonly text: string;
  // Nothing but tool names: not worth the resident moving for.
  readonly still: boolean;
}

// One bubble when it fits, so a flush takes one place in the resident's window. Only
// what no bubble can hold is cut.
export const bubbles = (items: ReadonlyArray<Activity>, maxChars: number): Bubble[] => {
  const result: Bubble[] = [];
  let open: { texts: string[]; length: number; still: boolean } | null = null;
  const close = () => {
    if (open) result.push({ text: open.texts.join('\n\n'), still: open.still });
    open = null;
  };
  for (const part of partsOf(items)) {
    const text = clip(part.text, maxChars);
    const length = Array.from(text).length;
    if (open && open.length + 2 + length > maxChars) close();
    open = open
      ? { texts: [...open.texts, text], length: open.length + 2 + length, still: open.still && part.toolsOnly }
      : { texts: [text], length, still: part.toolsOnly };
  }
  close();
  return result;
};
