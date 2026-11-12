import {
  normalizeName,
  SEVERITIES,
  type Card,
  type DomainState,
  type FamilyTree,
  type Mr,
  type MrDerivedState,
  type ReleaseFact,
  type Severity,
  type Unruled,
  type Verdict,
} from '@relay/shared';
import { idKey, type FamilyResult } from './familyTree';
import type { MatchResult, MrMatch } from './matcher';
import {
  CANONICAL_STATUS,
  HEALTH_RULES,
  ruleCoversStatus,
  STATUS_ROLES,
  type HealthCtx,
  type HealthRule,
  type StatusRole,
} from './syncHealthRules';

/**
 * Sync Health engine: evaluates the rule table over the cache and returns verdicts with the Notion
 * status and the GitLab state side by side. PURE: no DB, no I/O, nothing is written anywhere.
 */

export interface HealthMr extends Mr {
  derivedState: Exclude<MrDerivedState, 'none'>;
  isVersionMr: boolean;
}

export interface HealthInput {
  now: number;
  /** Non-archived cards. */
  cards: readonly Card[];
  /** Every cached MR (version MRs included; they never match a card). */
  mrs: readonly HealthMr[];
  /** Result of `matchCardsToMrs` over the same data. */
  match: MatchResult;
  /** `notion.statuses` (configured spellings). */
  statuses: readonly string[];
  /** `notion.readyStatus`. */
  readyStatus: string;
  /** Workspace spellings of the Complete role (e.g. "Completed"). */
  completeAliases?: readonly string[];
  /** Product Domain → connected repo. Absent = every card `unknown` (no suppression). */
  domainOf?: (domain: string | null) => { state: DomainState; repoIds: string[] };
  release: ReadonlyMap<string, ReleaseFact>;
  families: FamilyResult;
}

export interface HealthResult {
  verdicts: Verdict[];
  unruled: Unruled[];
  /** Card id → its primary MR (newest live, else newest) — shared with the family tree / UI. */
  primaryMrOf: ReadonlyMap<string, HealthMr>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  action: 1,
  warn: 2,
  info: 3,
  ok: 4,
};

export const mrKey = (repoId: string, iid: number): string => `${repoId}#${iid}`;

/** Primary MR of a card: newest live (non-closed) one, else the newest closed one (display convention only). */
export function pickPrimaryMr<T extends { state: string; createdAt: number; iid: number }>(
  list: readonly T[],
): T | null {
  if (list.length === 0) return null;
  const newest = (xs: readonly T[]) =>
    [...xs].sort((a, b) => b.createdAt - a.createdAt || b.iid - a.iid)[0]!;
  const live = list.filter((m) => m.state !== 'closed');
  return newest(live.length > 0 ? live : list);
}

function gitlabLabel(state: MrDerivedState): string {
  switch (state) {
    case 'none':
      return 'no MR';
    case 'approved':
      return 'approved ✓';
    case 'merged':
      return 'merged ✓';
    case 'closed':
      return 'closed ✗';
    default:
      return state;
  }
}

/** Card id → its primary MR, from the matcher links. */
export function primaryMrsByCard<M extends Mr & { state: string }>(
  cards: readonly Card[],
  links: readonly { cardId: string; repoId: string; mrIid: number }[],
  mrs: readonly M[],
): Map<string, M> {
  const mrBy = new Map(mrs.map((m) => [mrKey(m.repoId, m.iid), m] as const));
  const byCard = new Map<string, M[]>();
  for (const l of links) {
    const mr = mrBy.get(mrKey(l.repoId, l.mrIid));
    if (!mr) continue;
    const k = idKey(l.cardId);
    const list = byCard.get(k);
    if (list) list.push(mr);
    else byCard.set(k, [mr]);
  }
  const out = new Map<string, M>();
  for (const c of cards) {
    const p = pickPrimaryMr(byCard.get(idKey(c.id)) ?? []);
    if (p) out.set(c.id, p);
  }
  return out;
}

