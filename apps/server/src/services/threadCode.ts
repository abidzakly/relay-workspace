import type { DiffFile, ReviewPosition, ThreadCode, ThreadCodeLine } from '@relay/shared';

/**
 * The code a diff thread was left on, cut from the MR's current diff (what GitLab shows above a diff thread).
 * A multi-line selection (`line_range`) shows exactly the selected lines; a single-line comment shows that line plus
 * a few lines of lead-in from the same hunk. Pure.
 */

/** Lines shown above a single-line comment (same hunk only). */
const LEAD_IN = 3;
/** A huge selection is cut to its last lines (the commented line is always the last one). */
const MAX_LINES = 60;
const LINE_TEXT_MAX = 1_000;

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Unified diff text → hunks of numbered lines. */
export function diffHunks(text: string): ThreadCodeLine[][] {
  const hunks: ThreadCodeLine[][] = [];
  let cur: ThreadCodeLine[] | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const h = HUNK_RE.exec(raw);
    if (h) {
      cur = [];
      hunks.push(cur);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!cur) continue;
    const c = raw[0];
    if (c === '\\') continue;
    const text = (c === '+' || c === '-' || c === ' ' ? raw.slice(1) : raw).slice(0, LINE_TEXT_MAX);
    if (c === '+') cur.push({ kind: 'add', oldNo: null, newNo: newNo++ || null, text });
    else if (c === '-') cur.push({ kind: 'del', oldNo: oldNo++ || null, newNo: null, text });
    else cur.push({ kind: 'ctx', oldNo: oldNo++ || null, newNo: newNo++ || null, text });
  }
  return hunks;
}

/** GitLab: added line = new only, removed line = old only, context line = both (match on the new side). */
function matches(
  l: ThreadCodeLine,
  p: { newLine: number | null; oldLine: number | null },
): boolean {
  if (p.newLine !== null) return l.kind !== 'del' && l.newNo === p.newLine;
  if (p.oldLine !== null) return l.kind === 'del' && l.oldNo === p.oldLine;
  return false;
}

export function threadCode(
  pos: ReviewPosition,
  files: readonly DiffFile[] | null,
  cache: Map<string, ThreadCodeLine[][]> = new Map(),
): ThreadCode {
  const out: ThreadCode = {
    path: pos.path,
    oldPath: pos.oldPath !== pos.path ? pos.oldPath : null,
    newLine: pos.newLine,
    oldLine: pos.oldLine,
    lines: [],
  };
  const file = files?.find(
    (f) => f.path === pos.path || f.oldPath === pos.oldPath || f.path === pos.oldPath,
  );
  if (!file?.diff) return out;
  let hunks = cache.get(file.path);
  if (!hunks) {
    hunks = diffHunks(file.diff);
    cache.set(file.path, hunks);
  }
  for (const hunk of hunks) {
    const end = hunk.findIndex((l) => matches(l, pos));
    if (end < 0) continue;
    let start = Math.max(0, end - LEAD_IN);
    if (pos.rangeStart) {
      const s = hunk.findIndex((l) => matches(l, pos.rangeStart!));
      // A range that crosses hunks (or is unreadable) falls back to the line itself.
      start = s >= 0 && s <= end ? s : end;
    }
    start = Math.max(start, end - MAX_LINES + 1);
    out.lines = hunk.slice(start, end + 1);
    return out;
  }
  return out;
}
