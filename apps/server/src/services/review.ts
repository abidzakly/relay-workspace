import type {
  Branch,
  CommitSummary,
  CompareReview,
  DiffFile,
  DiffRefs,
  ApprovalMode,
  GlobalConfig,
  InboxMr,
  MrReview,
  ReviewApproval,
  ReviewDiscussion,
} from '@relay/shared';
import type { AppDb } from '../db';
import type { ApprovalsOutcome } from './gitlabService';
import type { MrFields } from './gitlabMr';
import { filesReason } from './mrDetail';
import { inboxItem, type InboxRepo } from './mrInbox';
import { deriveMrState } from './mrState';
import { deriveMrTiming } from './mrTiming';

/**
 * Code Reviewer data, READ-ONLY. The MR header comes from the local cache (same row as
 * the inbox); diffs, diff refs and positioned discussions are read live. The three live reads are independent: one
 * failing leaves the others on screen, with a plain-language reason.
 */

/** The GET-only slice of `GitlabService` the reviewer needs (tests pass a fake). */
export interface ReviewReader {
  getMrDiffRefs(iid: number): Promise<DiffRefs | null>;
  getMrDiffs(iid: number): Promise<{ files: DiffFile[]; truncated: boolean }>;
  getReviewDiscussions(iid: number): Promise<ReviewDiscussion[]>;
  listBranches(search?: string): Promise<{ branches: Branch[]; truncated: boolean }>;
  compare(
    from: string,
    to: string,
  ): Promise<{
    commits: CommitSummary[];
    commitCount: number;
    files: DiffFile[];
    truncated: boolean;
    webUrl: string | null;
  }>;
}

export interface MrReviewInput {
  app: AppDb;
  repos: readonly (InboxRepo & { approvalMode: ApprovalMode })[];
  global: Pick<GlobalConfig, 'gitlab' | 'mrTiming'>;
  repoId: string;
  iid: number;
  /** null = GitLab is not usable: the header still renders, every live part is reported missing. */
  live: ReviewReader | null;
  liveError: string | null;
  now: number;
}

const discussionsReason = (e: unknown): string =>
  filesReason(e).replace('could not list the files', 'could not list the comments');

const sameUser = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Approve / revoke capability for one MR (see `ReviewApprovalSchema`). Pure. */
export function reviewApproval(
  mr: Pick<InboxMr, 'state' | 'author' | 'approvedBy'>,
  mode: ApprovalMode,
  me: string | null | undefined,
): ReviewApproval {
  const approvedByMe = !!me && mr.approvedBy.some((u) => sameUser(u, me));
  const open = mr.state === 'opened';
  const mine = sameUser(mr.author, me);
  const reason = !me
    ? 'Set your GitLab username in Settings to approve from here.'
    : !open
      ? 'Only an open MR can be approved.'
      : mine
        ? 'You cannot approve your own MR.'
        : null;
  return {
    mode,
    approvedByMe,
    canApprove: !!me && open && !mine && !approvedByMe,
    canRevoke: !!me && open && approvedByMe && mode !== 'note_keyword',
    reason,
  };
}

/** null = MR unknown to the cache. */
export async function buildMrReview(i: MrReviewInput): Promise<MrReview | null> {
  const mr = inboxItem(i.app, i.repos, i.global, i.repoId, i.iid, i.now);
  if (!mr) return null;
  const mode = i.repos.find((r) => r.id === i.repoId)?.approvalMode ?? 'approvals_api';
  const approval = reviewApproval(mr, mode, i.global.gitlab.myUsername);
  const errors: string[] = [];
  if (i.liveError) errors.push(i.liveError);
  if (!i.live) {
    return {
      generatedAt: i.now,
      mr,
      diffRefs: null,
      files: [],
      truncated: false,
      discussions: [],
      approval,
      errors,
    };
  }
  return { generatedAt: i.now, mr, approval, ...(await liveParts(i.live, i.iid, errors)) };
}

