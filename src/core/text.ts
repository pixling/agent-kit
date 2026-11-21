// Strings shown on the resident, and the wording handed to the agent.
import type { Language } from './config.ts';

interface Strings {
  permissionQuestion: (tool: string) => string;
  permissionDetail: string;
  allow: string;
  deny: string;
  denyNote: string;
  typed: string;
  partHidden: (hidden: number, total: number) => string;
  undelivered: string;
}

const STRINGS: Record<Language, Strings> = {
  en: {
    permissionQuestion: (tool) => `Allow ${tool}?`,
    permissionDetail: 'The agent is waiting for your permission to run this:',
    allow: 'Allow',
    deny: 'Deny',
    denyNote: 'Type a reason to deny and tell the agent what to do instead.',
    typed: 'Deny and say',
    partHidden: (hidden, total) =>
      `${hidden} of its ${total} characters are not shown. Read all of it in the terminal before allowing it.`,
    undelivered: 'Your message has not reached the agent yet. It will keep trying.',
  },
  ja: {
    permissionQuestion: (tool) => `${tool} を実行していい？`,
    permissionDetail: 'エージェントが、これを実行する許可を待っています。',
    allow: '許可',
    deny: '拒否',
    denyNote: '理由を書くと拒否して、かわりにどうするかを伝えます。',
    typed: '拒否して伝える',
    partHidden: (hidden, total) =>
      `全 ${total} 文字のうち ${hidden} 文字は表示していません。許可する前に、ターミナルで全文を確認してください。`,
    undelivered: 'メッセージはまだエージェントに届いていません。届くまで送り直します。',
  },
  'zh-Hant': {
    permissionQuestion: (tool) => `允許執行 ${tool} 嗎？`,
    permissionDetail: '代理正在等你允許執行這項操作：',
    allow: '允許',
    deny: '拒絕',
    denyNote: '寫下理由來拒絕，並告訴代理改做什麼。',
    typed: '拒絕並說明',
    partHidden: (hidden, total) => `全部 ${total} 個字中有 ${hidden} 個字未顯示。允許前請先在終端機確認完整內容。`,
    undelivered: '你的訊息還沒送到代理那裡。會繼續嘗試傳送。',
  },
  ko: {
    permissionQuestion: (tool) => `${tool} 실행을 허용할까요?`,
    permissionDetail: '에이전트가 이걸 실행할 권한을 기다리고 있어요:',
    allow: '허용',
    deny: '거부',
    denyNote: '이유를 쓰면 거부하고, 대신 어떻게 할지 에이전트에게 전해요.',
    typed: '거부하고 전하기',
    partHidden: (hidden, total) =>
      `전체 ${total}자 중 ${hidden}자는 보이지 않아요. 허용하기 전에 터미널에서 전체 내용을 확인해 주세요.`,
    undelivered: '메시지가 아직 에이전트에게 닿지 않았어요. 닿을 때까지 다시 보낼게요.',
  },
};

export function strings(language: string): Strings {
  return STRINGS[language as Language] || STRINGS.en;
}

// Cuts by code points so a surrogate pair is never split.
export function clip(text: string, max: number, suffix = '…'): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - Array.from(suffix).length)).join('') + suffix;
}

// What reaches the agent from the inbox: a message the user typed, or a late answer to
// one of its questions. A late answer stays unread for the agent to read itself:
// the host frames a wake as no user input, so only the agent's own read of the desk
// tells it that the user answered.
export type Relayed = string | { readonly answerTo: string };

// What the agent reads when the user writes to the resident or answers late. It says a
// typed message has already arrived and how the reply gets back, or the agent goes
// looking for an inbox it has nothing to read in, and for a tool to answer with.
export function userMessageForAgent(
  items: ReadonlyArray<Relayed>,
  session: { readonly selector: string; readonly namespace: string; readonly key: string },
): string {
  const body = items
    .flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
    .join('\n\n---\n\n');
  const answers = items.flatMap((item) => (typeof item === 'string' ? [] : [item.answerTo]));
  return [
    ...(body
      ? [
          `The user wrote to you through their Pixling resident (\`${session.selector}\`):`,
          body,
          '(These are all the messages they typed. Answer as you normally would: what you write shows on the resident by itself, with no tool needed.)',
        ]
      : []),
    ...answers.map(
      (promptID) =>
        `The user answered your question \`${promptID}\` on your Pixling resident. The answer waits unread in its inbox: read it with \`pixling_inbox_read\` (namespace \`${session.namespace}\`, key \`${session.key}\`, messageID \`${promptID}\`) or \`pixling --json inbox read --namespace ${session.namespace} --key ${session.key} ${promptID}\`. If that promptID is a question you asked, the entry is the user's answer: act on it as if your question call had returned it.`,
    ),
  ].join('\n\n');
}

// How much of a tool call a permission card shows: the start, the end, and how much
// is left out between them.
const CARD_MAX_CHARS = 3000;
const CARD_TAIL_CHARS = 1000;
const LONG_BLANK = /\s{40,}/g;
const LONG_BACKTICKS = /`{8,}/g;
// Control and format characters: they can overwrite, reorder or hide what is around them.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const visible = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(INVISIBLE, (c) => (c === '\n' || c === '\t' ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`))
    .replace(LONG_BLANK, (run) => `[blank × ${Array.from(run).length}]`)
    .replace(LONG_BACKTICKS, (run) => `[\` × ${run.length}]`);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];

// What the tool call would do, all of it: a card's "allow" allows the whole call.
const toolText = (input: unknown): string => {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const o = input as Record<string, unknown>;
  const command = stringList(o.command ?? o.cmd);
  if (command.length) return [...command, ...stringList(o.args)].join(' ');
  const file = o.file_path ?? o.filePath ?? o.path;
  if (typeof file === 'string') {
    const changes = [o.content, o.old_string, o.new_string].filter((part) => typeof part === 'string');
    return [file, ...changes].join('\n\n');
  }
  return JSON.stringify(input, null, 2) ?? '';
};

// A tool call in words the user can check before allowing it. Nothing in the call can
// push the rest of it out of sight or break out of its code block.
export function permissionDetail(s: Strings, input: unknown): string {
  const chars = Array.from(visible(toolText(input)));
  const hidden = Math.max(0, chars.length - CARD_MAX_CHARS);
  const shown = hidden
    ? [
        chars.slice(0, CARD_MAX_CHARS - CARD_TAIL_CHARS).join(''),
        `[… ${hidden} …]`,
        chars.slice(-CARD_TAIL_CHARS).join(''),
      ].join('\n')
    : chars.join('');
  const fence = '`'.repeat(Math.max(3, ...(shown.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return [
    s.permissionDetail,
    `${fence}\n${shown}\n${fence}`,
    ...(hidden ? [s.partHidden(hidden, chars.length)] : []),
  ].join('\n\n');
}

// What a hook tells the agent once its resident is bound.
export function boundContext(session: { selector: string; namespace: string; key: string }): string {
  return [
    `A Pixling resident is bound to this session as \`${session.selector}\`` +
      ` (namespace \`${session.namespace}\`, key \`${session.key}\`).`,
    'The pixling-proxy plugin already shows what you write (as you go and at the end of each turn) on it and relays what the user writes there.',
    'If you use the pixling skills, use this same pair; do not bind another resident.',
  ].join(' ');
}
