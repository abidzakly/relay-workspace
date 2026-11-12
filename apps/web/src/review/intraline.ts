import { diffWordsWithSpace } from 'diff';

/** [start, end) character ranges of a line that changed against its pair. */
export type Range = readonly [number, number];

const MAX_LEN = 600;
/** Past this share of changed characters the line is "rewritten": highlighting words would be noise. */
const MAX_CHANGED = 0.65;

/** Word-level changes between a removed line and its paired added line. Empty arrays = no useful highlight. */
export function intraline(oldText: string, newText: string): { old: Range[]; new: Range[] } {
  const none = { old: [], new: [] };
  if (oldText === newText || oldText.length > MAX_LEN || newText.length > MAX_LEN) return none;
  const parts = diffWordsWithSpace(oldText, newText);
  const oldR: [number, number][] = [];
  const newR: [number, number][] = [];
  let o = 0;
  let n = 0;
  let changed = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) {
      push(newR, n, n + len);
      n += len;
      changed += len;
    } else if (p.removed) {
      push(oldR, o, o + len);
      o += len;
      changed += len;
    } else {
      o += len;
      n += len;
    }
  }
  const total = oldText.length + newText.length;
  if (total === 0 || changed / total > MAX_CHANGED) return none;
  return { old: oldR, new: newR };
}

function push(r: [number, number][], s: number, e: number) {
  if (s === e) return;
  const last = r[r.length - 1];
  if (last && last[1] === s) last[1] = e;
  else r.push([s, e]);
}

export interface Token {
  content: string;
  /** Inline style (shiki colors), absent while highlighting loads. */
  style?: Record<string, string>;
}

export interface Segment extends Token {
  mark: boolean;
}

/** Cuts syntax tokens at the intraline range edges so both can be drawn at once. */
export function segments(tokens: readonly Token[], ranges: readonly Range[]): Segment[] {
  if (ranges.length === 0) return tokens.map((t) => ({ ...t, mark: false }));
  const out: Segment[] = [];
  let pos = 0;
  let ri = 0;
  for (const t of tokens) {
    let start = 0;
    const end = t.content.length;
    while (start < end) {
      while (ri < ranges.length && ranges[ri]![1] <= pos + start) ri++;
      const r = ranges[ri];
      const abs = pos + start;
      let cut: number;
      let mark: boolean;
      if (!r || abs < r[0]) {
        mark = false;
        cut = r ? Math.min(end, r[0] - pos) : end;
      } else {
        mark = true;
        cut = Math.min(end, r[1] - pos);
      }
      const piece = t.content.slice(start, cut);
      const last = out[out.length - 1];
      if (last && last.mark === mark && last.style === t.style) last.content += piece;
      else out.push({ content: piece, ...(t.style ? { style: t.style } : {}), mark });
      start = cut;
    }
    pos += end;
  }
  return out;
}
