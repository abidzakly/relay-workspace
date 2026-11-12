import {
  evaluateMergeGate,
  formatAgo,
  type HeadPipeline,
  type MrState,
  type NotificationAction,
  type NotificationCategory,
  type NotificationLifecycle,
  type NotificationLive,
  type NotificationPriority,
  type NotificationSubject,
  type RepoConfig,
} from '@relay/shared';
import { mrPath } from './notificationRules';

/**
 * What can be done about a notification NOW. Pure: the notification center loads the current facts and this decides.
 * Nothing is stored, so an old notification follows the state of what it is about.
 *
 * Works from the local cache. An action can therefore be a moment behind GitLab, which is safe because actions only
 * navigate: "Merge now" opens the MR, whose merge gate reads GitLab live and whose dialog still asks for Confirm.
 */

export interface MrFact {
  state: string;
  draft: boolean;
  hasConflicts: boolean;
  approvedBy: readonly string[];
  mergedAt: number | null;
  headPipeline: HeadPipeline | null;
  /** The last full sync of this MR. Webhooks update the row without touching it. */
  syncedAt: number;
}

export interface RepoFact {
  reviewers: readonly string[];
  approvalMode: RepoConfig['approvalMode'];
}

export interface KpiFact {
  timers: ReadonlyMap<string, { open: boolean; deadline: number | null }>;
  month: string;
  researchMet: boolean;
}

/** A `null` section could not be read right now: the row says so rather than guessing that the thing is gone. */
export interface NotificationFacts {
  now: number;
  mr(repoId: string, iid: number): MrFact | null;
  repo(repoId: string): RepoFact | null;
  threadResolved(discussionId: string): boolean;
  branchMr(repoId: string, branch: string): { iid: number; state: string } | null;
  job(jobId: string): { qaLinkOpenedAt: number | null } | null;
  readyBranches: ReadonlySet<string> | null;
  sessions: ReadonlyMap<string, { state: string; waiting: boolean }> | null;
  mismatches: ReadonlySet<string> | null;
  kpi: KpiFact | null;
}

export const readyKey = (repoId: string, branch: string): string => `${repoId}:${branch}`;

export interface NotificationFactsRow {
  event: string;
  url: string;
  at: number;
  subject: NotificationSubject | null;
}

const live = (
  status: NotificationLive['status'],
  note: string | null,
  actions: NotificationAction[],
): NotificationLive => ({ status, note, actions });

const link = (label: string, url: string): NotificationAction => ({ label, url });

const NOTE_REPO_GONE = 'Repo no longer configured';
const NOTE_MR_GONE = 'MR no longer tracked';
const NOTE_HOST_DOWN = 'Agent host not reachable';
/** Notes that mean the source could not be checked: the row cannot be trusted, so it reads as stale. */
const UNVERIFIED_NOTES: ReadonlySet<string> = new Set([
  NOTE_REPO_GONE,
  NOTE_MR_GONE,
  NOTE_HOST_DOWN,
]);

const COCKPIT_URL = '/cockpit';
const BUILDS_URL = '/builds';
const KPI_URL = '/kpi';
const SYNC_URL = '/sync';
const RELEASE_URL = '/release';

function forApproved(
  subject: { repoId: string; iid: number },
  mr: MrFact,
  url: string,
  at: number,
  facts: NotificationFacts,
): NotificationLive {
  const view = link('View MR', url);
  const repo = facts.repo(subject.repoId);
  if (!repo) return live('info', NOTE_REPO_GONE, [view]);
  const gate = evaluateMergeGate({
    source: 'cache',
    checkedAt: facts.now,
    state: mr.state as MrState,
    draft: mr.draft,
    hasConflicts: mr.hasConflicts,
    approvalMode: repo.approvalMode,
    approvals: { status: 'ok', approvedBy: mr.approvedBy },
    reviewers: repo.reviewers,
    gitlabMergeStatus: null,
    // Not known from the cache. The MR's own gate, read live on arrival, checks both.
    stack: { status: 'ok', openParents: [], commitCount: null },
    squash: { mr: null, project: null },
  });
  const merge = (note: string) =>
    live('actionable', note, [{ label: 'Merge now', url, openMerge: true }]);
  if (gate.allowed) return merge('Ready to merge');

  const blocked = new Set(gate.reasons.map((r) => r.code));
  if (blocked.has('draft')) return live('info', 'Back to draft', [view]);
  if (blocked.has('has_conflicts')) {
    return live('actionable', 'Has conflicts', [link('Resolve conflicts', url)]);
  }
  if (blocked.has('not_approved')) {
    // The approval reaches the cache only with the next full sync on tiers without the approvals webhook, so "no
    // approver" is only news once a sync has run since this notification.
    return mr.syncedAt > at ? live('info', 'Approval withdrawn', [view]) : merge('Ready to merge');
  }
  return live('info', null, [view]);
}

