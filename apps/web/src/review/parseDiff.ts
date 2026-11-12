/**
 * Unified diff (GitLab style: hunks only, sometimes with `---`/`+++` headers) → hunks with old/new line numbers.
 * Pure; unit-tested in `review.test.ts`.
 */

export type LineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** The line is followed by `\ No newline at end of file`. */
  noNewline: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the second `@@` (git's function-context hint), trimmed. */
  section: string;
  lines: DiffLine[];
  /** Unchanged lines hidden between the previous hunk (or the top of the file) and this one. */
  hiddenBefore: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split('\n');
  // A trailing newline produces one empty string that is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const h = HUNK_RE.exec(raw);
    if (h) {
      const oldStart = Number(h[1]);
      const newStart = Number(h[3]);
      const prev = hunks[hunks.length - 1];
      const prevEnd = prev ? prev.oldStart + prev.oldCount : 1;
      cur = {
        oldStart,
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart,
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        section: (h[5] ?? '').trim(),
        lines: [],
        hiddenBefore: Math.max(0, (oldStart === 0 ? 1 : oldStart) - prevEnd),
      };
      hunks.push(cur);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (!cur) continue; // headers before the first hunk (`diff --git`, `---`, `+++`, `index …`)
    const c = raw[0];
    if (c === '\\') {
      const last = cur.lines[cur.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (c === '+') {
      cur.lines.push({
        kind: 'add',
        oldNo: null,
        newNo: newNo++,
        text: raw.slice(1),
        noNewline: false,
      });
    } else if (c === '-') {
      cur.lines.push({
        kind: 'del',
        oldNo: oldNo++,
        newNo: null,
        text: raw.slice(1),
        noNewline: false,
      });
    } else {
      // ' ' context; tolerate a bare empty line (some tools strip the leading space).
      cur.lines.push({
        kind: 'ctx',
        oldNo: oldNo++,
        newNo: newNo++,
        text: c === ' ' ? raw.slice(1) : raw,
        noNewline: false,
      });
    }
  }
  return hunks;
}

/** One row of the side-by-side view. A changed block pairs its removals with its additions, line by line. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === 'ctx') {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(lines[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/**
 * For the inline view: the removal paired with each addition (and vice versa) inside one changed block, so both can
 * show word-level highlights. Keyed by the line object.
 */
export function pairChanges(lines: readonly DiffLine[]): Map<DiffLine, DiffLine> {
  const pairs = new Map<DiffLine, DiffLine>();
  for (const r of splitRows(lines)) {
    if (r.left && r.right && r.left !== r.right) {
      pairs.set(r.left, r.right);
      pairs.set(r.right, r.left);
    }
  }
  return pairs;
}

/** Old and new sides of a file's hunks as text, for syntax highlighting. Index → line object. */
export function sides(hunks: readonly Hunk[]): {
  oldText: string;
  newText: string;
  oldLines: DiffLine[];
  newLines: DiffLine[];
} {
  const oldLines: DiffLine[] = [];
  const newLines: DiffLine[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind !== 'add') oldLines.push(l);
      if (l.kind !== 'del') newLines.push(l);
    }
  }
  return {
    oldText: oldLines.map((l) => l.text).join('\n'),
    newText: newLines.map((l) => l.text).join('\n'),
    oldLines,
    newLines,
  };
}
