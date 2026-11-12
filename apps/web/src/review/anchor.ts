import type { DiffFile, ReviewDiscussion, ReviewPosition } from '@relay/shared';
import type { DiffLine, Hunk } from './parseDiff';

/**
 * Where comments sit in a diff. GitLab positions: an added line has `new_line` only, a removed line `old_line` only,
 * a context line both. A thread is drawn under the line with the same key.
 */

export type LineKey = `n${number}` | `o${number}`;

export function lineKey(l: DiffLine): LineKey {
  return l.kind === 'del' ? `o${l.oldNo!}` : `n${l.newNo!}`;
}

export function positionKey(p: Pick<ReviewPosition, 'newLine' | 'oldLine'>): LineKey | null {
  if (p.newLine !== null) return `n${p.newLine}`;
  if (p.oldLine !== null) return `o${p.oldLine}`;
  return null;
}

/** The position to send for a new comment on `l` of `file`. */
export function positionFor(file: Pick<DiffFile, 'path' | 'oldPath'>, l: DiffLine): ReviewPosition {
  return {
    path: file.path,
    oldPath: file.oldPath ?? file.path,
    newLine: l.kind === 'del' ? null : l.newNo,
    oldLine: l.kind === 'add' ? null : l.oldNo,
  };
}

export interface FileThreads {
  /** Threads on a line that is visible in the diff. */
  byLine: Map<LineKey, ReviewDiscussion[]>;
  /** Threads on this file whose line is not in the diff any more (outdated, or outside the hunks). */
  outdated: ReviewDiscussion[];
  count: number;
  unresolved: number;
}

const empty = (): FileThreads => ({ byLine: new Map(), outdated: [], count: 0, unresolved: 0 });

/**
 * Groups positioned discussions by file and line. `general` = threads with no position, or on a file that is not in
 * the diff. A thread is outdated when GitLab left it on an older version (`position.headSha` differs from the head
 * shown), or when its line is not in this diff: a line number alone would land it on unrelated code.
 */
export function groupThreads(
  discussions: readonly ReviewDiscussion[],
  files: readonly { file: DiffFile; hunks: readonly Hunk[] }[],
  headSha: string | null = null,
): { byFile: Map<string, FileThreads>; general: ReviewDiscussion[] } {
  const byFile = new Map<string, FileThreads>();
  const keysOf = new Map<string, Set<LineKey>>();
  const pathIndex = new Map<string, string>();
  for (const { file, hunks } of files) {
    byFile.set(file.path, empty());
    pathIndex.set(file.path, file.path);
    if (file.oldPath) pathIndex.set(file.oldPath, file.path);
    const keys = new Set<LineKey>();
    for (const h of hunks) for (const l of h.lines) keys.add(lineKey(l));
    keysOf.set(file.path, keys);
  }
  const general: ReviewDiscussion[] = [];
  for (const d of discussions) {
    const p = d.position;
    const path = p ? (pathIndex.get(p.path) ?? pathIndex.get(p.oldPath)) : undefined;
    if (!p || !path) {
      general.push(d);
      continue;
    }
    const ft = byFile.get(path)!;
    ft.count++;
    if (d.resolvable && !d.resolved) ft.unresolved++;
    const key = positionKey(p);
    const stale =
      headSha !== null && p.headSha != null && p.headSha.toLowerCase() !== headSha.toLowerCase();
    if (key && !stale && keysOf.get(path)!.has(key)) {
      const list = ft.byLine.get(key);
      if (list) list.push(d);
      else ft.byLine.set(key, [d]);
    } else {
      ft.outdated.push(d);
    }
  }
  return { byFile, general };
}
