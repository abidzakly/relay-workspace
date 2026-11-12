import type {
  ActionKind,
  GlobalConfig,
  InboxMr,
  MrCardRef,
  MrInbox,
  MrListQuery,
  MrTiming,
  RepoConfig,
  ReviewerStatus,
} from '@relay/shared';
import type { AppDb } from '../db';
import { links, mrs, notesCache } from '../db/schema';
import { idKey } from './familyTree';
import { loadMrStates } from './linkStore';
import { deriveMrTiming, type TimingNote } from './mrTiming';
import { approvedAtFromNotes } from './gitlabMr';
import { listCards } from './notionStore';
import { mrKey } from './syncHealthEngine';
import { isVersionMr } from './versionMr';
import { rowToMr } from './healthReport';
import { mrInvolves, mrKeysLinkedToMyCards } from './mineScope';
import { loadStackRefs } from './mrStack';

/**
 * MR Inbox view-model: every cached MR of every repo, ranked by "needs your action".
 * Computed from the LOCAL CACHE only; read-only; the ranking is COSMETIC (never used by the merge gate).
 *
 * "You" = `gitlab.myUsername`. GitLab's per-MR reviewer assignment is not cached, so "review requested of you" is
 * approximated: you are a configured reviewer of the repo, you are not the author, and you have not approved.
 */

export type InboxRepo = Pick<RepoConfig, 'id' | 'name' | 'reviewers' | 'versionBranchPrefix'>;

const RANK: Record<ActionKind, { rank: number; yours: boolean; label: string }> = {
  reply_needed: { rank: 0, yours: true, label: 'Reply needed' },
  ready_to_merge: { rank: 1, yours: true, label: 'Looks ready to merge' },
  review_requested: { rank: 2, yours: true, label: 'Your review' },
  conflicts: { rank: 3, yours: true, label: 'Has conflicts' },
  pipeline_failed: { rank: 4, yours: true, label: 'Pipeline failed' },
  waiting_reviewer: { rank: 5, yours: false, label: 'Waiting for reviewer' },
  open: { rank: 6, yours: false, label: 'Open' },
  draft: { rank: 7, yours: false, label: 'Draft' },
  merged: { rank: 8, yours: false, label: 'Merged' },
  closed: { rank: 9, yours: false, label: 'Closed' },
};

const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface ActionInput {
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft: boolean;
  hasConflicts: boolean;
  author: string | null;
  approvedBy: readonly string[];
  pipelineStatus: string | null;
  isVersionMr: boolean;
  timing: Pick<MrTiming, 'waitingOn'>;
  reviewers: readonly string[];
  me: string | undefined;
}

/** Pure. The first matching rule wins; see `RANK` for the order. */
export function classifyAction(i: ActionInput): InboxMr['action'] {
  const pick = (kind: ActionKind): InboxMr['action'] => ({ kind, ...RANK[kind] });
  if (i.state === 'merged') return pick('merged');
  if (i.state === 'closed') return pick('closed');
  const mine = eq(i.author, i.me);
  if (i.timing.waitingOn.kind === 'you') return pick('reply_needed');
  const reviewerApproved = i.approvedBy.some((a) => i.reviewers.some((r) => eq(r, a)));
  if (mine && !i.draft && reviewerApproved && !i.hasConflicts && !i.isVersionMr)
    return pick('ready_to_merge');
  const iAmReviewer = !!i.me && i.reviewers.some((r) => eq(r, i.me));
  if (iAmReviewer && !mine && !i.draft && !i.approvedBy.some((a) => eq(a, i.me)))
    return pick('review_requested');
  if (mine && i.hasConflicts) return pick('conflicts');
  if (mine && i.pipelineStatus === 'failed') return pick('pipeline_failed');
  if (i.draft) return pick('draft');
  if (i.timing.waitingOn.kind === 'reviewer') return pick('waiting_reviewer');
  return pick('open');
}

const stateMatches = (state: string, f: MrListQuery['state']): boolean =>
  f === 'all' ||
  (f === 'open' && (state === 'opened' || state === 'locked')) ||
  (f === 'merged' && state === 'merged') ||
  (f === 'closed' && state === 'closed');

/** Newest-first key for finished MRs, oldest-waiting-first for open ones. */
function tie(a: InboxMr, b: InboxMr): number {
  if (a.state === 'merged' || a.state === 'closed')
    return (b.mergedAt ?? b.updatedAt ?? b.createdAt) - (a.mergedAt ?? a.updatedAt ?? a.createdAt);
  return a.createdAt - b.createdAt;
}

