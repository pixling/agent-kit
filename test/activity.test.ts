import { describe, expect, test } from 'vite-plus/test';
import { type Activity, admits, bubbles, isDue, type ShowPolicy, showsTool } from '../src/core/Activity.ts';

const policy: ShowPolicy = { reply: true, text: true, reasoning: 'none', tools: 'none', everyMs: 0, maxChars: 4000 };
const text = (body: string): Activity => ({ kind: 'text', text: body });
const tool = (name: string): Activity => ({ kind: 'tool', name });

describe('showsTool', () => {
  test.each([
    ['none', 'Bash', false],
    ['all', 'Bash', true],
    [['Bash', 'run_command'], 'run_command', true],
    [['Bash'], 'Read', false],
    [['!Read', '!Grep'], 'Bash', true],
    [['!Read', '!Grep'], 'Grep', false],
    [['mcp__*', '!mcp__pixling__*'], 'mcp__slack__send', true],
    [['mcp__*', '!mcp__pixling__*'], 'mcp__pixling__message_send', false],
    // The last match decides.
    [['!mcp__*', 'mcp__slack__*'], 'mcp__slack__send', true],
    // A name is a whole name, and its dots are dots.
    [['Read'], 'ReadFile', false],
    [['a.b'], 'axb', false],
    [[], 'Bash', false],
  ] as const)('%j, %s: %s', (rules, name, expected) => {
    expect(showsTool(rules, name)).toBe(expected);
  });
});

describe('admits', () => {
  const summary: Activity = { kind: 'reasoning', form: 'summary', text: 'why' };
  const full: Activity = { kind: 'reasoning', form: 'full', text: 'why' };

  test('reasoning, by how much of it is wanted', () => {
    expect([admits(policy, summary), admits(policy, full)]).toEqual([false, false]);
    const some = { ...policy, reasoning: 'summary' } as const;
    expect([admits(some, summary), admits(some, full)]).toEqual([true, false]);
    const all = { ...policy, reasoning: 'all' } as const;
    expect([admits(all, summary), admits(all, full)]).toEqual([true, true]);
  });

  test('nothing to read is nothing to show', () => {
    expect(admits(policy, text('  '))).toBe(false);
    expect(admits({ ...policy, reasoning: 'all' }, { ...full, text: '' })).toBe(false);
  });
});

test('isDue', () => {
  expect(isDue(policy, 100, 100)).toBe(true);
  expect(isDue({ ...policy, everyMs: 50 }, 100, 149)).toBe(false);
  expect(isDue({ ...policy, everyMs: 50 }, 100, 150)).toBe(true);
});

describe('bubbles', () => {
  test('reasoning reads as a quote, and tool calls in a row as one line', () => {
    const items: Activity[] = [
      { kind: 'reasoning', form: 'full', text: 'line one\nline two' },
      tool('Read'),
      tool('Bash'),
      tool('Read'),
      text('Done.'),
      tool('Edit'),
    ];
    expect(bubbles(items, 4000)).toEqual([
      { text: '> line one\n> line two\n\n`Read` ×2 · `Bash`\n\nDone.\n\n`Edit`', still: false },
    ]);
  });

  test('only tool calls: the resident stays still', () => {
    expect(bubbles([tool('Bash')], 4000)).toEqual([{ text: '`Bash`', still: true }]);
  });

  test('what does not fit goes in the next bubble, and only a text too long for one is cut', () => {
    const shown = bubbles([text('a'.repeat(8)), text('b'.repeat(8)), text('c'.repeat(30))], 10);
    expect(shown.map((b) => b.text)).toEqual(['a'.repeat(8), 'b'.repeat(8), `${'c'.repeat(9)}…`]);
  });

  test('nothing, no bubble', () => {
    expect(bubbles([], 4000)).toEqual([]);
  });
});
