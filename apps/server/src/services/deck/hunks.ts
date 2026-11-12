import type { DeckHunk, DiffFile, HunkTier } from '@relay/shared';

/**
 * Hunk splitting + heuristic triage for the Review Deck. Pure.
 * Heuristics catch what never needs an AI call (generated files, lockfiles, import-only / whitespace-only hunks);
 * AI triage (when available) refines the rest into normal / critical.
 */

const HUNK_HEAD_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** Generated / vendored / lock files: always trivial. */
export const GENERATED_RE =
  /(?:\.g\.dart|\.freezed\.dart|\.gr\.dart|\.config\.dart|\.mocks\.dart|\.pb\.dart|pubspec\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Podfile\.lock|\.min\.(?:js|css)|GeneratedPluginRegistrant\.\w+|\.pbxproj)$/;

const IMPORT_RE = /^\s*(?:import\s|export\s.+\sfrom\s|part\s|library\s|using\s|package\s|#include)/;

export interface SplitHunk {
  id: string;
  file: string;
  fileIndex: number;
  hunkIndex: number;
  header: string;
  text: string;
  adds: number;
  dels: number;
}

export function splitHunks(files: readonly DiffFile[]): SplitHunk[] {
  const out: SplitHunk[] = [];
  files.forEach((f, fileIndex) => {
    if (!f.diff) return;
    const lines = f.diff.split('\n');
    let cur: string[] | null = null;
    let hunkIndex = 0;
    const flush = () => {
      if (!cur || cur.length === 0) return;
      const body = cur.slice(1);
      out.push({
        id: `${fileIndex}:${hunkIndex}`,
        file: f.path,
        fileIndex,
        hunkIndex,
        header: cur[0]!,
        text: cur.join('\n'),
        adds: body.filter((l) => l.startsWith('+')).length,
        dels: body.filter((l) => l.startsWith('-')).length,
      });
      hunkIndex++;
    };
    for (const l of lines) {
      if (HUNK_HEAD_RE.test(l)) {
        flush();
        cur = [l];
      } else if (cur) cur.push(l);
    }
    flush();
  });
  return out;
}

/** Heuristic tier + reason + group; null = "ask the AI / default normal". */
export function heuristicTier(
  h: Pick<SplitHunk, 'file' | 'text'>,
): { tier: HunkTier; reason: string; group: string } | null {
  if (GENERATED_RE.test(h.file)) {
    return { tier: 'trivial', reason: 'File generated / lockfile.', group: 'generated' };
  }
  const body = h.text.split('\n').slice(1);
  const minus = body.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
  const plus = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
  const changed = [...minus, ...plus];
  if (changed.length === 0)
    return { tier: 'trivial', reason: 'No lines changed.', group: 'format' };
  if (changed.every((l) => l.trim() === '')) {
    return { tier: 'trivial', reason: 'Hanya baris kosong.', group: 'import/format' };
  }
  if (changed.every((l) => l.trim() === '' || IMPORT_RE.test(l))) {
    return { tier: 'trivial', reason: 'Hanya import / export.', group: 'import/format' };
  }
  // Same tokens, only whitespace moved (formatter run).
  const norm = (xs: string[]) => xs.join('').replace(/\s+/g, '');
  if (minus.length > 0 && plus.length > 0 && norm(minus) === norm(plus)) {
    return { tier: 'trivial', reason: 'Formatting/whitespace only.', group: 'import/format' };
  }
  return null;
}

/** Applies heuristics; `ai` (by id) refines the hunks heuristics left open. */
export function tierHunks(
  hunks: readonly SplitHunk[],
  ai: ReadonlyMap<string, { tier: HunkTier; reason: string; group: string }> | null,
): DeckHunk[] {
  return hunks.map((h) => {
    const t = heuristicTier(h) ??
      ai?.get(h.id) ?? {
        tier: 'normal' as const,
        reason: 'Not triaged by AI yet.',
        group: 'logic',
      };
    return { ...h, ...t };
  });
}
