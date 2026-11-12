import { domainResolver, healthFindingKey } from '@relay/shared';
import type {
  DismissedVerdict,
  GlobalConfig,
  HealthRangeQuery,
  HealthReport,
  Mr,
  MrDerivedState,
  MrTiming,
  RepoConfig,
  Verdict,
} from '@relay/shared';
import type { AppDb } from '../db';
import { jobs, mrs, notesCache } from '../db/schema';
import { buildFamilies, idKey, type FamilyCardMr } from './familyTree';
import { loadDismissals } from './healthDismissals';
import { loadMatchInput, loadMrStates } from './linkStore';
import { matchCardsToMrs } from './matcher';
import { deriveMrTiming, deriveReviewLatency, type TimingNote } from './mrTiming';
import { listCards } from './notionStore';
import { loadReleaseStates } from './releaseCheck';
import { deriveReleaseFacts, type BuildJobRow } from './releaseFacts';
import {
  countBySeverity,
  evaluateHealth,
  mrKey,
  primaryMrsByCard,
  type HealthMr,
} from './syncHealthEngine';
import { isVersionMr } from './versionMr';

/** What the report needs from the per-repo config. */
export type HealthRepo = Pick<
  RepoConfig,
  'id' | 'reviewers' | 'baseBranch' | 'versionBranchPrefix' | 'name' | 'productDomains'
>;

/** Cached MR row → shared `Mr`. */
export function rowToMr(m: typeof mrs.$inferSelect): Mr {
  return {
    repoId: m.repoId,
    iid: m.iid,
    gitlabId: m.gitlabId,
    title: m.title,
    state: m.state as Mr['state'],
    draft: m.draft,
    hasConflicts: m.hasConflicts,
    sourceBranch: m.sourceBranch,
    targetBranch: m.targetBranch,
    author: m.author,
    webUrl: m.webUrl,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    mergedAt: m.mergedAt,
    descriptionNotionId: m.descriptionNotionId,
    approvedBy: m.approvedBy,
    assignees: m.assignees,
    reviewers: m.reviewers,
    lastNoteAt: m.lastNoteAt,
    headPipeline: m.headPipeline ?? null,
    syncedAt: m.syncedAt,
  };
}

export function loadTimingNotes(app: AppDb): Map<string, TimingNote[]> {
  const out = new Map<string, TimingNote[]>();
  for (const n of app.db
    .select({
      repoId: notesCache.repoId,
      mrIid: notesCache.mrIid,
      author: notesCache.author,
      system: notesCache.system,
      body: notesCache.body,
      createdAt: notesCache.createdAt,
      resolvable: notesCache.resolvable,
      resolved: notesCache.resolved,
    })
    .from(notesCache)
    .all()) {
    const k = mrKey(n.repoId, n.mrIid);
    const list = out.get(k);
    if (list) list.push(n);
    else out.set(k, [n]);
  }
  return out;
}

/** Epoch ms of local midnight of `YYYY-MM-DD` (+ `addDays`), in the server's time zone. */
function localDayStart(ymd: string, addDays = 0): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + addDays).getTime();
}

function loadBuildJobs(app: AppDb): BuildJobRow[] {
  return app.db
    .select({
      repoId: jobs.repoId,
      kind: jobs.kind,
      status: jobs.status,
      version: jobs.version,
      dryRun: jobs.dryRun,
    })
    .from(jobs)
    .all();
}

/**
 * Sync Health report + MR timing + family tree, computed from the LOCAL CACHE only.
 * Never calls GitLab or Notion and never writes anything. Every verdict's `fix` is a suggestion.
 */