function forMr(
  event: string,
  subject: Extract<NotificationSubject, { kind: 'mr' }>,
  row: NotificationFactsRow,
  facts: NotificationFacts,
): NotificationLive {
  const url = mrPath(subject.repoId, subject.iid);
  const view = link('View MR', url);
  const mr = facts.mr(subject.repoId, subject.iid);
  if (!mr) return live('info', NOTE_MR_GONE, []);

  if (event === 'merged') return live('resolved', null, [view, link('Release Train', RELEASE_URL)]);
  if (mr.state === 'merged') {
    const when = mr.mergedAt !== null ? ` ${formatAgo(facts.now - mr.mergedAt)}` : '';
    return live('resolved', `Merged${when}`, [view]);
  }
  if (mr.state === 'closed') return live('resolved', 'MR closed', [view]);
  if (mr.state === 'locked') return live('info', 'GitLab is merging this MR', [view]);

  switch (event) {
    case 'approved':
      return forApproved(subject, mr, url, row.at, facts);
    case 'comment':
    case 'reply':
      if (subject.discussionId && facts.threadResolved(subject.discussionId)) {
        return live('resolved', 'Thread resolved', [view]);
      }
      return live('actionable', null, [link('Reply', url)]);
    case 'pipelineFailed': {
      const head = mr.headPipeline;
      const check = live('actionable', 'Pipeline still failing', [link('Check pipeline', url)]);
      // No head yet, or the cache has not seen this pipeline: nothing says it was fixed.
      if (!head || subject.pipelineId === null || head.id < subject.pipelineId) return check;
      if (head.id > subject.pipelineId) return live('resolved', 'Newer pipeline ran', [view]);
      return head.status === 'failed' ? check : live('resolved', 'Pipeline was retried', [view]);
    }
    default:
      return live('info', null, [view]);
  }
}

function forBranch(
  subject: Extract<NotificationSubject, { kind: 'branch' }>,
  url: string,
  facts: NotificationFacts,
): NotificationLive {
  const mr = facts.branchMr(subject.repoId, subject.branch);
  if (mr && (mr.state === 'opened' || mr.state === 'locked' || mr.state === 'merged')) {
    return live(
      'resolved',
      mr.state === 'merged' ? `Merged via !${mr.iid}` : `MR !${mr.iid} opened`,
      [link(`View MR !${mr.iid}`, mrPath(subject.repoId, mr.iid))],
    );
  }
  if (facts.readyBranches === null) return live('info', null, [link('Create MR', url)]);
  return facts.readyBranches.has(readyKey(subject.repoId, subject.branch))
    ? live('actionable', null, [link('Create MR', url)])
    : live('resolved', 'No longer ready', []);
}

function forSession(
  subject: Extract<NotificationSubject, { kind: 'session' }>,
  url: string,
  facts: NotificationFacts,
): NotificationLive {
  if (facts.sessions === null) {
    return live('info', NOTE_HOST_DOWN, [link('Open Cockpit', COCKPIT_URL)]);
  }
  const session = facts.sessions.get(subject.sessionId);
  if (!session || session.state === 'exited') {
    return live('resolved', 'Session ended', [link('Open Cockpit', COCKPIT_URL)]);
  }
  if (subject.hasFiles) return live('actionable', null, [link('Review changes', url)]);
  return session.waiting
    ? live('actionable', 'Waiting for you', [link('Open session', url)])
    : live('info', 'Agent is working', [link('Open session', url)]);
}

function forCard(
  subject: Extract<NotificationSubject, { kind: 'card' }>,
  facts: NotificationFacts,
): NotificationLive {
  const open = link('Open KPI', KPI_URL);
  if (facts.kpi === null) return live('info', null, [open]);
  const timer = facts.kpi.timers.get(subject.cardId);
  if (!timer || !timer.open) return live('resolved', 'Timer stopped', [open]);
  if (timer.deadline !== subject.deadline) return live('resolved', 'Deadline changed', [open]);
  return live('actionable', null, [open]);
}

