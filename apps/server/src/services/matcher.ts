import type { LinkOutcome, LinkSuggestion, MatchBy, MismatchReason, MrState } from '@relay/shared';
import { normalizeNotionId } from './notionUrl';
import { isVersionMr } from './versionMr';

/**
 * Card <-> MR matcher. PURE: no DB, no I/O, deterministic. Input is plain data; the result
 * says which links to persist and what to show. Nothing here ever resolves a conflict.
 *
 * Keys per MR:
 *   title key        `mr.title.trim() === card.branchName.trim()` (exact, case-sensitive). For a DRAFT MR the
 *                    GitLab draft prefix (`Draft:`, `[Draft]`, `(Draft)`, `WIP:`, `[WIP]`) is ignored first.
 *   description key  Notion page id extracted from the MR description at sync time (`Mr.descriptionNotionId`).
 *
 * Anything beyond these keys is a design decision of this app.
 */

export interface MatchCard {
  id: string;
  branchName: string | null;
  archived: boolean;
}

export interface MatchMr {
  repoId: string;
  iid: number;
  title: string;
  sourceBranch: string;
  state: MrState;
  draft: boolean;
  descriptionNotionId: string | null;
}

/** A user-confirmed link (`links.match_by = 'manual'`). Authoritative for its MR. */
export interface ManualLinkInput {
  cardId: string;
  repoId: string;
  mrIid: number;
}

export interface MatchInput {
  cards: readonly MatchCard[];
  mrs: readonly MatchMr[];
  manualLinks?: readonly ManualLinkInput[];
  /** `versionBranchPrefix` per repo id (version-update MRs are excluded). Unknown repo = nothing excluded. */
  versionBranchPrefix: (repoId: string) => string | undefined;
}

export interface ProposedLink {
  cardId: string;
  repoId: string;
  mrIid: number;
  matchBy: MatchBy;
  conflict: boolean;
}

export interface MrMatch {
  repoId: string;
  mrIid: number;
  outcome: LinkOutcome;
  /** Closed MRs are history: they are linked, but never flagged `conflict` and ignored for duplicates. */
  live: boolean;
  /** Cards this MR is linked to (1 normally; >1 for a mismatch; 0 for an orphan). */
  cardIds: string[];
  /** Cards the title key hit (>1 = ambiguous). */
  titleCardIds: string[];
  /** Card the description key hit, if the id is a known, non-archived card. */
  descriptionCardId: string | null;
  /** Raw id found in the description (normalized), even when it is not a known card. */
  descriptionNotionId: string | null;
  /** Description holds a Notion id that is not a known card (spec page, unsynced or archived card). */
  descriptionUnresolved: boolean;
  mismatchReason?: MismatchReason;
  suggestion?: LinkSuggestion;
  /** For `duplicate`: the other live MRs on the same card(s). */
  duplicateOf?: { repoId: string; mrIid: number }[];
}

export interface CardDuplicate {
  cardId: string;
  mrs: { repoId: string; mrIid: number }[];
}

export interface MatchResult {
  links: ProposedLink[];
  /** One entry per non-version MR. */
  mrs: MrMatch[];
  /** Version-update MRs left out of matching (shown in the Release Train). */
  excluded: { repoId: string; mrIid: number }[];
  /** Cards (non-archived) with no MR at all. Whether that is a problem depends on status: Sync Health. */
  cardsWithoutMr: string[];
  duplicates: CardDuplicate[];
}

const DRAFT_PREFIX_RE = /^\s*(?:\[draft\]|\(draft\)|draft:|\[wip\]|wip:)\s*/i;

/** Title as compared against `card.branchName`. */
export function titleKey(mr: Pick<MatchMr, 'title' | 'draft'>): string {
  const t = mr.draft ? mr.title.replace(DRAFT_PREFIX_RE, '') : mr.title;
  return t.trim();
}

const mrKey = (repoId: string, iid: number) => `${repoId}\u0000${iid}`;
const idKey = (id: string) => normalizeNotionId(id) ?? id.toLowerCase();

interface Cand {
  cardId: string;
  title: boolean;
  description: boolean;
  manual: boolean;
}