export function buildMrInbox(
  app: AppDb,
  repos: readonly InboxRepo[],
  global: Pick<GlobalConfig, 'gitlab' | 'mrTiming'>,
  query: MrListQuery,
  now: number,
  /** Token bot users that are "me" too (see `ConfigStore.myUsernames`). */
  alsoMe: readonly string[] = [],
): MrInbox {
  const repoBy = new Map(repos.map((r) => [r.id, r] as const));
  const states = loadMrStates(app, repos);
  const me = global.gitlab.myUsername;

  const notesByMr = new Map<string, (TimingNote & { seen: boolean })[]>();
  for (const n of app.db.select().from(notesCache).all()) {
    const k = mrKey(n.repoId, n.mrIid);
    const list = notesByMr.get(k);
    const row = { ...n };
    if (list) list.push(row);
    else notesByMr.set(k, [row]);
  }

  const cardBy = new Map(listCards(app).map((c) => [idKey(c.id), c] as const));
  const cardOfMr = new Map<string, MrCardRef>();
  for (const l of app.db.select().from(links).all()) {
    const c = cardBy.get(idKey(l.cardId));
    if (!c) continue;
    const k = mrKey(l.repoId, l.mrIid);
    const prev = cardOfMr.get(k);
    // Prefer a non-conflicting link; if several remain, the first stays (a conflict is shown, never resolved).
    if (prev && (!prev.conflict || l.conflict)) continue;
    cardOfMr.set(k, {
      id: c.id,
      title: c.title,
      status: c.status,
      url: c.url,
      matchBy: l.matchBy as MrCardRef['matchBy'],
      conflict: l.conflict,
    });
  }

  const linkedToMine = mrKeysLinkedToMyCards(app);
  const layout = loadStackRefs(app);
  const all: InboxMr[] = [];
  for (const row of app.db.select().from(mrs).all()) {
    const mr = rowToMr(row);
    const repo = repoBy.get(mr.repoId);
    if (!repo) continue; // repo deleted: rows are cascade-removed, this is only a guard
    if (query.repo && mr.repoId !== query.repo) continue;
    if (!stateMatches(mr.state, query.state)) continue;
    const k = mrKey(mr.repoId, mr.iid);
    const notes = notesByMr.get(k) ?? [];
    const human = notes.filter((n) => !n.system);

    if (
      query.reviewer &&
      !mr.approvedBy.some((a) => eq(a, query.reviewer)) &&
      !human.some((n) => eq(n.author, query.reviewer))
    )
      continue;

    const timing = deriveMrTiming(mr, notes, {
      now,
      reviewers: repo.reviewers,
      me,
      alsoMe,
      thresholds: global.mrTiming,
    });
    const reviewers: ReviewerStatus[] = repo.reviewers.map((u) => ({
      username: u,
      approved: mr.approvedBy.some((a) => eq(a, u)),
      commented: human.some((n) => eq(n.author, u)),
      approvedAt: mr.approvedBy.some((a) => eq(a, u)) ? approvedAtFromNotes(notes, u) : null,
    }));
    const versionMr = isVersionMr(mr, repo.versionBranchPrefix);
    all.push({
      repoId: mr.repoId,
      repoName: repo.name,
      iid: mr.iid,
      title: mr.title,
      state: mr.state,
      derivedState: states.get(k) ?? 'open',
      draft: mr.draft,
      hasConflicts: mr.hasConflicts,
      isVersionMr: versionMr,
      author: mr.author,
      webUrl: mr.webUrl,
      sourceBranch: mr.sourceBranch,
      targetBranch: mr.targetBranch,
      createdAt: mr.createdAt,
      updatedAt: mr.updatedAt,
      mergedAt: mr.mergedAt,
      lastNoteAt: mr.lastNoteAt,
      headPipeline: mr.headPipeline,
      approvedBy: mr.approvedBy,
      reviewers,
      unreadNotes: human.filter((n) => !n.seen).length,
      card: cardOfMr.get(k) ?? null,
      timing,
      action: classifyAction({
        state: mr.state,
        draft: mr.draft,
        hasConflicts: mr.hasConflicts,
        author: mr.author,
        approvedBy: mr.approvedBy,
        pipelineStatus: mr.headPipeline?.status ?? null,
        isVersionMr: versionMr,
        timing,
        reviewers: repo.reviewers,
        me,
      }),
      mine: mrInvolves(mr, me) || linkedToMine.has(k),
      stack:
        mr.state === 'opened' || mr.state === 'locked'
          ? (layout.refs.get(`${mr.repoId}!${mr.iid}`) ?? null)
          : null,
    });
    // A stacked child is never "ready to merge": its parent must be merged first.
    const last = all[all.length - 1]!;
    if (last.action.kind === 'ready_to_merge' && last.stack?.blocked) {
      last.action = { kind: 'open', ...RANK.open, label: 'Waiting for parent MR' };
    }
  }

  all.sort(
    (a, b) =>
      a.action.rank - b.action.rank ||
      tie(a, b) ||
      a.repoId.localeCompare(b.repoId) ||
      b.iid - a.iid,
  );

  return {
    generatedAt: now,
    items: all,
    repos: repos.map((r) => ({ id: r.id, name: r.name })),
    reviewers: [...new Set(repos.flatMap((r) => r.reviewers))].sort((a, b) => a.localeCompare(b)),
    yoursCount: all.filter((m) => m.action.yours).length,
    stacks: layout.stacks.filter((st) => !query.repo || st.repoId === query.repo),
  };
}

/** Exposed for the detail builder (same card/reviewer/timing derivations on one MR). */
export function inboxItem(
  app: AppDb,
  repos: readonly InboxRepo[],
  global: Pick<GlobalConfig, 'gitlab' | 'mrTiming'>,
  repoId: string,
  iid: number,
  now: number,
): InboxMr | undefined {
  return buildMrInbox(app, repos, global, { state: 'all', repo: repoId }, now).items.find(
    (m) => m.iid === iid,
  );
}
