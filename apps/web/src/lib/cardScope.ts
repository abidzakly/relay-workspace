import type { StateCard, StateMr } from '@relay/shared';
import type { CardMonth } from '@/store/ui';

/** `YYYY-MM` of a local date, the same local-time month the server's KPI uses. */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The concrete month a selection means; null = no month filter. */
export function resolveMonth(month: CardMonth, now: Date = new Date()): string | null {
  if (month === 'all') return null;
  return month === 'current' ? monthKey(now) : month;
}

/**
 * Cards the card views show: only mine (the Assignee property matches my names, the KPI set). A month filter keeps
 * cards whose KPI month is that month; a card with no month (no assigned-at yet) only shows under "All months".
 */
export function visibleCards<C extends StateCard>(
  cards: readonly C[],
  month: CardMonth,
  now: Date = new Date(),
): C[] {
  const m = resolveMonth(month, now);
  return cards.filter((c) => c.mine && (m === null || c.month === m));
}

/**
 * Cards of the repos switched "On the board": the card's Product Domain maps to an enabled repo, or one of its
 * linked MRs lives in one. A card with no repo at all is left off. `enabled === null` (repos not loaded) keeps all.
 */
export function inEnabledRepos<C extends StateCard>(
  cards: readonly C[],
  enabled: ReadonlySet<string> | null,
  links: readonly { cardId: string; repoId: string }[] = [],
): C[] {
  if (enabled === null) return [...cards];
  const linked = new Map<string, string[]>();
  for (const l of links) {
    const k = cardKey(l.cardId);
    linked.set(k, [...(linked.get(k) ?? []), l.repoId]);
  }
  return cards.filter(
    (c) =>
      c.domainRepoIds.some((r) => enabled.has(r)) ||
      (linked.get(cardKey(c.id)) ?? []).some((r) => enabled.has(r)),
  );
}

const USER_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The Notion sync only runs with a Notion user id among the aliases (same test as the server). */
export function hasNotionUserId(aliases: readonly string[]): boolean {
  return aliases.some((a) => USER_ID_RE.test(a.trim()));
}

/** Months to offer, newest first: every month some card belongs to, plus the current one. */
export function monthOptions(cards: readonly StateCard[], now: Date = new Date()): string[] {
  const set = new Set<string>([monthKey(now)]);
  for (const c of cards) if (c.month) set.add(c.month);
  return [...set].sort().reverse();
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Notion ids come dashed or not. */
export const cardKey = (id: string): string => id.replace(/-/g, '').toLowerCase();
export const mrScopeKey = (repoId: string, iid: number): string => `${repoId}#${iid}`;

export interface MineSets {
  /** false = the snapshot has not loaded yet: nothing is hidden. */
  active: boolean;
  cards: ReadonlySet<string>;
  mrs: ReadonlySet<string>;
}

export function mineSets(
  state: { cards: readonly StateCard[]; mrs: readonly StateMr[] } | undefined,
): MineSets {
  return {
    active: state !== undefined,
    cards: new Set((state?.cards ?? []).filter((c) => c.mine).map((c) => cardKey(c.id))),
    mrs: new Set((state?.mrs ?? []).filter((m) => m.mine).map((m) => mrScopeKey(m.repoId, m.iid))),
  };
}

/** A finding is mine when its card is mine, or, with no card, when its MR is mine. Findings with neither stay. */
export function verdictIsMine(
  v: { cardId?: string | null; repoId?: string | null; mrIid?: number | null },
  sets: MineSets,
): boolean {
  if (!sets.active) return true;
  if (v.cardId) return sets.cards.has(cardKey(v.cardId));
  if (v.repoId && v.mrIid) return sets.mrs.has(mrScopeKey(v.repoId, v.mrIid));
  return true;
}