export function matchCardsToMrs(input: MatchInput): MatchResult {
  const active = input.cards.filter((c) => !c.archived);
  const byId = new Map(active.map((c) => [idKey(c.id), c] as const));
  const byBranch = new Map<string, MatchCard[]>();
  for (const c of active) {
    const b = c.branchName?.trim();
    if (!b) continue;
    const list = byBranch.get(b);
    if (list) list.push(c);
    else byBranch.set(b, [c]);
  }
  const cardById = new Map(input.cards.map((c) => [c.id, c] as const));

  const manualByMr = new Map<string, string[]>();
  for (const m of input.manualLinks ?? []) {
    const k = mrKey(m.repoId, m.mrIid);
    const list = manualByMr.get(k);
    if (list) list.push(m.cardId);
    else manualByMr.set(k, [m.cardId]);
  }

  const sortedMrs = [...input.mrs].sort(
    (a, b) => a.repoId.localeCompare(b.repoId) || a.iid - b.iid,
  );

  const excluded: MatchResult['excluded'] = [];
  const matches: MrMatch[] = [];
  const candsByMr = new Map<string, Cand[]>();

  for (const mr of sortedMrs) {
    const prefix = input.versionBranchPrefix(mr.repoId);
    if (prefix !== undefined && isVersionMr(mr, prefix)) {
      excluded.push({ repoId: mr.repoId, mrIid: mr.iid });
      continue;
    }

    const live = mr.state !== 'closed';
    const descId = mr.descriptionNotionId ? idKey(mr.descriptionNotionId) : null;
    const key = mrKey(mr.repoId, mr.iid);
    const manual = manualByMr.get(key);

    const cands = new Map<string, Cand>();
    const add = (cardId: string, field: 'title' | 'description' | 'manual') => {
      const c = cands.get(cardId) ?? { cardId, title: false, description: false, manual: false };
      c[field] = true;
      cands.set(cardId, c);
    };

    let titleCards: MatchCard[] = [];
    let descCard: MatchCard | undefined;
    if (manual) {
      for (const id of manual) add(id, 'manual');
    } else {
      const tk = titleKey(mr);
      titleCards = tk ? (byBranch.get(tk) ?? []) : [];
      descCard = descId ? byId.get(descId) : undefined;
      for (const c of titleCards) add(c.id, 'title');
      if (descCard) add(descCard.id, 'description');
    }

    const cardIds = [...cands.keys()].sort();
    let outcome: LinkOutcome;
    let mismatchReason: MismatchReason | undefined;
    let suggestion: LinkSuggestion | undefined;

    if (cardIds.length === 0) {
      outcome = 'orphan';
    } else if (cardIds.length > 1) {
      outcome = 'mismatch';
      mismatchReason = titleCards.length > 1 ? 'ambiguous_title' : 'title_vs_description';
    } else {
      const c = cands.get(cardIds[0]!)!;
      if (c.manual) outcome = 'manual';
      else if (c.title && c.description) outcome = 'strong';
      else if (c.title) {
        outcome = 'weak_title';
        suggestion = 'add_description_link';
      } else {
        outcome = 'weak_description';
        if (cardById.get(c.cardId)?.branchName?.trim()) suggestion = 'rename_title_to_branch';
      }
    }

    candsByMr.set(
      key,
      [...cands.values()].sort((a, b) => a.cardId.localeCompare(b.cardId)),
    );
    matches.push({
      repoId: mr.repoId,
      mrIid: mr.iid,
      outcome,
      live,
      cardIds,
      titleCardIds: titleCards.map((c) => c.id).sort(),
      descriptionCardId: descCard?.id ?? null,
      descriptionNotionId: descId,
      descriptionUnresolved: !manual && descId !== null && !descCard,
      ...(mismatchReason ? { mismatchReason } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }

  // Duplicates: a card with >1 LIVE (non-closed) MR. Mismatched MRs count toward each card they point at.
  const liveByCard = new Map<string, MrMatch[]>();
  for (const m of matches) {
    if (!m.live) continue;
    for (const cardId of m.cardIds) {
      const list = liveByCard.get(cardId);
      if (list) list.push(m);
      else liveByCard.set(cardId, [m]);
    }
  }
  const duplicates: CardDuplicate[] = [];
  for (const [cardId, list] of [...liveByCard].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length < 2) continue;
    duplicates.push({
      cardId,
      mrs: list.map((m) => ({ repoId: m.repoId, mrIid: m.mrIid })),
    });
    for (const m of list) {
      if (m.outcome !== 'mismatch') m.outcome = 'duplicate';
      const others = list.filter((o) => o !== m).map((o) => ({ repoId: o.repoId, mrIid: o.mrIid }));
      m.duplicateOf = [...(m.duplicateOf ?? []), ...others];
    }
  }

  const links: ProposedLink[] = [];
  const linkedCards = new Set<string>();
  for (const m of matches) {
    const conflict = m.live && (m.outcome === 'mismatch' || m.outcome === 'duplicate');
    for (const c of candsByMr.get(mrKey(m.repoId, m.mrIid)) ?? []) {
      linkedCards.add(c.cardId);
      const matchBy: MatchBy = c.manual
        ? 'manual'
        : c.title && c.description
          ? 'both'
          : c.title
            ? 'title'
            : 'description';
      links.push({ cardId: c.cardId, repoId: m.repoId, mrIid: m.mrIid, matchBy, conflict });
    }
  }

  const cardsWithoutMr = active
    .filter((c) => !linkedCards.has(c.id))
    .map((c) => c.id)
    .sort();

  return { links, mrs: matches, excluded, cardsWithoutMr, duplicates };
}
