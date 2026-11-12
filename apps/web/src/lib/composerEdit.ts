/**
 * Pure markdown edits for the comment composer's toolbar. Each takes the text and the selection and returns the
 * span to replace plus the selection to leave afterwards, so the caller can apply it with the browser's own undo.
 */

export interface Sel {
  start: number;
  end: number;
}

/** Replace `[from, to)` with `text`, then select `[selStart, selEnd)` (absolute, in the new text). */
export interface Edit {
  from: number;
  to: number;
  text: string;
  selStart: number;
  selEnd: number;
}

/** `**bold**`-style: wraps the selection, or a placeholder that is left selected. Toggles off when already wrapped. */
export function wrap(
  value: string,
  s: Sel,
  before: string,
  after: string,
  placeholder: string,
): Edit {
  const inner = value.slice(s.start, s.end);
  const outerStart = s.start - before.length;
  if (
    inner &&
    outerStart >= 0 &&
    value.slice(outerStart, s.start) === before &&
    value.slice(s.end, s.end + after.length) === after
  ) {
    return {
      from: outerStart,
      to: s.end + after.length,
      text: inner,
      selStart: outerStart,
      selEnd: outerStart + inner.length,
    };
  }
  const body = inner || placeholder;
  const start = s.start + before.length;
  return {
    from: s.start,
    to: s.end,
    text: `${before}${body}${after}`,
    selStart: start,
    selEnd: start + body.length,
  };
}

/** `[text](url)`: the selection becomes the text and `url` is left selected to type over. */
export function link(value: string, s: Sel): Edit {
  const text = value.slice(s.start, s.end) || 'text';
  const out = `[${text}](url)`;
  const urlStart = s.start + text.length + 3;
  return { from: s.start, to: s.end, text: out, selStart: urlStart, selEnd: urlStart + 3 };
}

function lineBounds(value: string, s: Sel): { from: number; to: number } {
  const from = value.lastIndexOf('\n', s.start - 1) + 1;
  const nl = value.indexOf('\n', s.end > s.start && value[s.end - 1] === '\n' ? s.end - 1 : s.end);
  return { from, to: nl === -1 ? value.length : nl };
}

/**
 * Prefix every selected line (`> `, `- `, `1. `, `- [ ] `). Toggles off when every line already has it. Numbered
 * lists count up from 1.
 */
export function prefixLines(value: string, s: Sel, prefix: string | ((i: number) => string)): Edit {
  const { from, to } = lineBounds(value, s);
  const lines = value.slice(from, to).split('\n');
  const pre = (i: number) => (typeof prefix === 'function' ? prefix(i) : prefix);
  const pattern = typeof prefix === 'function' ? /^\d+\. / : null;
  const has = (l: string, i: number) => (pattern ? pattern.test(l) : l.startsWith(pre(i)));
  const off = lines.every(has);
  const next = lines.map((l, i) =>
    off
      ? l.replace(pattern ?? pre(i), '')
      : `${pre(i)}${l.replace(/^(?:> |- \[[ x]\] |- |\d+\. )/, '')}`,
  );
  const text = next.join('\n');
  return { from, to, text, selStart: from + text.length, selEnd: from + text.length };
}

/**
 * A block (code fence, table, rule…) on its own lines with a blank line around it. `cursor` is the offset inside
 * `block` where the caret goes (or `[start, end]` to select a span of it).
 */
export function insertBlock(
  value: string,
  s: Sel,
  block: string,
  cursor: number | [number, number],
): Edit {
  const before = value.slice(0, s.start);
  const after = value.slice(s.end);
  const lead =
    before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail =
    after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const text = `${lead}${block}${trail}`;
  const base = s.start + lead.length;
  const [a, b] = typeof cursor === 'number' ? [cursor, cursor] : cursor;
  return { from: s.start, to: s.end, text, selStart: base + a, selEnd: base + b };
}

/** A code fence around the selection (or an empty one), with the caret inside. */
export function codeBlock(value: string, s: Sel, lang = ''): Edit {
  const inner = value.slice(s.start, s.end);
  const block = `\`\`\`${lang}\n${inner}\n\`\`\``;
  const at = 4 + lang.length;
  return insertBlock(value, s, block, inner ? [at, at + inner.length] : at);
}

export const TABLE_BLOCK =
  '| header | header |\n| ------ | ------ |\n|        |        |\n|        |        |';
export const DETAILS_BLOCK = '<details>\n<summary>Click to expand</summary>\n\n\n\n</details>';
export const MERMAID_BLOCK = '```mermaid\ngraph TD;\n  A-->B;\n  A-->C;\n```';
export const PLANTUML_BLOCK = '```plantuml\nAlice -> Bob: hello\nBob --> Alice: hi\n```';
export const TOC_BLOCK = '[[_TOC_]]';

/** `@ab` or `!12` right before the caret (after a space, line start or bracket), for the autocomplete. */
export function triggerAt(
  value: string,
  caret: number,
): { kind: '@' | '!'; query: string; from: number } | null {
  const m = /(^|[\s([])([@!])([\w.-]{0,40})$/.exec(value.slice(0, caret));
  if (!m) return null;
  const kind = m[2] as '@' | '!';
  if (kind === '!' && m[3] && !/^\d*$/.test(m[3])) return null;
  return { kind, query: m[3]!, from: caret - m[3]!.length - 1 };
}

/** A name GitLab and our proxy both accept: `[\w.() -]`, at most 120 characters, extension kept. */
export function safeFilename(name: string, type: string): string {
  const ext =
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type] ??
    'png';
  const base = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w.() -]+/g, '_')
    .replace(/^[ .]+/, '')
    .slice(0, 100);
  return `${base || `image-${Date.now()}`}.${ext}`;
}
