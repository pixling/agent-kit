// What of a reply can be said aloud: its Markdown taken apart into parts a voice can
// read, and the choice among them once the judge has heard each. Pure functions.
import type { Mood } from '../emote/reactions.ts';

// The judge hears at most this many parts, each at most this long. What comes after
// is never said: a reply leads with what matters.
export const MAX_PARTS = 12;
export const MAX_PART_CHARS = 300;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE = /^ {0,3}>\s?/;
// A row of a table, or the line under its header.
const TABLE = /^\s*\|.*\|\s*$|^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu;
const SAYABLE = /[\p{L}\p{N}]/u;
// Too long to be a name: a command line or a snippet, which nobody wants to hear.
const MAX_CODE_CHARS = 40;

// Code within a sentence: a name is said, a path by its last part, a long one not at all.
const code = (text: string): string => {
  const inner = text.trim();
  if (Array.from(inner).length > MAX_CODE_CHARS) return '';
  return /^[^\s]*\/[^\s]*$/.test(inner) ? (inner.split('/').filter(Boolean).at(-1) ?? '') : inner;
};

// One line as a voice would read it: no markup, no addresses, no pictures.
const inline = (line: string): string =>
  line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?\bhttps?:\/\/[^\s>)]+>?/g, '')
    .replace(/(`+)(.+?)\1/g, (_, _ticks: string, inner: string) => code(inner))
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}*_])([*_])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}])/gu, '$2')
    .replace(/<[^>\s][^>]*>/g, '')
    .replace(EMOJI, '')
    .replace(/[ \t]+/g, ' ')
    // What was taken out may leave a gap before the stop.
    .replace(/ +(?=[。、！？])/g, '')
    .trim();

// Lines of one paragraph read as one: with a space between words, with none where
// the script uses none (Japanese, Chinese).
const joined = (lines: ReadonlyArray<string>): string =>
  lines.reduce((whole, line) => {
    if (!whole) return line;
    const spaced =
      /[\p{sc=Latin}\p{sc=Hangul}\p{N}.,:;!?)]$/u.test(whole) || /^[\p{sc=Latin}\p{sc=Hangul}\p{N}(]/u.test(line);
    return `${whole}${spaced ? ' ' : ''}${line}`;
  }, '');

// Items of a list are sentences of their own.
const ended = (text: string): string => (/[。．.!?！？:：、,]$/.test(text) ? text : `${text}${STOP_AFTER(text)}`);
const STOP_AFTER = (text: string): string => (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u.test(text) ? '。' : '.');

// The reply's parts in order: a heading, a paragraph, a whole list. Code blocks,
// tables and rules are left out, and so is whatever has nothing to say.
export const partsOf = (markdown: string): string[] => {
  const parts: string[] = [];
  let lines: string[] = [];
  let list = false;
  let fence: string | null = null;
  const close = () => {
    const text = list ? lines.map(ended).join(' ') : joined(lines);
    if (SAYABLE.test(text)) parts.push(text);
    lines = [];
    list = false;
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenced = raw.match(FENCE)?.[1];
    if (fence) {
      // Closed by the same mark, at least as long. One never closed runs to the end.
      if (fenced && fenced[0] === fence[0] && fenced.length >= fence.length && raw.trim() === fenced) fence = null;
      continue;
    }
    if (fenced) {
      close();
      fence = fenced;
      continue;
    }
    const line = raw.replace(QUOTE, '');
    if (!line.trim() || RULE.test(line) || TABLE.test(line)) {
      close();
      continue;
    }
    if (HEADING.test(line)) {
      close();
      lines.push(inline(line.replace(HEADING, '').replace(/\s+#+\s*$/, '')));
      close();
      continue;
    }
    const item = ITEM.test(line);
    // A list starts a part of its own, and so does the paragraph after it.
    if (item !== list && (item || !/^\s/.test(line))) close();
    const text = inline(item ? line.replace(ITEM, '') : line);
    if (!text) continue;
    if (item) list = true;
    // An item's next line belongs to it.
    if (list && !item && lines.length) lines[lines.length - 1] = joined([lines[lines.length - 1], text]);
    else lines.push(text);
  }
  close();
  return parts;
};

const SENTENCE_END = /[。．！？!?]|\.(?=\s|$)/gu;

// The longest start of `text` that fits and ends with a sentence, or '' when not even
// its first sentence fits.
const sentencesWithin = (text: string, max: number): string => {
  let end = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const until = match.index + match[0].length;
    if (Array.from(text.slice(0, until)).length > max) break;
    end = until;
  }
  return text.slice(0, end).trim();
};

// What is said: the parts the judge would say, in order, up to `maxChars` in all.
// The part that goes over is cut at a sentence, and nothing after it is said.
export const chosen = (
  parts: ReadonlyArray<string>,
  probabilities: ReadonlyArray<number>,
  threshold: number,
  maxChars: number,
): string[] => {
  const said: string[] = [];
  let left = maxChars;
  for (const [index, part] of parts.entries()) {
    if (!((probabilities[index] ?? 0) >= threshold)) continue;
    const length = Array.from(part).length;
    if (length <= left) {
      said.push(part);
      left -= length;
      continue;
    }
    const start = sentencesWithin(part, left);
    if (start) said.push(start);
    break;
  }
  return said;
};

// How the voice sounds for each kind of reply: a cue in brackets before the text, as
// Fish Audio's S2 models read them. A kind without one is said plainly.
const TONE: Partial<Record<Mood, string>> = {
  done: 'cheerful',
  failed: 'disappointed',
  asking: 'curious',
  sorry: 'apologetic',
  greeting: 'friendly',
};

export const toned = (text: string, mood: Mood | null): string => {
  const cue = mood ? TONE[mood] : undefined;
  return cue ? `[${cue}] ${text}` : text;
};

// The questions put to the judge about a reply's parts: one for each, by name.
const name = (index: number): string => `p${index + 1}`;
export const SPEECH = {
  name,
  state: (parts: ReadonlyArray<string>) => ({
    context:
      'An AI coding assistant ends its turn with a message to the developer. A tiny pixel-art pet on the desktop reads some of its parts aloud, so the developer can follow without looking at the screen.',
    parts: Object.fromEntries(parts.map((part, index) => [name(index), part])),
  }),
  questions: (parts: ReadonlyArray<string>) =>
    Object.fromEntries(
      parts.map((_, index) => [
        name(index),
        {
          type: 'boolean',
          instructions: `Should part ${name(index)} be read aloud?`,
          criteria: {
            true: 'a conclusion, a result, a question to the developer, a decision they must make, or what happens next: natural to hear and enough to act on',
            false:
              'detail better read than heard: a bare heading, lists of files, code, commands, logs, numbers, long enumerations, or something an earlier part already said',
          },
        },
      ]),
    ),
} as const;
