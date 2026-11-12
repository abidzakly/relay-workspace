import type {
  Card,
  FamilyTree,
  HealthReport,
  Link,
  ParentChip,
  Severity,
  StateCard,
  StateMr,
  StateSnapshot,
  Verdict,
} from '@relay/shared';

/** column order. Matching is by canonical name (case/space-insensitive), like the server. */
export const COLUMNS = [
  'Backlog',
  'Next Up',
  'In Progress',
  'Complete',
  'Ready to Test',
  'On Feedback',
  'Issues',
] as const;
export type ColumnName = (typeof COLUMNS)[number] | 'No status' | 'Other status';

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** Notion ids come dashed or not; compare undashed + lowercase. */
export const nid = (s: string): string => s.replace(/-/g, '').toLowerCase();
export const mrKey = (repoId: string, iid: number): string => `${repoId}#${iid}`;

const SEVERITY_RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, action: 3, critical: 4 };
export const worst = (a: Severity, b: Severity): Severity =>
  SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;

/** How the card's primary MR is linked. `none` = the card has no linked MR. */
export type LinkKind =
  'strong' | 'weak_title' | 'weak_description' | 'manual' | 'mismatch' | 'duplicate' | 'none';

export interface CardTileModel {
  card: StateCard;
  column: ColumnName;
  /** Primary MR: newest live, else newest (same pick as the Sync Health engine). */
  mr: StateMr | null;
  /** Other MRs linked to the same card (duplicates are flagged, never resolved). */
  extraMrs: number;
  link: LinkKind;
  /** The card's verdicts (card rules + the link.* rules of its primary MR), worst first. */
  verdicts: Verdict[];
  /** Worst severity; `info` + `unruled` when no rule-table row covers the card. */
  severity: Severity;
  unruled: boolean;
  /** The Notion status and the MR state disagree (behind / ahead / stale / contradiction / missing MR). */
  statusMismatch: Verdict | null;
  parentChip: ParentChip | null;
  family: FamilyTree | null;
}

export interface OrphanMrModel {
  mr: StateMr;
  verdict: Verdict;
}

export interface BoardModel {
  columns: { name: ColumnName; tiles: CardTileModel[] }[];
  orphans: OrphanMrModel[];
}

const LIVE = new Set(['opened', 'locked']);

export function columnFor(
  card: Card,
  readyStatus: string | undefined,
  /** `notion.statusGroups.complete`: the workspace's spellings of Complete (e.g. "Completed"). */
  completeStatuses: readonly string[] | undefined,
): ColumnName {
  if (!card.status) return 'No status';
  const s = norm(card.status);
  for (const c of COLUMNS) if (norm(c) === s) return c;
  if (readyStatus && norm(readyStatus) === s) return 'Ready to Test';
  if (completeStatuses?.some((c) => norm(c) === s)) return 'Complete';
  return 'Other status';
}

const MISMATCH_PREFIX = ['behind.', 'ahead.', 'stale.', 'contradiction.', 'missing_mr.'];

function linkKindFromRule(ruleId: string): LinkKind | null {
  switch (ruleId) {
    case 'link.mismatch':
      return 'mismatch';
    case 'link.duplicate':
      return 'duplicate';
    case 'link.weak_title':
      return 'weak_title';
    case 'link.weak_description':
      return 'weak_description';
    default:
      return null;
  }
}

export function buildBoard(
  state: StateSnapshot,
  health: HealthReport,
  readyStatus: string | undefined,
  completeStatuses: readonly string[] | undefined,
): BoardModel {
  const mrByKey = new Map(state.mrs.map((m) => [mrKey(m.repoId, m.iid), m] as const));
  const linksByCard = new Map<string, Link[]>();
  for (const l of state.links) {
    const k = nid(l.cardId);
    const arr = linksByCard.get(k);
    if (arr) arr.push(l);
    else linksByCard.set(k, [l]);
  }
  const verdictsByCard = new Map<string, Verdict[]>();
  const verdictsByMr = new Map<string, Verdict[]>();
  for (const v of health.verdicts) {
    if (v.cardId) {
      const k = nid(v.cardId);
      const arr = verdictsByCard.get(k);
      if (arr) arr.push(v);
      else verdictsByCard.set(k, [v]);
    }
    if (v.repoId && v.mrIid && v.ruleId.startsWith('link.')) {
      const k = mrKey(v.repoId, v.mrIid);
      const arr = verdictsByMr.get(k);
      if (arr) arr.push(v);
      else verdictsByMr.set(k, [v]);
    }
  }
  const unruledIds = new Set(health.unruled.map((u) => nid(u.cardId)));
  const chipByCard = new Map(health.chips.map((c) => [nid(c.cardId), c] as const));
  const familyByParent = new Map(health.families.map((f) => [nid(f.parentId), f] as const));

  const columns = new Map<ColumnName, CardTileModel[]>();
  for (const card of state.cards) {
    if (card.archived) continue;
    const key = nid(card.id);
    const linked = (linksByCard.get(key) ?? [])
      .map((l) => ({ l, mr: mrByKey.get(mrKey(l.repoId, l.mrIid)) }))
      .filter((x): x is { l: Link; mr: StateMr } => x.mr !== undefined);
    const live = linked.filter((x) => LIVE.has(x.mr.state));
    const pool = live.length > 0 ? live : linked;
    const primary = [...pool].sort((a, b) => b.mr.createdAt - a.mr.createdAt)[0] ?? null;

    const verdicts = [
      ...(verdictsByCard.get(key) ?? []),
      ...(primary ? (verdictsByMr.get(mrKey(primary.mr.repoId, primary.mr.iid)) ?? []) : []),
    ];
    const seen = new Set<Verdict>();
    const uniq = verdicts.filter((v) => !seen.has(v) && seen.add(v));
    uniq.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

    let link: LinkKind = 'none';
    if (primary) {
      link =
        uniq.map((v) => linkKindFromRule(v.ruleId)).find((k) => k !== null) ??
        (primary.l.conflict
          ? 'mismatch'
          : primary.l.matchBy === 'both'
            ? 'strong'
            : primary.l.matchBy === 'manual'
              ? 'manual'
              : primary.l.matchBy === 'title'
                ? 'weak_title'
                : 'weak_description');
    }

    const unruled = unruledIds.has(key);
    const severity = uniq.reduce<Severity>(
      (acc, v) => worst(acc, v.severity),
      unruled ? 'info' : 'ok',
    );
    const statusMismatch =
      uniq.find(
        (v) => v.severity !== 'ok' && MISMATCH_PREFIX.some((p) => v.ruleId.startsWith(p)),
      ) ?? null;

    const column = columnFor(card, readyStatus, completeStatuses);
    const tile: CardTileModel = {
      card,
      column,
      mr: primary?.mr ?? null,
      extraMrs: Math.max(0, linked.length - 1),
      link,
      verdicts: uniq,
      severity,
      unruled,
      statusMismatch,
      parentChip: chipByCard.get(key) ?? null,
      family: familyByParent.get(key) ?? null,
    };
    const arr = columns.get(column);
    if (arr) arr.push(tile);
    else columns.set(column, [tile]);
  }

  const order: ColumnName[] = [...COLUMNS, 'Other status', 'No status'];
  const out = order
    .map((name) => ({ name, tiles: (columns.get(name) ?? []).sort(byRecency) }))
    // Fixed columns always render (an empty Board column is information); catch-all columns only when used.
    .filter((c) => (COLUMNS as readonly string[]).includes(c.name) || c.tiles.length > 0);

  const orphans: OrphanMrModel[] = [];
  for (const v of health.verdicts) {
    if (v.ruleId !== 'link.orphan' || !v.repoId || !v.mrIid) continue;
    const mr = mrByKey.get(mrKey(v.repoId, v.mrIid));
    if (mr) orphans.push({ mr, verdict: v });
  }
  return { columns: out, orphans };
}

