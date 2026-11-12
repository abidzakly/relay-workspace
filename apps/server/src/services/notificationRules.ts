import {
  isTokenBot,
  type NotificationEvent,
  type NotificationSubject,
  type RepoConfig,
} from '@relay/shared';
import { APPROVAL_KEYWORD_RE } from './gitlabMr';
import type { MergeRequestEvent, NoteEvent, NormalizedEvent, PipelineEvent } from './webhookEvents';

/**
 * Which webhook deliveries notify. Pure: no DB, no I/O, no clock. The notifier loads the
 * context BEFORE the cache update (so "was this MR already merged?" and "was there an earlier note in this
 * thread?" still see the old state), applies the per-event toggles and the dedupe, and sends.
 *
 *   approved        MR `approved` action by a configured reviewer (or, in `note_keyword` mode, a reviewer's
 *                   "approved"/"lgtm" note)
 *   comment / reply a human note on an MR (reply = the thread already had a note); author != me
 *   merged          the MR was merged by someone other than me
 *   pipelineFailed  a failed, non-tag pipeline of a tracked open MR
 *   ignoreOwn       drops the actions of `gitlab.myUsername` (approve / note / merge); a pipeline failure is not
 *                   an "action of mine" and is never dropped
 */

export interface NotifyRepo {
  id: string;
  name: string;
  reviewers: string[];
  approvalMode: RepoConfig['approvalMode'];
}

export interface NotifyContext {
  repo: NotifyRepo;
  /** `gitlab.myUsername` (undefined = unknown: nothing can be recognised as "own"). */
  me: string | undefined;
  /** The repo tokens' GitLab users (`project_<id>_bot_<hash>`): their actions are mine too. */
  tokenUsers?: readonly string[];
  ignoreOwn: boolean;
  /** The cached MR as it was BEFORE this delivery changed it (null = not cached). */
  mr: { iid: number; title: string; state: string } | null;
  /** Note events: the thread already contains an earlier note (=> a reply). */
  repliesToExisting: boolean;
  /** Pipeline events: the open MRs the pipeline belongs to (cached). */
  pipelineMrs: { iid: number; title: string }[];
}

export interface Candidate {
  event: NotificationEvent;
  /** Semantic identity for the dedupe window (same key inside `ttlMs` = the same notification). */
  key: string;
  ttlMs: number;
  title: string;
  body: string;
  /** Dashboard path opened by a click. */
  url: string;
  /** OS-tray collapse key. */
  tag: string;
  repoId: string | null;
  /** What it is about: the notification center looks this up to decide what can still be done. null = nothing to look up. */
  subject: NotificationSubject | null;
}