function forMonth(
  subject: Extract<NotificationSubject, { kind: 'month' }>,
  facts: NotificationFacts,
): NotificationLive {
  const open = link('Open KPI', KPI_URL);
  if (facts.kpi === null) return live('info', null, [open]);
  if (subject.month !== facts.kpi.month) return live('resolved', 'Month is over', [open]);
  return facts.kpi.researchMet
    ? live('resolved', 'Quota met', [open])
    : live('actionable', null, [open]);
}

/** Exhaustive over the subject kinds: a new kind must decide its actions here. */
export function resolveLive(row: NotificationFactsRow, facts: NotificationFacts): NotificationLive {
  const subject = row.subject;
  if (subject === null) return live('info', null, [link('Open', row.url)]);
  switch (subject.kind) {
    case 'mr':
      return forMr(row.event, subject, row, facts);
    case 'branch':
      return forBranch(subject, row.url, facts);
    case 'session':
      return forSession(subject, row.url, facts);
    case 'job': {
      const job = facts.job(subject.jobId);
      if (!job) return live('resolved', 'Build no longer available', [link('Builds', BUILDS_URL)]);
      return job.qaLinkOpenedAt !== null
        ? live('resolved', 'QA link opened', [link('Builds', BUILDS_URL)])
        : live('actionable', null, [link('Send to QA', BUILDS_URL)]);
    }
    case 'mismatch': {
      const open = link('Open Sync Health', SYNC_URL);
      if (facts.mismatches === null) return live('info', null, [open]);
      return facts.mismatches.has(subject.key)
        ? live('actionable', null, [open])
        : live('resolved', 'Fixed', []);
    }
    case 'card':
      return forCard(subject, facts);
    case 'month':
      return forMonth(subject, facts);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long an open (actionable / info) notification stays fresh. Past it, the row reads as stale. */
const STALE_AFTER_MS: Record<string, number> = {
  comment: DAY,
  reply: DAY,
  approved: DAY,
  buildDone: DAY,
  slaWarn: 12 * HOUR,
  slaBreach: 3 * DAY,
  pipelineFailed: 3 * DAY,
  readyForMr: 3 * DAY,
  agentDone: HOUR,
  reviewRequested: 3 * DAY,
  mismatch: 7 * DAY,
};
const DEFAULT_STALE_AFTER_MS = 3 * DAY;

export function categoryOf(event: string): NotificationCategory {
  switch (event) {
    case 'approved':
    case 'comment':
    case 'reply':
    case 'merged':
    case 'readyForMr':
    case 'reviewRequested':
      return 'mr';
    case 'pipelineFailed':
      return 'pipeline';
    case 'slaWarn':
    case 'slaBreach':
      return 'sla';
    case 'buildDone':
      return 'build';
    case 'agentDone':
      return 'agent';
    default:
      return 'system';
  }
}

function priorityOf(event: string, liveState: NotificationLive): NotificationPriority {
  if (event === 'test' || liveState.status === 'resolved') return 'low';
  if (liveState.note === 'Has conflicts') return 'urgent';
  const actionable = liveState.status === 'actionable';
  switch (event) {
    case 'slaBreach':
      return 'urgent';
    case 'pipelineFailed':
    case 'mismatch':
      return actionable ? 'urgent' : 'low';
    case 'slaWarn':
      return 'high';
    case 'approved':
    case 'comment':
    case 'reply':
    case 'agentDone':
    case 'reviewRequested':
      return actionable ? 'high' : 'low';
    case 'readyForMr':
    case 'buildDone':
      return actionable ? 'normal' : 'low';
    default:
      return actionable ? 'normal' : 'low';
  }
}

export interface NotificationClass {
  priority: NotificationPriority;
  category: NotificationCategory;
  lifecycle: NotificationLifecycle;
}

/** Pure. Priority, category and lifecycle of a row, from its event, age and current live state. */
export function classify(
  row: Pick<NotificationFactsRow, 'event' | 'at'>,
  liveState: NotificationLive,
  now: number,
): NotificationClass {
  const category = categoryOf(row.event);
  const priority = priorityOf(row.event, liveState);
  if (liveState.status === 'resolved')
    return { priority, category, lifecycle: 'handled_elsewhere' };
  if (row.event === 'test') return { priority, category, lifecycle: 'info' };
  const unverified = liveState.note !== null && UNVERIFIED_NOTES.has(liveState.note);
  const old = now - row.at > (STALE_AFTER_MS[row.event] ?? DEFAULT_STALE_AFTER_MS);
  if (unverified || old) return { priority, category, lifecycle: 'stale' };
  return {
    priority,
    category,
    lifecycle: liveState.status === 'actionable' ? 'needs_action' : 'info',
  };
}