const severityRank = (s: Severity): number =>
  ['ok', 'info', 'warn', 'action', 'critical'].indexOf(s);
const byRecency = (a: CardTileModel, b: CardTileModel): number =>
  b.card.lastEditedAt - a.card.lastEditedAt;

// ───────────────────────────── filters ─────────────────────────────

export interface BoardFilters {
  repo: string;
  assignee: string;
  type: string;
  /** Free text: every word must appear in the card's title, status, type, assignees, or its MR's number or title. */
  query?: string;
}
export const NO_FILTER = '';
export const NO_FILTERS: BoardFilters = { repo: '', assignee: '', type: '', query: '' };

/** Lower case with accents removed, so "cafe" finds "Café". */
export const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const words = (q: string): string[] => fold(q).split(/\s+/).filter(Boolean);

/** The text a card is searched by. `!123` and `123` both find MR 123. */
function haystack(t: CardTileModel): string {
  const mr = t.mr ? `!${t.mr.iid} ${t.mr.iid} ${t.mr.title}` : '';
  return fold(
    [t.card.title, t.card.status ?? '', t.card.type ?? '', t.card.assignees.join(' '), mr].join(
      ' ',
    ),
  );
}

export function matchesQuery(t: CardTileModel, query: string): boolean {
  const ws = words(query);
  if (ws.length === 0) return true;
  const hay = haystack(t);
  return ws.every((w) => hay.includes(w));
}

export function matchesFilters(t: CardTileModel, f: BoardFilters): boolean {
  // A card belongs to a repo through its Product Domain, or through its linked MR.
  if (f.repo !== NO_FILTER && !t.card.domainRepoIds.includes(f.repo) && t.mr?.repoId !== f.repo)
    return false;
  if (f.assignee !== NO_FILTER && !t.card.assignees.includes(f.assignee)) return false;
  if (f.type !== NO_FILTER && t.card.type !== f.type) return false;
  if (f.query && !matchesQuery(t, f.query)) return false;
  return true;
}

/** Cards that look done and are not yet Ready: Complete, or their MR is merged. The dialog re-reads and sorts them out. */
export function bulkReadyCandidates(model: BoardModel, filters: BoardFilters): string[] {
  return model.columns.flatMap((col) =>
    col.name === 'Ready to Test'
      ? []
      : col.tiles
          .filter(
            (t) =>
              matchesFilters(t, filters) && (col.name === 'Complete' || t.mr?.state === 'merged'),
          )
          .map((t) => t.card.id),
  );
}

/** An orphan MR has no card, so assignee / type filters cannot match it: it is hidden while one is active. */
export function orphanMatchesFilters(o: OrphanMrModel, f: BoardFilters): boolean {
  if (f.assignee !== NO_FILTER || f.type !== NO_FILTER) return false;
  if (f.repo !== NO_FILTER && o.mr.repoId !== f.repo) return false;
  const ws = words(f.query ?? '');
  const hay = fold(`!${o.mr.iid} ${o.mr.iid} ${o.mr.title}`);
  return ws.every((w) => hay.includes(w));
}

export function filterOptions(cards: Card[]): { assignees: string[]; types: string[] } {
  const a = new Set<string>();
  const t = new Set<string>();
  for (const c of cards) {
    for (const n of c.assignees) a.add(n);
    if (c.type) t.add(c.type);
  }
  const sort = (s: Set<string>) => [...s].sort((x, y) => x.localeCompare(y));
  return { assignees: sort(a), types: sort(t) };
}
