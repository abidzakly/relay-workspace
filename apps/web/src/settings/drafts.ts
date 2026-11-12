import { useState } from 'react';

/** Flat string/boolean form drafts: easy to compare for "unsaved changes" and to reset via `key`. */
export function useDraft<T extends Record<string, string | boolean>>(initial: T) {
  const [draft, setDraft] = useState<T>(initial);
  const set = <K extends keyof T>(k: K, v: T[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  return { draft, set, dirty };
}

/** Empty / whitespace-only input -> undefined (optional field omitted). */
export function opt(s: string): string | undefined {
  const t = s.trim();
  return t === '' ? undefined : t;
}

/** Comma or newline separated list -> trimmed, non-empty, de-duplicated (order kept). */
export function splitList(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[\n,]/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
