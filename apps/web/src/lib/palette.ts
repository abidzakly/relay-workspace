/** Search ranking of the command palette. Pure: no React, no DOM. */

export type PaletteKind = 'view' | 'action' | 'card' | 'mr' | 'write';

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  /** Secondary text on the row; searched like `keywords`. */
  hint: string;
  /** Searched, never shown. */
  keywords: string;
  /** Cards, MRs and their actions: too many to list, so they only appear for a query. */
  searchOnly: boolean;
  /** Small nudge among otherwise equal matches, such as a live MR over a merged one. */
  boost: number;
  /** This option is the one already in effect. */
  current: boolean;
  /** Shown on the row, as in the help overlay. */
  shortcut: string;
  /** Stay open after running, for an action whose result is shown in the palette. */
  keepOpen: boolean;
  run: () => void;
}

const SCORE_EXACT = 100;
const SCORE_PREFIX = 80;
const SCORE_WORD = 60;
const SCORE_SUBSTRING = 40;
const SCORE_FUZZY = 15;
const SCORE_FULL_LABEL = 50;
/** A match in secondary text counts for less than the same match in the label. */
const SECONDARY_WEIGHT = 0.6;
/** Fuzzy letters must sit this close together, or long titles would match nearly anything. */
const FUZZY_SPAN_FACTOR = 3;
const FUZZY_MIN_LENGTH = 3;

const KIND_ORDER: Record<PaletteKind, number> = { view: 0, action: 1, card: 2, mr: 3, write: 4 };

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function hasWordStart(token: string, text: string): boolean {
  let at = text.indexOf(token);
  while (at !== -1) {
    if (!isWordChar(text[at - 1])) return true;
    at = text.indexOf(token, at + 1);
  }
  return false;
}

/** The tightest window in `text` holding the letters of `token` in order, or null. */
function fuzzySpan(token: string, text: string): number | null {
  let best: number | null = null;
  for (let start = text.indexOf(token[0] ?? ''); start !== -1;) {
    let at = start;
    for (let i = 1; i < token.length && at !== -1; i++) {
      at = text.indexOf(token[i] ?? '', at + 1);
    }
    if (at === -1) break;
    const span = at - start + 1;
    if (best === null || span < best) best = span;
    start = text.indexOf(token[0] ?? '', start + 1);
  }
  return best;
}

/** How well one normalized query word matches one normalized text. 0 = no match. */
export function scoreToken(token: string, text: string): number {
  if (!token || !text) return 0;
  if (text === token) return SCORE_EXACT;
  if (text.startsWith(token)) return SCORE_PREFIX;
  if (hasWordStart(token, text)) return SCORE_WORD;
  if (text.includes(token)) return SCORE_SUBSTRING;
  if (token.length >= FUZZY_MIN_LENGTH) {
    const span = fuzzySpan(token, text);
    if (span !== null && span <= token.length * FUZZY_SPAN_FACTOR) return SCORE_FUZZY;
  }
  return 0;
}

/** Every word of the query must match somewhere, or the item is out. 0 = no match. */
export function scoreItem(query: string, item: PaletteItem): number {
  const normalized = normalize(query).trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const label = normalize(item.label);
  const secondary = normalize(`${item.hint} ${item.keywords}`);
  let total = 0;
  for (const token of tokens) {
    const score = Math.max(
      scoreToken(token, label),
      scoreToken(token, secondary) * SECONDARY_WEIGHT,
    );
    if (score === 0) return 0;
    total += score;
  }
  return total / tokens.length + (label === normalized ? SCORE_FULL_LABEL : 0) + item.boost;
}

/**
 * Best match first; ties go to views, then actions, cards, MRs and last the write actions, then the shorter label.
 * With no query: everything that is not `searchOnly`, in the given order.
 */
export function rankItems(
  items: readonly PaletteItem[],
  query: string,
  limit: number,
): PaletteItem[] {
  if (!query.trim()) return items.filter((item) => !item.searchOnly).slice(0, limit);
  return items
    .map((item) => ({ item, score: scoreItem(query, item) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
        a.item.label.length - b.item.label.length ||
        a.item.label.localeCompare(b.item.label),
    )
    .slice(0, limit)
    .map((row) => row.item);
}
