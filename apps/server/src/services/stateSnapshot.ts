import { eq } from 'drizzle-orm';
import { domainResolver } from '@relay/shared';
import type {
  GlobalConfig,
  Link,
  MatchBy,
  StateCard,
  StateMr,
  StateSnapshot,
  SyncStatus,
} from '@relay/shared';
import type { AppDb } from '../db';
import { cards, links, mrs } from '../db/schema';
import { buildHealthReport, rowToMr, type HealthRepo } from './healthReport';
import { loadMrStates } from './linkStore';
import { cardMonth } from './kpiEngine';
import { mrInvolves, mrKeysLinkedToMyCards } from './mineScope';
import { rowToCard } from './notionStore';
import { buildPendingReleases } from './releaseCheck';
import { mrKey } from './syncHealthEngine';
import { isVersionMr } from './versionMr';

/** Sync status provider used when no engine is running (tests / tools): everything `never`. */
export const NO_SYNC_STATUS = (): SyncStatus => ({
  running: false,
  queued: false,
  skippedBusy: 0,
  lastRun: null,
  sources: [],
  schedule: null,
});

/**
 * `GET /api/state` body: a read-only view of the local cache. Nothing here calls GitLab or
 * Notion, and nothing in it is secret. Derived MR state is cosmetic; the merge gate re-fetches live.
 * `kpi` is not part of this snapshot: the KPI view reads `GET /api/kpi`.
 */
export function buildStateSnapshot(
  app: AppDb,
  repos: readonly HealthRepo[],
  sync: SyncStatus,
  now: number,
  global: Pick<GlobalConfig, 'notion' | 'gitlab' | 'mrTiming' | 'sla'>,
): StateSnapshot {
  const prefixes = new Map(repos.map((r) => [r.id, r.versionBranchPrefix] as const));
  const states = loadMrStates(app, repos);
  // Verdicts + MR timing come from the same engine as `GET /api/sync/health` (cache only).
  const report = buildHealthReport(app, repos, global, now);
  const timingBy = new Map(report.timing.map((t) => [mrKey(t.repoId, t.iid), t] as const));
  const linkedToMine = mrKeysLinkedToMyCards(app);

  const mrRows: StateMr[] = app.db
    .select()
    .from(mrs)
    .all()
    .map((row) => {
      const m = rowToMr(row);
      const prefix = prefixes.get(m.repoId);
      return {
        ...m,
        derivedState: states.get(`${m.repoId}#${m.iid}`) ?? 'open',
        isVersionMr: prefix !== undefined && isVersionMr(m, prefix),
        timing: timingBy.get(mrKey(m.repoId, m.iid))!,
        mine: mrInvolves(m, global.gitlab.myUsername) || linkedToMine.has(mrKey(m.repoId, m.iid)),
      };
    })
    .sort((a, b) => a.repoId.localeCompare(b.repoId) || b.iid - a.iid);

  const linkRows: Link[] = app.db
    .select()
    .from(links)
    .all()
    .map((l) => ({
      id: l.id,
      cardId: l.cardId,
      repoId: l.repoId,
      mrIid: l.mrIid,
      matchBy: l.matchBy as MatchBy,
      conflict: l.conflict,
      createdAt: l.createdAt,
    }));

  // Same "mine" set and month rule as KPI (kpiService / kpiEngine.cardMonth).
  const domainOf = domainResolver(repos);
  const cardRows: StateCard[] = app.db
    .select()
    .from(cards)
    .where(eq(cards.archived, false))
    .all()
    .map((r) => {
      const d = domainOf(r.productDomain);
      return {
        ...rowToCard(r),
        mine: r.assignedToMe || r.assignedAtManual !== null,
        month: cardMonth(r, global.sla.assignedAtSource),
        domainState: d.state,
        domainRepoId: d.repoId,
        domainRepoIds: d.repoIds,
      };
    });

  return {
    generatedAt: now,
    cards: cardRows,
    mrs: mrRows,
    links: linkRows,
    health: { implemented: true, verdicts: report.verdicts, sync },
    pendingReleases: { implemented: true, items: buildPendingReleases(app, repos, global, now) },
  };
}