/** Diff refs, diff and positioned threads: three independent live reads; a failure becomes a plain reason. */
async function liveParts(
  live: ReviewReader,
  iid: number,
  errors: string[],
): Promise<Pick<MrReview, 'diffRefs' | 'files' | 'truncated' | 'discussions' | 'errors'>> {
  const [refsR, diffsR, discR] = await Promise.allSettled([
    live.getMrDiffRefs(iid),
    live.getMrDiffs(iid),
    live.getReviewDiscussions(iid),
  ]);
  const diffRefs = refsR.status === 'fulfilled' ? refsR.value : null;
  if (refsR.status === 'rejected') errors.push(`Line comments: ${filesReason(refsR.reason)}`);
  else if (!diffRefs) errors.push('GitLab did not report diff refs: new line comments are off.');
  if (diffsR.status === 'rejected') errors.push(`Diff: ${filesReason(diffsR.reason)}`);
  if (discR.status === 'rejected') errors.push(`Comments: ${discussionsReason(discR.reason)}`);
  return {
    diffRefs,
    files: diffsR.status === 'fulfilled' ? diffsR.value.files : [],
    truncated: diffsR.status === 'fulfilled' ? diffsR.value.truncated : false,
    discussions: discR.status === 'fulfilled' ? discR.value : [],
    errors,
  };
}

/** The live reads an external-project review needs on top of `ReviewReader`. */
export interface ExtReviewReader extends ReviewReader {
  getMrDetail(iid: number): Promise<MrFields>;
  getApprovals(iid: number): Promise<ApprovalsOutcome>;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A review of an MR in a project that is not a configured repo (Reviews, `~<projectId>`). Nothing is cached for such
 * a project, so the header is read live too. Throws (GitlabApiError) when the MR itself cannot be read.
 */
export async function buildExtMrReview(i: {
  live: ExtReviewReader;
  repoId: string;
  repoName: string;
  iid: number;
  global: Pick<GlobalConfig, 'gitlab' | 'mrTiming'>;
  /** The reviewer token's user: "me" on this desk. */
  me: string | null;
  now: number;
}): Promise<MrReview> {
  const [f, approvals] = await Promise.all([
    i.live.getMrDetail(i.iid),
    i.live
      .getApprovals(i.iid)
      .catch((): ApprovalsOutcome => ({ mode: 'approvals_api', status: 'error', approvedBy: [] })),
  ]);
  const errors: string[] = [];
  if (approvals.status !== 'ok') errors.push('Approvals could not be read.');
  const approvedBy = approvals.approvedBy;
  const reviewers = f.reviewers ?? [];
  const me = i.me ?? i.global.gitlab.myUsername ?? null;
  const mr: InboxMr = {
    repoId: i.repoId,
    repoName: i.repoName,
    iid: i.iid,
    title: f.title,
    state: f.state,
    derivedState: deriveMrState(
      { state: f.state, draft: f.draft, author: f.author, approvedBy },
      [],
      reviewers,
    ),
    draft: f.draft,
    hasConflicts: f.hasConflicts ?? false,
    isVersionMr: false,
    author: f.author,
    webUrl: f.webUrl,
    sourceBranch: f.sourceBranch,
    targetBranch: f.targetBranch,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    mergedAt: f.mergedAt,
    lastNoteAt: null,
    headPipeline: f.headPipeline ?? null,
    approvedBy,
    reviewers: reviewers.map((u) => ({
      username: u,
      approved: approvedBy.some((a) => sameName(a, u)),
      commented: false,
      approvedAt: null,
    })),
    unreadNotes: 0,
    card: null,
    timing: deriveMrTiming(
      {
        repoId: i.repoId,
        iid: i.iid,
        state: f.state,
        draft: f.draft,
        author: f.author,
        createdAt: f.createdAt,
        mergedAt: f.mergedAt,
        updatedAt: f.updatedAt,
        approvedBy,
      },
      [],
      { now: i.now, reviewers, me: me ?? undefined, thresholds: i.global.mrTiming },
    ),
    action: { kind: 'review_requested', rank: 2, yours: true, label: 'Your review' },
    mine: false,
  };
  const approval = reviewApproval(mr, 'approvals_api', me);
  return { generatedAt: i.now, mr, approval, ...(await liveParts(i.live, i.iid, errors)) };
}

/** Throws (GitlabApiError) on failure: a compare has nothing useful to show without GitLab. */
export async function buildCompareReview(i: {
  live: ReviewReader;
  repoId: string;
  repoName: string;
  from: string;
  to: string;
  now: number;
}): Promise<CompareReview> {
  const c = await i.live.compare(i.from, i.to);
  return {
    generatedAt: i.now,
    repoId: i.repoId,
    repoName: i.repoName,
    from: i.from,
    to: i.to,
    commits: c.commits,
    commitCount: c.commitCount,
    files: c.files,
    truncated: c.truncated,
    webUrl: c.webUrl,
  };
}