const mrSubject = (
  repoId: string,
  iid: number,
  extra: { discussionId?: string | undefined; pipelineId?: number | undefined } = {},
): NotificationSubject => ({
  kind: 'mr',
  repoId,
  iid,
  discussionId: extra.discussionId ?? null,
  pipelineId: extra.pipelineId ?? null,
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const APPROVE = new Set(['approved', 'approval']);

const lower = (s: string | undefined): string | undefined => s?.toLowerCase();

function isMe(ctx: NotifyContext, user: string | undefined): boolean {
  if (user === undefined) return false;
  if (ctx.me !== undefined && lower(ctx.me) === lower(user)) return true;
  return ctx.tokenUsers?.some((t) => lower(t) === lower(user)) ?? false;
}
const dropOwn = (ctx: NotifyContext, user: string | undefined): boolean =>
  ctx.ignoreOwn && isMe(ctx, user);

const isReviewer = (ctx: NotifyContext, user: string | undefined): boolean =>
  user !== undefined && ctx.repo.reviewers.some((r) => r.toLowerCase() === user.toLowerCase());

export const mrPath = (repoId: string, iid: number): string =>
  `/mrs/${encodeURIComponent(repoId)}/${iid}`;

/** One short line: markdown noise and whitespace collapsed, clipped. */
export function snippet(text: string, max = 140): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const mrLabel = (ctx: NotifyContext, iid: number): string => `${ctx.repo.name} !${iid}`;

function approvedCandidate(ctx: NotifyContext, iid: number, who: string, title: string): Candidate {
  return {
    repoId: ctx.repo.id,
    url: mrPath(ctx.repo.id, iid),
    subject: mrSubject(ctx.repo.id, iid),
    event: 'approved',
    // `approved` + `approval` can both fire for one click: one key per (MR, approver).
    key: `approved:${ctx.repo.id}:${iid}:${who.toLowerCase()}`,
    ttlMs: 2 * MIN,
    title: `Approved · ${mrLabel(ctx, iid)}`,
    body: `${who} approved “${snippet(title, 100)}”`,
    tag: `approved:${ctx.repo.id}:${iid}`,
  };
}

function fromMergeRequest(ev: MergeRequestEvent, ctx: NotifyContext): Candidate[] {
  const title = ev.title ?? ctx.mr?.title ?? `!${ev.iid}`;
  const base = {
    repoId: ctx.repo.id,
    url: mrPath(ctx.repo.id, ev.iid),
    subject: mrSubject(ctx.repo.id, ev.iid),
  };

  if (ev.action !== undefined && APPROVE.has(ev.action)) {
    if (!ev.actor || !isReviewer(ctx, ev.actor) || dropOwn(ctx, ev.actor)) return [];
    return [approvedCandidate(ctx, ev.iid, ev.actor, title)];
  }

  // An explicit `merge` action, or (MR cached, was not merged) a payload that now says merged. Without a cached
  // row an `update` of an already-merged MR (title edit, label...) must not read as a fresh merge.
  const merged =
    ev.action === 'merge' ||
    (ev.state === 'merged' && ctx.mr !== null && ctx.mr.state !== 'merged');
  if (!merged) return [];
  // Already known as merged (an earlier delivery or a sync got there first): not news.
  if (ctx.mr?.state === 'merged') return [];
  if (dropOwn(ctx, ev.actor)) return [];
  return [
    {
      ...base,
      event: 'merged',
      key: `merged:${ctx.repo.id}:${ev.iid}`,
      ttlMs: 7 * DAY,
      title: `Merged · ${mrLabel(ctx, ev.iid)}`,
      body: ev.actor
        ? `${ev.actor} merged “${snippet(title, 100)}”`
        : `“${snippet(title, 100)}” was merged`,
      tag: `merged:${ctx.repo.id}:${ev.iid}`,
    },
  ];
}

function fromNote(ev: NoteEvent, ctx: NotifyContext): Candidate[] {
  if (ev.mrIid === undefined || ev.system) return [];
  // An edited note is not a new comment (the `action` field is documented for newer GitLab only).
  if (ev.action === 'update') return [];
  if (dropOwn(ctx, ev.author)) return [];
  const title = ctx.mr?.title ?? `!${ev.mrIid}`;

  // Tiers without the Approvals API: a reviewer's "approved" / "lgtm" note IS the approval.
  if (ctx.repo.approvalMode === 'note_keyword' && ev.author && isReviewer(ctx, ev.author)) {
    const firstLine = ev.body.split('\n').find((l) => l.trim().length > 0) ?? '';
    if (APPROVAL_KEYWORD_RE.test(firstLine.trim())) {
      return [approvedCandidate(ctx, ev.mrIid, ev.author, title)];
    }
  }

  const event: NotificationEvent = ctx.repliesToExisting ? 'reply' : 'comment';
  // A token bot's username is a long hash: say whose it is instead.
  const who =
    ev.author === undefined
      ? 'Someone'
      : isMe(ctx, ev.author)
        ? 'Me'
        : isTokenBot(ev.author)
          ? 'A bot'
          : ev.author;
  const text = snippet(ev.body);
  return [
    {
      repoId: ctx.repo.id,
      url: mrPath(ctx.repo.id, ev.mrIid),
      subject: mrSubject(ctx.repo.id, ev.mrIid, { discussionId: ev.discussionId }),
      event,
      key: `${event}:${ctx.repo.id}:${ev.noteId}`,
      ttlMs: DAY,
      title: `${event === 'reply' ? 'Reply' : 'New comment'} · ${mrLabel(ctx, ev.mrIid)}`,
      body: text ? `${who}: ${text}` : `${who} commented on “${snippet(title, 100)}”`,
      tag: `note:${ctx.repo.id}:${ev.mrIid}`,
    },
  ];
}

function fromPipeline(ev: PipelineEvent, ctx: NotifyContext): Candidate[] {
  if (ev.status !== 'failed' || ev.tag) return [];
  const mr = ctx.pipelineMrs[0];
  if (!mr) return []; // only pipelines of a tracked open MR
  const more = ctx.pipelineMrs.length > 1 ? ` (+${ctx.pipelineMrs.length - 1} more MRs)` : '';
  return [
    {
      repoId: ctx.repo.id,
      url: mrPath(ctx.repo.id, mr.iid),
      subject: mrSubject(ctx.repo.id, mr.iid, { pipelineId: ev.pipelineId }),
      event: 'pipelineFailed',
      key: `pipelineFailed:${ctx.repo.id}:${ev.pipelineId}`,
      ttlMs: DAY,
      title: `Pipeline failed · ${mrLabel(ctx, mr.iid)}`,
      body: `“${snippet(mr.title, 100)}”${more}`,
      tag: `pipeline:${ctx.repo.id}:${mr.iid}`,
    },
  ];
}

/** Candidates for one normalized webhook delivery (before the per-event toggles and the dedupe). */
export function qualifyWebhook(ev: NormalizedEvent, ctx: NotifyContext): Candidate[] {
  switch (ev.kind) {
    case 'merge_request':
      return fromMergeRequest(ev, ctx);
    case 'note':
      return fromNote(ev, ctx);
    case 'pipeline':
      return fromPipeline(ev, ctx);
    case 'push':
      return [];
  }
}

// ───────────────────────────── sync mismatch ─────────────────────────────

/**
 * Sync Health rule families that mean "Notion and GitLab disagree" (status rows + the title/description
 * mismatch). Release / family / duplicate / orphan rows are "things to do", not mismatches. Edit here to widen.
 */
const MISMATCH_RULE_PREFIXES = [
  'behind.',
  'ahead.',
  'stale.',
  'contradiction.',
  'missing_mr.',
  'link.mismatch',
] as const;

export function isMismatchRule(ruleId: string): boolean {
  return MISMATCH_RULE_PREFIXES.some((p) => ruleId.startsWith(p));
}

/** Severities that can notify (`ok` / `info` never do). */
export const MISMATCH_SEVERITIES: ReadonlySet<string> = new Set(['warn', 'action', 'critical']);

export interface MismatchVerdictLike {
  ruleId: string;
  severity: string;
  cardId: string | null;
  repoId: string | null;
  mrIid: number | null;
  cardTitle: string | null;
  mrTitle: string | null;
  message: string;
}

/** Stable identity of one finding across evaluations. */
export function mismatchKey(v: MismatchVerdictLike): string {
  return `${v.ruleId}|${v.cardId ?? '-'}|${v.repoId ?? '-'}!${v.mrIid ?? '-'}`;
}

export function mismatchCandidate(
  v: MismatchVerdictLike,
  repoName: (id: string) => string,
): Candidate {
  const where = v.repoId && v.mrIid ? `${repoName(v.repoId)} !${v.mrIid}` : null;
  const what = v.cardTitle ?? v.mrTitle ?? 'A card';
  return {
    event: 'mismatch',
    key: `mismatch:${mismatchKey(v)}`,
    ttlMs: 0, // deduped by the persisted "already notified" set, not by a time window
    title: `Sync mismatch${where ? ` · ${where}` : ''}`,
    body: `${snippet(what, 80)}: ${snippet(v.message, 120)}`,
    url: '/sync',
    tag: `mismatch:${mismatchKey(v)}`.slice(0, 100),
    repoId: v.repoId,
    subject: { kind: 'mismatch', key: mismatchKey(v) },
  };
}

export function mismatchSummary(n: number): Candidate {
  return {
    event: 'mismatch',
    key: `mismatch:summary:${n}`,
    ttlMs: 0,
    title: `${n} new sync mismatches`,
    body: 'Notion and GitLab disagree on several cards. Open Sync Health.',
    url: '/sync',
    tag: 'mismatch:summary',
    repoId: null,
    subject: null,
  };
}

const KPI_URL = '/kpi';

/** A card's timer passed 80%. One per deadline: moving the deadline is a new warning. */
export function slaWarnCandidate(card: {
  id: string;
  title: string;
  deadline: number;
  percent: number;
  timeLeft: string;
}): Candidate {
  return {
    event: 'slaWarn',
    key: `sla:warn:${card.id}:${card.deadline}`,
    ttlMs: DAY,
    title: `⏰ SLA at ${card.percent}%: ${card.title}`,
    body: `${card.timeLeft} left before the deadline. Opening its MR stops the clock.`,
    url: KPI_URL,
    tag: `sla:${card.id}`,
    repoId: null,
    subject: { kind: 'card', cardId: card.id, deadline: card.deadline },
  };
}

/** A card's deadline passed with no MR open. Replaces its warning in the OS tray (same tag). */
export function slaBreachCandidate(card: {
  id: string;
  title: string;
  deadline: number;
}): Candidate {
  return {
    event: 'slaBreach',
    key: `sla:breach:${card.id}:${card.deadline}`,
    ttlMs: DAY,
    title: `🔴 SLA breached: ${card.title}`,
    body: 'The deadline passed with no MR open.',
    url: KPI_URL,
    tag: `sla:${card.id}`,
    repoId: null,
    subject: { kind: 'card', cardId: card.id, deadline: card.deadline },
  };
}

export function slaSummaryCandidate(event: 'slaWarn' | 'slaBreach', n: number): Candidate {
  const breach = event === 'slaBreach';
  return {
    event,
    key: `sla:summary:${event}:${n}`,
    ttlMs: 0,
    title: breach ? `🔴 ${n} cards breached their SLA` : `⏰ ${n} cards passed 80% of their SLA`,
    body: 'Open KPI for the list.',
    url: KPI_URL,
    tag: `sla:summary:${event}`,
    repoId: null,
    subject: null,
  };
}

/** Day 20 of a month still under the research quota. Sent under the `slaWarn` toggle. */
export function researchReminderCandidate(input: {
  month: string;
  count: number;
  required: number;
}): Candidate {
  return {
    event: 'slaWarn',
    key: `research:${input.month}`,
    ttlMs: DAY,
    title: '🔬 Research quota not met yet',
    body: `${input.count} of ${input.required} research cards so far this month.`,
    url: KPI_URL,
    tag: `research:${input.month}`,
    repoId: null,
    subject: { kind: 'month', month: input.month },
  };
}

/** A staging APK reached Drive. */
export function uploadedCandidate(input: {
  jobId: string;
  repoId: string;
  repoName: string;
  version: string | null;
}): Candidate {
  const version = input.version ? ` v${input.version}` : '';
  return {
    event: 'buildDone',
    key: `uploaded:${input.jobId}`,
    ttlMs: DAY,
    title: `✅ ${input.repoName}${version} uploaded — Send to QA`,
    body: 'The APK is on Drive. Open Builds to send it to QA.',
    url: '/builds',
    tag: `uploaded:${input.jobId}`,
    repoId: input.repoId,
    subject: { kind: 'job', jobId: input.jobId },
  };
}
