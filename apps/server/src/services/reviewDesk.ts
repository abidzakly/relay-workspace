import {
  REVIEW_POLL_MS,
  REVIEW_WEBHOOK_FRESH_MS,
  extRepoId,
  type ReviewDesk,
  type ReviewDeskItem,
  type ReviewLane,
  type ReviewReason,
  type ReviewSource,
  type ReviewTodo,
  type ReviewTokenStatus,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { guardedWrite } from './dryRun';
import { GitlabClient } from './gitlab';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';
import type { Candidate } from './notificationRules';
import type { Notifier } from './notifier';
import {
  rememberProjectPaths,
  reviewerIdentity,
  setReviewerIdentity,
  type ReviewerIdentity,
} from './reviewTarget';
import type { NormalizedEvent } from './webhookEvents';

/**
 * Reviews: the reviewer's desk (see `@relay/shared` reviewDesk.ts). WEBHOOK FIRST:
 *  - A webhook delivery (a configured repo's, or the Reviews hook on a group/project) marks its project as "live" and,
 *    when it concerns me (a mention, an MR on my desk, a reviewer change), re-reads the desk within seconds.
 *  - Only projects no webhook reaches are polled: once a minute ONE `GET /todos` checks for news. The full re-read
 *    (MR list + approvals) runs only when that check sees a change in a polled project.
 * Every item says how it arrives (`source`) and, when polled, why. Local marks (reviewed up to a SHA, snooze) never
 * leave this machine. The only GitLab write is "mark to-do as done" (guarded: dry-run + audit).
 */

export interface ReviewDeskDeps {
  config: ConfigStore;
  http: HttpClient;
  log: Logger;
  audit: AuditWriter;
  bus?: EventBus;
  notifier?: Pick<Notifier, 'notifyCockpit'>;
  now?: () => number;
}

interface RawItem {
  key: string;
  projectId: number;
  projectPath: string;
  iid: number;
  title: string;
  author: string | null;
  authorName: string | null;
  webUrl: string | null;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  hasConflicts: boolean;
  mergeStatus: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number | null;
  headSha: string | null;
  notes: number;
  reviewer: boolean;
  todos: ReviewTodo[];
}

interface Approvals {
  updatedAt: number | null;
  approvedBy: string[];
  left: number | null;
  ok: boolean;
}

type Marks = Record<string, { sha: string; at: number }>;
type Snoozes = Record<string, number>;
type Deliveries = Record<string, number>;

const MARKS = 'reviews.marks';
const SNOOZES = 'reviews.snoozes';
const DELIVERIES = 'reviews.deliveries';
const HOOK_DELIVERY = 'reviews.hookDelivery';
const MAX_PAGES = 5;
const APPROVALS_MAX = 60;
const APPROVALS_CONCURRENCY = 4;
const WEBHOOK_DEBOUNCE_MS = 2_500;
/** Even with every project on a webhook, the desk is re-read this often (to-dos marked done in GitLab's UI...). */
const SAFETY_REFRESH_MS = 15 * 60_000;
const BODY_MAX = 280;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
const time = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const lower = (s: string) => s.toLowerCase();
const sameSha = (a: string | null, b: string | null) =>
  !!a && !!b && (lower(a).startsWith(lower(b)) || lower(b).startsWith(lower(a)));
const keyOf = (projectId: number, iid: number) => `${projectId}!${iid}`;
/** Markdown / HTML stripped to one plain line: to-do bodies are user content, shown as text. */
const plain = (s: string | null): string | null => {
  if (!s) return null;
  const t = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_~>#[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX - 1)}…` : t;
};

const pathFromRef = (mr: Record<string, unknown>): string | null => {
  const full = str(rec(mr.references).full);
  if (full) return full.replace(/!\d+$/, '');
  const url = str(mr.web_url);
  const m = url ? /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(url) : null;
  return m?.[1] ?? null;
};

/** One MR object (from the MR list or a to-do's `target`) into the desk shape. null = not an open MR we can use. */
function mapMr(
  raw: unknown,
  projectPath: string | null,
): Omit<RawItem, 'reviewer' | 'todos'> | null {
  const mr = rec(raw);
  const projectId = int(mr.project_id) ?? int(mr.target_project_id);
  const iid = int(mr.iid);
  const createdAt = time(mr.created_at);
  if (!projectId || !iid || createdAt === null) return null;
  if (mr.state !== 'opened') return null;
  const author = rec(mr.author);
  const path = projectPath ?? pathFromRef(mr) ?? String(projectId);
  return {
    key: keyOf(projectId, iid),
    projectId,
    projectPath: path,
    iid,
    title: str(mr.title) ?? `!${iid}`,
    author: str(author.username),
    authorName: str(author.name),
    webUrl: str(mr.web_url),
    sourceBranch: str(mr.source_branch) ?? '',
    targetBranch: str(mr.target_branch) ?? '',
    draft: mr.draft === true || mr.work_in_progress === true,
    hasConflicts: mr.has_conflicts === true,
    mergeStatus: str(mr.detailed_merge_status) ?? str(mr.merge_status),
    labels: Array.isArray(mr.labels)
      ? mr.labels.filter((l): l is string => typeof l === 'string').slice(0, 20)
      : [],
    createdAt,
    updatedAt: time(mr.updated_at),
    headSha: str(mr.sha),
    notes: int(mr.user_notes_count) ?? 0,
  };
}

const ASKING: ReadonlySet<ReviewReason> = new Set([
  'reviewer',
  'review_requested',
  'directly_addressed',
  'approval_required',
  'assigned',
]);

/** Pure. Where an item sits on the desk (see `REVIEW_LANES`). */
export function laneOf(
  x: Pick<
    ReviewDeskItem,
    | 'snoozedUntil'
    | 'lastReviewedSha'
    | 'lastReviewedAt'
    | 'headSha'
    | 'approvedByMe'
    | 'todos'
    | 'reasons'
    | 'draft'
  >,
  now: number,
): ReviewLane {
  if (x.snoozedUntil !== null && x.snoozedUntil > now) return 'snoozed';
  const marked = x.lastReviewedSha !== null;
  const reviewedThis = marked && sameSha(x.lastReviewedSha, x.headSha);
  const askedSinceMark =
    x.lastReviewedAt !== null && x.todos.some((t) => t.createdAt > x.lastReviewedAt!);
  if (marked && !reviewedThis) return 'changed';
  if (x.approvedByMe) return askedSinceMark ? 'needs_you' : 'approved';
  if (reviewedThis) return askedSinceMark ? 'needs_you' : 'waiting';
  if (!x.reasons.some((r) => ASKING.has(r))) return 'mentioned';
  if (x.draft && !x.reasons.includes('directly_addressed')) return 'waiting';
  return 'needs_you';
}

const LANE_ORDER: Record<ReviewLane, number> = {
  needs_you: 0,
  changed: 1,
  mentioned: 2,
  waiting: 3,
  approved: 4,
  snoozed: 5,
};

export class ReviewDeskService {
  private readonly now: () => number;
  private items = new Map<string, RawItem>();
  private readonly approvals = new Map<string, Approvals>();
  private fetchedAt: number | null = null;
  private errors: string[] = [];
  private lastPollAt: number | null = null;
  /** Pending to-do ids of the last poll, per project: a change in a polled project triggers a re-read. */
  private todoIds = new Map<number, string>();
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private hookTimer: NodeJS.Timeout | undefined;
  private notifiedKeys = new Set<string>();
  private firstLoad = true;
  private stopped = false;

  constructor(private readonly d: ReviewDeskDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Starts the poll loop. It checks the switches itself on every tick, so a Settings change applies at once. */
  start(): void {
    if (this.pollTimer) return;
    this.stopped = false;
    const tick = () => {
      void this.pollTick().finally(() => {
        if (!this.stopped) this.pollTimer = setTimeout(tick, REVIEW_POLL_MS);
      });
    };
    this.pollTimer = setTimeout(tick, 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.hookTimer) clearTimeout(this.hookTimer);
    this.pollTimer = undefined;
    this.hookTimer = undefined;
  }

  private enabled(): boolean {
    return this.d.config.getGlobalStored().features.reviews && !!this.d.config.getReviewerToken();
  }

  private client(): GitlabClient | null {
    const token = this.d.config.getReviewerToken();
    const host = this.d.config.getGlobalStored().gitlab.host;
    return token && host ? new GitlabClient(host, token, this.d.http) : null;
  }

  // ───────────────────────────── coverage ─────────────────────────────

  private deliveries(): Deliveries {
    return this.d.config.getState<Deliveries>(DELIVERIES) ?? {};
  }

  /** A configured repo for this GitLab project, if any. */
  private repoFor(projectId: number): string | null {
    return this.d.config.listRepos().find((r) => r.gitlab.projectId === projectId)?.id ?? null;
  }

  sourceFor(projectId: number, deliveries = this.deliveries()): ReviewSource {
    const repoId = this.repoFor(projectId);
    const last = deliveries[String(projectId)] ?? null;
    const fresh = last !== null && this.now() - last < REVIEW_WEBHOOK_FRESH_MS;
    if (fresh) return { via: 'webhook', reason: null, repoId, lastDeliveryAt: last };
    return {
      via: 'poll',
      reason: last !== null ? 'stale_delivery' : repoId ? 'no_delivery' : 'not_configured',
      repoId,
      lastDeliveryAt: last,
    };
  }

  // ───────────────────────────── webhooks ─────────────────────────────

  /**
   * Any authenticated delivery (a configured repo's hook, or `POST /webhook/~reviews`). Records the project as live and
   * re-reads the desk soon when the event may concern me. Never throws.
   */
  onWebhook(projectId: number | undefined, ev: NormalizedEvent, viaReviewsHook = false): void {
    try {
      if (!projectId) return;
      const t = this.now();
      const all = this.deliveries();
      all[String(projectId)] = t;
      this.d.config.setState(DELIVERIES, all);
      if (viaReviewsHook) this.d.config.setState(HOOK_DELIVERY, t);
      if (!this.enabled()) return;
      if (this.concernsMe(projectId, ev)) this.scheduleRefresh();
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'reviews webhook handling failed');
    }
  }

  private concernsMe(projectId: number, ev: NormalizedEvent): boolean {
    const me = reviewerIdentity(this.d.config)?.username;
    const iid = ev.kind === 'merge_request' ? ev.iid : ev.kind === 'note' ? ev.mrIid : undefined;
    if (iid !== undefined && this.items.has(keyOf(projectId, iid))) return true;
    if (ev.kind === 'note') {
      if (!me || ev.system || ev.mrIid === undefined) return false;
      const re = new RegExp(
        `(^|[^\\w.-])@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`,
        'i',
      );
      return re.test(ev.body);
    }
    // An MR opened or updated may have just put me on its reviewer list (the payload's list is not normalized).
    return ev.kind === 'merge_request' && (ev.action === 'open' || ev.action === 'update');
  }

  private scheduleRefresh(): void {
    if (this.hookTimer) clearTimeout(this.hookTimer);
    this.hookTimer = setTimeout(() => {
      this.hookTimer = undefined;
      void this.refresh().catch(() => undefined);
    }, WEBHOOK_DEBOUNCE_MS);
  }

  // ───────────────────────────── poll ─────────────────────────────

  /**
   * One cheap `GET /todos`. A re-read follows only when a project that NO webhook reaches has new or gone to-dos (a
   * webhook project refreshes itself), or when the desk has not been read for `SAFETY_REFRESH_MS`.
   */
  private async pollTick(): Promise<void> {
    if (!this.enabled()) return;
    const global = this.d.config.getGlobalStored();
    const stale = this.fetchedAt === null || this.now() - this.fetchedAt > SAFETY_REFRESH_MS;
    if (!global.reviews.poll) {
      if (stale) await this.refresh().catch(() => undefined);
      return;
    }
    const client = this.client();
    if (!client) return;
    try {
      const todos = await this.paginate(client, '/todos', {
        state: 'pending',
        type: 'MergeRequest',
      });
      this.lastPollAt = this.now();
      const byProject = new Map<number, number[]>();
      for (const t of todos) {
        const pid = int(rec(rec(t).target).project_id) ?? int(rec(rec(t).project).id);
        const id = int(rec(t).id);
        if (!pid || !id) continue;
        byProject.set(pid, [...(byProject.get(pid) ?? []), id]);
      }
      const deliveries = this.deliveries();
      let changed = false;
      const seen = new Set<number>();
      for (const [pid, ids] of byProject) {
        seen.add(pid);
        const sig = ids.sort((a, b) => a - b).join(',');
        if (this.todoIds.get(pid) !== sig && this.sourceFor(pid, deliveries).via === 'poll') {
          changed = true;
        }
        this.todoIds.set(pid, sig);
      }
      for (const pid of [...this.todoIds.keys()]) {
        if (seen.has(pid)) continue;
        if (this.sourceFor(pid, deliveries).via === 'poll') changed = true;
        this.todoIds.delete(pid);
      }
      if (changed || stale) await this.refresh();
      else this.d.bus?.emit({ type: 'reviews.changed' });
    } catch (e) {
      this.errors = [this.reason(e, 'To-do check')];
      this.d.bus?.emit({ type: 'reviews.changed' });
    }
  }

  // ───────────────────────────── full read ─────────────────────────────

  /** Re-reads the desk. Concurrent calls share one read; a call during a read queues exactly one more. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.read()
      .finally(() => {
        this.inFlight = null;
        this.d.bus?.emit({ type: 'reviews.changed' });
        if (this.rerun) {
          this.rerun = false;
          void this.refresh();
        }
      })
      .catch(() => undefined);
    this.d.bus?.emit({ type: 'reviews.changed' });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    const client = this.client();
    if (!client) {
      this.errors = this.d.config.getGlobalStored().gitlab.host
        ? ['Save a personal GitLab token to see your reviews.']
        : ['Set the GitLab host in Settings > Connections first.'];
      return;
    }
    const errors: string[] = [];
    const next = new Map<string, RawItem>();
    const paths = new Map<number, string>();

    const [mrsR, todosR] = await Promise.allSettled([
      this.paginate(client, '/merge_requests', {
        scope: 'reviews_for_me',
        state: 'opened',
        order_by: 'updated_at',
      }),
      this.paginate(client, '/todos', { state: 'pending', type: 'MergeRequest' }),
    ]);

    if (mrsR.status === 'fulfilled') {
      for (const raw of mrsR.value) {
        const m = mapMr(raw, null);
        if (!m) continue;
        paths.set(m.projectId, m.projectPath);
        next.set(m.key, { ...m, reviewer: true, todos: [] });
      }
    } else errors.push(this.reason(mrsR.reason, 'Review requests'));

    if (todosR.status === 'fulfilled') {
      for (const raw of todosR.value) {
        const t = rec(raw);
        const id = int(t.id);
        const project = rec(t.project);
        const path = str(project.path_with_namespace);
        const m = mapMr(t.target, path);
        const createdAt = time(t.created_at);
        if (!id || !m || createdAt === null) continue;
        paths.set(m.projectId, m.projectPath);
        const todo: ReviewTodo = {
          id,
          action: str(t.action_name) ?? 'mentioned',
          author: str(rec(t.author).username),
          body: plain(str(t.body)),
          createdAt,
        };
        const have = next.get(m.key);
        if (have) have.todos.push(todo);
        else next.set(m.key, { ...m, reviewer: false, todos: [todo] });
      }
    } else errors.push(this.reason(todosR.reason, 'To-dos'));

    // Both reads failed: keep what we had rather than emptying the desk.
    if (mrsR.status === 'rejected' && todosR.status === 'rejected') {
      this.errors = errors;
      return;
    }

    await this.readApprovals(client, [...next.values()], errors);
    rememberProjectPaths(this.d.config, paths);
    this.items = next;
    this.fetchedAt = this.now();
    this.errors = errors;
    this.notifyNew();
  }

  /** Approvals per MR, re-read only when the MR changed since the last read (`updated_at`). */
  private async readApprovals(client: GitlabClient, items: RawItem[], errors: string[]) {
    const todo = items
      .filter(
        (i) =>
          this.approvals.get(i.key)?.updatedAt !== i.updatedAt || !this.approvals.get(i.key)?.ok,
      )
      .slice(0, APPROVALS_MAX);
    let failed = 0;
    const run = async (i: RawItem) => {
      try {
        const res = await this.get(
          client,
          `/projects/${i.projectId}/merge_requests/${i.iid}/approvals`,
        );
        const j = rec(res.json);
        const approvedBy = Array.isArray(j.approved_by)
          ? j.approved_by
              .map((a) => str(rec(rec(a).user).username))
              .filter((u): u is string => u !== null)
          : [];
        const left = typeof j.approvals_left === 'number' ? Math.max(0, j.approvals_left) : null;
        this.approvals.set(i.key, { updatedAt: i.updatedAt, approvedBy, left, ok: true });
      } catch {
        failed++;
        this.approvals.set(i.key, {
          updatedAt: i.updatedAt,
          approvedBy: [],
          left: null,
          ok: false,
        });
      }
    };
    for (let k = 0; k < todo.length; k += APPROVALS_CONCURRENCY) {
      await Promise.all(todo.slice(k, k + APPROVALS_CONCURRENCY).map(run));
    }
    if (failed > 0) errors.push(`Approvals of ${failed} merge request(s) could not be read.`);
    const keep = new Set(items.map((i) => i.key));
    for (const k of [...this.approvals.keys()]) if (!keep.has(k)) this.approvals.delete(k);
  }

  /** A push notification for MRs that newly need me (never on the first read after start). */
  private notifyNew(): void {
    const view = this.view().items.filter((i) => i.lane === 'needs_you');
    const fresh = view.filter((i) => !this.notifiedKeys.has(`${i.key}@${i.todos.length}`));
    for (const i of view) this.notifiedKeys.add(`${i.key}@${i.todos.length}`);
    if (this.firstLoad) {
      this.firstLoad = false;
      return;
    }
    for (const i of fresh.slice(0, 3)) {
      const by = i.todos.at(-1)?.author ?? i.author;
      const asked = i.reasons.includes('mentioned') && !i.reasons.some((r) => ASKING.has(r));
      const candidate: Candidate = {
        event: 'reviewRequested',
        key: `review:${i.key}:${i.todos.length}`,
        ttlMs: 6 * 3_600_000,
        title: asked ? `${by ?? 'Someone'} mentioned you` : `Review: ${i.projectPath}!${i.iid}`,
        body: i.title,
        url: `/reviews?open=${encodeURIComponent(i.key)}`,
        tag: `review-${i.key}`,
        repoId: null,
        subject: null,
      };
      this.d.notifier?.notifyCockpit(candidate);
    }
  }

  // ───────────────────────────── view ─────────────────────────────

  view(): ReviewDesk {
    const now = this.now();
    const me = reviewerIdentity(this.d.config)?.username ?? null;
    const marks = this.d.config.getState<Marks>(MARKS) ?? {};
    const snoozes = this.d.config.getState<Snoozes>(SNOOZES) ?? {};
    const deliveries = this.deliveries();
    const items: ReviewDeskItem[] = [...this.items.values()].map((r) => {
      const a = this.approvals.get(r.key);
      const reasons = new Set<ReviewReason>();
      if (r.reviewer) reasons.add('reviewer');
      for (const t of r.todos) {
        const k = t.action as ReviewReason;
        if (
          [
            'review_requested',
            'directly_addressed',
            'mentioned',
            'approval_required',
            'assigned',
          ].includes(k)
        )
          reasons.add(k);
      }
      if (reasons.size === 0) reasons.add('mentioned');
      const todos = [...r.todos].sort((x, y) => x.createdAt - y.createdAt);
      const mark = marks[r.key];
      const until = snoozes[r.key] ?? null;
      const base = {
        key: r.key,
        repoId: extRepoId(r.projectId),
        projectId: r.projectId,
        projectPath: r.projectPath,
        iid: r.iid,
        title: r.title,
        author: r.author,
        authorName: r.authorName,
        webUrl: r.webUrl,
        sourceBranch: r.sourceBranch,
        targetBranch: r.targetBranch,
        draft: r.draft,
        hasConflicts: r.hasConflicts,
        mergeStatus: r.mergeStatus,
        labels: r.labels,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        headSha: r.headSha,
        notes: r.notes,
        reasons: [...reasons],
        todos,
        askedAt: todos[0]?.createdAt ?? r.createdAt,
        approvedByMe: a?.ok ? (me ? a.approvedBy.some((u) => lower(u) === lower(me)) : null) : null,
        approvedBy: a?.approvedBy ?? [],
        approvalsLeft: a?.ok ? a.left : null,
        lastReviewedSha: mark?.sha ?? null,
        lastReviewedAt: mark?.at ?? null,
        snoozedUntil: until !== null && until > now ? until : null,
        source: this.sourceFor(r.projectId, deliveries),
      };
      return { ...base, lane: laneOf(base, now) };
    });
    items.sort((x, y) => LANE_ORDER[x.lane] - LANE_ORDER[y.lane] || x.askedAt - y.askedAt);
    const global = this.d.config.getGlobalStored();
    const base = global.publicBaseUrl?.replace(/\/+$/, '') ?? null;
    return {
      generatedAt: now,
      fetchedAt: this.fetchedAt,
      tokenSet: !!this.d.config.getReviewerToken(),
      username: me,
      items,
      errors: this.errors,
      refreshing: this.inFlight !== null,
      polling: {
        active: this.enabled() && global.reviews.poll,
        intervalMs: REVIEW_POLL_MS,
        lastPollAt: this.lastPollAt,
        polledItems: items.filter((i) => i.source.via === 'poll').length,
      },
      webhook: {
        url: base ? `${base}/webhook/~reviews` : null,
        secretSet: this.d.config.getReviewsWebhookSecret(false) !== undefined,
        lastDeliveryAt: this.d.config.getState<number>(HOOK_DELIVERY) ?? null,
      },
    };
  }

  // ───────────────────────────── local marks ─────────────────────────────

  mark(key: string, sha: string | null): void {
    const marks = this.d.config.getState<Marks>(MARKS) ?? {};
    if (sha === null) delete marks[key];
    else marks[key] = { sha, at: this.now() };
    this.d.config.setState(MARKS, marks);
    this.d.bus?.emit({ type: 'reviews.changed' });
  }

  snooze(key: string, until: number | null): void {
    const all = this.d.config.getState<Snoozes>(SNOOZES) ?? {};
    if (until === null) delete all[key];
    else all[key] = until;
    this.d.config.setState(SNOOZES, all);
    this.d.bus?.emit({ type: 'reviews.changed' });
  }

  /** `POST /todos/:id/mark_as_done`, the user's click only. Guarded: dry-run records it without sending. */
  async todoDone(todoId: number): Promise<{ dryRun: boolean; auditId: number }> {
    const client = this.client();
    if (!client && !this.d.config.isDryRun()) throw new Error('reviewer_token_missing');
    const out = await guardedWrite(
      { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
      {
        actor: 'user',
        action: 'reviews.todoDone',
        targetType: 'todo',
        targetId: String(todoId),
        confirmed: true,
        before: { state: 'pending' },
        after: { state: 'done' },
        reversible: false,
        run: async () => {
          const res = await client!.write('POST', `/todos/${todoId}/mark_as_done`);
          if (res.status !== 200 && res.status !== 201 && res.status !== 304) {
            throw new Error(`gitlab_${res.status}`);
          }
          return true;
        },
      },
    );
    if (!out.dryRun) {
      for (const i of this.items.values()) i.todos = i.todos.filter((t) => t.id !== todoId);
      this.d.bus?.emit({ type: 'reviews.changed' });
    }
    return { dryRun: out.dryRun, auditId: out.audit.id };
  }

  // ───────────────────────────── token ─────────────────────────────

  tokenStatus(): ReviewTokenStatus {
    const id = reviewerIdentity(this.d.config);
    const set = !!this.d.config.getReviewerToken();
    return {
      tokenSet: set,
      username: set ? (id?.username ?? null) : null,
      name: set ? (id?.name ?? null) : null,
      scopes: set ? (id?.scopes ?? []) : [],
      canWrite: set && !!id && (id.scopes.length === 0 || id.scopes.includes('api')),
      expiresAt: set ? (id?.expiresAt ?? null) : null,
    };
  }

  /**
   * Checks a token against GitLab (`GET /user`, then `GET /personal_access_tokens/self` for scopes), then saves it.
   * Throws `Error('<code>')` with a plain message on failure: nothing is saved then.
   */
  async saveToken(token: string | null): Promise<ReviewTokenStatus> {
    if (token === null) {
      this.d.config.setReviewerToken(null);
      setReviewerIdentity(this.d.config, undefined);
      this.items.clear();
      this.approvals.clear();
      this.fetchedAt = null;
      this.d.bus?.emit({ type: 'reviews.changed' });
      return this.tokenStatus();
    }
    const host = this.d.config.getGlobalStored().gitlab.host;
    if (!host) throw new TokenCheckError('Set the GitLab host in Settings > Connections first.');
    const client = new GitlabClient(host, token, this.d.http);
    const user = await this.get(client, '/user').catch((e: unknown) => {
      throw new TokenCheckError(
        e instanceof GitlabReadError && (e.status === 401 || e.status === 403)
          ? 'GitLab refused this token (wrong, expired or revoked).'
          : 'GitLab could not be reached to check the token.',
      );
    });
    const u = rec(user.json);
    const username = str(u.username);
    if (!username) throw new TokenCheckError('GitLab did not say whose token this is.');
    const self = await this.get(client, '/personal_access_tokens/self').catch(() => null);
    const s = rec(self?.json);
    const scopes = Array.isArray(s.scopes)
      ? s.scopes.filter((x): x is string => typeof x === 'string')
      : [];
    if (scopes.length > 0 && !scopes.some((x) => x === 'api' || x === 'read_api')) {
      throw new TokenCheckError(
        'This token needs the read_api scope (or api to comment and approve).',
      );
    }
    const identity: ReviewerIdentity = {
      username,
      name: str(u.name),
      scopes,
      expiresAt: str(s.expires_at),
    };
    this.d.config.setReviewerToken(token);
    setReviewerIdentity(this.d.config, identity);
    this.firstLoad = true;
    void this.refresh();
    return this.tokenStatus();
  }

  /** Creates the Reviews webhook secret (or returns it) for the user to paste into GitLab. */
  webhookSecret(): string {
    return this.d.config.getReviewsWebhookSecret(true)!;
  }

  // ───────────────────────────── http ─────────────────────────────

  private async get(client: GitlabClient, path: string): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await client.get(path);
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabReadError(undefined, 'network');
      throw e;
    }
    if (res.status !== 200) throw new GitlabReadError(res.status, 'status');
    return res;
  }

  private async paginate(
    client: GitlabClient,
    path: string,
    params: Record<string, string>,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ ...params, per_page: '100', page: String(page) });
      const res = await this.get(client, `${path}?${qs.toString()}`);
      if (!Array.isArray(res.json)) throw new GitlabReadError(res.status, 'shape');
      out.push(...(res.json as unknown[]));
      const nextPage = res.headers['x-next-page'];
      const n = Array.isArray(nextPage) ? nextPage[0] : nextPage;
      if (!n || res.json.length < 100) break;
    }
    return out;
  }

  private reason(e: unknown, what: string): string {
    if (e instanceof GitlabReadError) {
      if (e.status === 401) return `${what}: GitLab refused the token (expired or revoked?).`;
      if (e.status === 403) return `${what}: the token may not read this (needs read_api).`;
      if (e.status === 429) return `${what}: GitLab is rate limiting; trying again later.`;
      if (e.kind === 'network') return `${what}: GitLab could not be reached.`;
      return `${what}: GitLab answered ${e.status ?? 'unexpectedly'}.`;
    }
    return `${what}: could not be read.`;
  }
}

export class GitlabReadError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly kind: 'network' | 'status' | 'shape',
  ) {
    super(`gitlab read failed (${status ?? kind})`);
    this.name = 'GitlabReadError';
  }
}

export class TokenCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCheckError';
  }
}