export function buildHealthReport(
  app: AppDb,
  repos: readonly HealthRepo[],
  global: Pick<GlobalConfig, 'notion' | 'gitlab' | 'mrTiming'>,
  now: number,
  /** Token bot users that are "me" too (see `ConfigStore.myUsernames`). */
  alsoMe: readonly string[] = [],
  /** Limit the findings to a period (inclusive local days). Absent = every finding. */
  range: HealthRangeQuery = {},
): HealthReport {
  const repoBy = new Map(repos.map((r) => [r.id, r] as const));
  const states = loadMrStates(app, repos);
  const notesByMr = loadTimingNotes(app);

  const mrRows: HealthMr[] = app.db
    .select()
    .from(mrs)
    .all()
    .map((row) => {
      const mr = rowToMr(row);
      const prefix = repoBy.get(mr.repoId)?.versionBranchPrefix;
      return {
        ...mr,
        derivedState: (states.get(mrKey(mr.repoId, mr.iid)) ?? 'open') as Exclude<
          MrDerivedState,
          'none'
        >,
        isVersionMr: prefix !== undefined && isVersionMr(mr, prefix),
      };
    });

  const cards = listCards(app);
  const prefixOf = (id: string) => repoBy.get(id)?.versionBranchPrefix;
  const match = matchCardsToMrs({ ...loadMatchInput(app), versionBranchPrefix: prefixOf });
  const release = deriveReleaseFacts(
    mrRows,
    repos,
    loadBuildJobs(app),
    loadReleaseStates(app, repos, now),
  );

  // Primary MR per card first: the family tree shows each child's MR state.
  const primary = primaryMrsByCard(cards, match.links, mrRows);
  const mrOf = (cardId: string): FamilyCardMr | undefined => {
    const m = primary.get(cardId);
    return m ? { state: m.derivedState, repoId: m.repoId, iid: m.iid } : undefined;
  };
  const families = buildFamilies({ cards, mrOf, readyStatus: global.notion.readyStatus });

  const { verdicts, unruled } = evaluateHealth({
    now,
    cards,
    mrs: mrRows,
    match,
    statuses: global.notion.statuses,
    readyStatus: global.notion.readyStatus,
    completeAliases: global.notion.statusGroups.complete,
    domainOf: domainResolver(repos),
    release,
    families,
  });

  const timing: MrTiming[] = mrRows.map((m) =>
    deriveMrTiming(m, notesByMr.get(mrKey(m.repoId, m.iid)) ?? [], {
      now,
      reviewers: repoBy.get(m.repoId)?.reviewers ?? [],
      me: global.gitlab.myUsername,
      alsoMe,
      thresholds: global.mrTiming,
    }),
  );
  const timingBy = new Map(timing.map((t) => [mrKey(t.repoId, t.iid), t] as const));
  const reviewLatency = deriveReviewLatency(
    mrRows.map((m) => ({
      state: m.state,
      draft: m.draft,
      isVersionMr: m.isVersionMr,
      createdAt: m.createdAt,
      firstReviewerResponseAt:
        timingBy.get(mrKey(m.repoId, m.iid))?.firstReviewerResponseAt ?? null,
    })),
  );

  // Period: a card counts by its Notion creation date (last edit when unknown), a card-less finding by its MR.
  // Matching above still runs over everything, so links across the period boundary stay correct.
  const fromMs = range.from ? localDayStart(range.from) : -Infinity;
  const toMs = range.to ? localDayStart(range.to, 1) : Infinity;
  const inside = (at: number | undefined) => at === undefined || (at >= fromMs && at < toMs);
  const cardAt = new Map(cards.map((c) => [idKey(c.id), c.notionCreatedAt ?? c.lastEditedAt]));
  const mrAt = new Map(mrRows.map((m) => [mrKey(m.repoId, m.iid), m.createdAt]));
  const verdictInside = (v: Verdict) =>
    v.cardId
      ? inside(cardAt.get(idKey(v.cardId)))
      : v.repoId && v.mrIid
        ? inside(mrAt.get(mrKey(v.repoId, v.mrIid)))
        : true;
  const cardsInside = cards.filter((c) => inside(c.notionCreatedAt ?? c.lastEditedAt));

  // False positives: kept apart, out of the counts. An `ok` verdict is never hidden.
  const dismissals = loadDismissals(app);
  const shown: Verdict[] = [];
  const dismissed: DismissedVerdict[] = [];
  for (const v of verdicts) {
    if (!verdictInside(v)) continue;
    const at = v.severity === 'ok' ? undefined : dismissals.get(healthFindingKey(v));
    if (at === undefined) shown.push(v);
    else dismissed.push({ ...v, dismissedAt: at });
  }
  dismissed.sort((a, b) => b.dismissedAt - a.dismissedAt);

  return {
    generatedAt: now,
    range: { from: range.from ?? null, to: range.to ?? null },
    verdicts: shown,
    dismissed,
    counts: { total: shown.length, bySeverity: countBySeverity(shown), cards: cardsInside.length },
    unruled: unruled.filter((u) => inside(cardAt.get(idKey(u.cardId)))),
    families: families.families,
    chips: families.chips,
    timing: timing.sort((a, b) => a.repoId.localeCompare(b.repoId) || b.iid - a.iid),
    reviewLatency,
    releaseFacts: [...release.values()].sort(
      (a, b) => a.repoId.localeCompare(b.repoId) || b.iid - a.iid,
    ),
  };
}