export function evaluateHealth(input: HealthInput): HealthResult {
  const mrBy = new Map(input.mrs.map((m) => [mrKey(m.repoId, m.iid), m] as const));
  const matchBy = new Map<string, MrMatch>(
    input.match.mrs.map((m) => [mrKey(m.repoId, m.mrIid), m] as const),
  );
  const cardBy = new Map(input.cards.map((c) => [idKey(c.id), c] as const));

  const primaryMrOf = primaryMrsByCard(input.cards, input.match.links, input.mrs);

  const dupByCard = new Map(
    input.match.duplicates.map(
      (d) => [idKey(d.cardId), d.mrs.map((x) => ({ repoId: x.repoId, iid: x.mrIid }))] as const,
    ),
  );

  // status roles: canonical names, except Ready to Test which is configured; writes use the configured spelling.
  const roleByName = new Map<string, StatusRole>();
  const nameOfRole = new Map<StatusRole, string>();
  for (const r of STATUS_ROLES) {
    const canonical = r === 'readyToTest' ? input.readyStatus : CANONICAL_STATUS[r];
    const configured = input.statuses.find((s) => normalizeName(s) === normalizeName(canonical));
    roleByName.set(normalizeName(canonical), r);
    nameOfRole.set(r, configured ?? canonical);
  }
  for (const alias of input.completeAliases ?? []) {
    roleByName.set(normalizeName(alias), 'complete');
    const configured = input.statuses.find((s) => normalizeName(s) === normalizeName(alias));
    if (configured && !input.statuses.some((s) => normalizeName(s) === normalizeName('Complete'))) {
      nameOfRole.set('complete', configured);
    }
  }

  const ctx: HealthCtx = {
    now: input.now,
    roleOf: (card) => (card.status ? (roleByName.get(normalizeName(card.status)) ?? null) : null),
    statusName: (r) => nameOfRole.get(r)!,
    mrStateOf: (mr) => (mr ? (mrBy.get(mrKey(mr.repoId, mr.iid))?.derivedState ?? 'open') : 'none'),
    releaseOf: (mr) => (mr ? input.release.get(mrKey(mr.repoId, mr.iid)) : undefined),
    domainOf: (card) =>
      input.domainOf ? input.domainOf(card.productDomain ?? null).state : 'unknown',
    familyOf: (card): FamilyTree | undefined => input.families.byParent.get(idKey(card.id)),
    duplicatesOf: (card) => dupByCard.get(idKey(card.id)),
    matchOf: (mr) => matchBy.get(mrKey(mr.repoId, mr.iid)),
  };

  const verdicts: Verdict[] = [];
  const build = (rule: HealthRule, card: Card | null, mr: Mr | null): Verdict => {
    const fix = rule.fix?.(card, mr, ctx) ?? null;
    const state = ctx.mrStateOf(mr);
    return {
      ruleId: rule.id,
      severity: rule.severity,
      message: rule.message,
      cardId: card?.id ?? null,
      repoId: mr?.repoId ?? null,
      mrIid: mr?.iid ?? null,
      notionStatus: card?.status ?? null,
      mrState: state,
      cardTitle: card?.title ?? null,
      mrTitle: mr?.title ?? null,
      sides: { notion: card?.status ?? '—', gitlab: gitlabLabel(state) },
      detail: rule.detail?.(card, mr, ctx) ?? null,
      fix,
      alternatives: rule.alternatives?.(card, mr, ctx) ?? [],
    };
  };

  // ── card scope ─────────────────────────────────────────────────────
  const unruled: Unruled[] = [];
  for (const card of input.cards) {
    const mr = primaryMrOf.get(card.id) ?? null;
    let covered = false;
    for (const rule of HEALTH_RULES) {
      if (rule.scope !== 'card' || !rule.when(card, mr, ctx)) continue;
      verdicts.push(build(rule, card, mr));
      if (ruleCoversStatus(rule, card, ctx)) covered = true;
    }
    if (!covered) {
      const role = ctx.roleOf(card);
      unruled.push({
        cardId: card.id,
        title: card.title,
        status: card.status,
        mrState: ctx.mrStateOf(mr),
        reason:
          card.status === null
            ? 'no_status'
            : role === null
              ? 'unrecognized_status'
              : 'no_rule_for_pair',
      });
    }
  }

  // ── MR scope ───────────────────────────────────────────────────────
  // In scope: live MRs, and merged MRs still waiting for a version bump (they hold up the release). Closed and
  // already-released MRs are history and would only be noise.
  for (const mr of input.mrs) {
    if (mr.isVersionMr) continue;
    const live = mr.state === 'opened' || mr.state === 'locked';
    const pendingRelease = mr.state === 'merged' && ctx.releaseOf(mr)?.bumped === false;
    if (!live && !pendingRelease) continue;
    const m = matchBy.get(mrKey(mr.repoId, mr.iid));
    if (!m) continue;
    const single = m.cardIds.length === 1 ? (cardBy.get(idKey(m.cardIds[0]!)) ?? null) : null;
    for (const rule of HEALTH_RULES) {
      if (rule.scope !== 'mr' || !rule.when(single, mr, ctx)) continue;
      verdicts.push(build(rule, single, mr));
    }
  }

  verdicts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.cardTitle ?? '').localeCompare(b.cardTitle ?? '') ||
      (a.cardId ?? '').localeCompare(b.cardId ?? '') ||
      (a.repoId ?? '').localeCompare(b.repoId ?? '') ||
      (a.mrIid ?? 0) - (b.mrIid ?? 0),
  );
  unruled.sort((a, b) => a.title.localeCompare(b.title) || a.cardId.localeCompare(b.cardId));
  return { verdicts, unruled, primaryMrOf };
}

export function countBySeverity(verdicts: readonly Verdict[]): Record<Severity, number> {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const v of verdicts) out[v.severity]++;
  return out;
}
