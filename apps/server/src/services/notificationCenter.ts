import { and, count, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  NotificationSubjectSchema,
  type Json,
  type NotificationItem,
  type NotificationLifecycle,
  type NotificationList,
  type NotificationSummary,
  type NotificationListQuery,
  type NotificationSubject,
  type PushPayload,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { jobs, mrs, notesCache, notifications } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { buildHealthReport } from './healthReport';
import type { KpiService } from './kpiService';
import {
  classify,
  readyKey,
  resolveLive,
  type KpiFact,
  type MrFact,
  type NotificationFacts,
  type NotificationFactsRow,
} from './notificationActions';
import { isMismatchRule, mismatchKey, MISMATCH_SEVERITIES } from './notificationRules';
import type { ReadyForMrService } from './readyForMr';

/**
 * The notification center: the log of what was sent, and each entry's current actions (`notificationActions.ts`).
 * Reads the local cache only. Marking as read is local too, so it is neither audited nor subject to dry-run.
 */

const RETENTION_MS = 90 * 24 * 3600 * 1000;
/** A filter that drops rows reads on, but one request never looks at more than this. The cursor continues it. */
const MAX_SCAN_PER_REQUEST = 500;
/** Agent hosts can be remote and offline: the list must not wait for one. */
const SESSIONS_TIMEOUT_MS = 2_000;
/** The tab counts and the bell look at this many of the newest rows at most. */
const SUMMARY_SCAN = 300;
const BELL_SCAN = 100;
/** Bound on "Clear stale and handled": rounds of `MAX_SCAN_PER_REQUEST` unread rows each. */
const DISMISS_ROUNDS = 20;
const SCAN_BATCH = 50;

/** Called on every send. Never throws for a caller that catches: see `Notifier.record`. */
export function recordNotification(
  store: AppDb,
  payload: PushPayload,
  subject: NotificationSubject | null,
): void {
  store.db
    .insert(notifications)
    .values({
      event: payload.event,
      title: payload.title,
      body: payload.body,
      url: payload.url,
      repoId: payload.repoId,
      subject: subject as Json | null,
      at: payload.at,
    })
    .run();
  store.db
    .delete(notifications)
    .where(lt(notifications.at, payload.at - RETENTION_MS))
    .run();
}

export interface NotificationCenterDeps {
  config: Pick<ConfigStore, 'getGlobalStored' | 'getRepoPublic' | 'listRepos'>;
  store: AppDb;
  bus: EventBus;
  log: Logger;
  kpi: Pick<KpiService, 'noticeFacts'>;
  ready: Pick<ReadyForMrService, 'list'>;
  sessions: { list(): Promise<{ id: string; state: string; waiting: boolean }[]> };
  now?: () => number;
}

type Row = typeof notifications.$inferSelect;

/** What one request reads at most once, however many batches it scans. `undefined` = not needed so far. */
interface SharedFacts {
  ready?: ReadonlySet<string> | null;
  sessions?: ReadonlyMap<string, { state: string; waiting: boolean }> | null;
  mismatches?: ReadonlySet<string> | null;
  kpi?: KpiFact | null;
}

const LIVE_MR_RANK: Record<string, number> = { opened: 3, locked: 3, merged: 2, closed: 1 };

/** `filter=actionable` is the old name of `lifecycle=needs_action`. Empty facet = no restriction. */
function matchesFacets(
  query: NotificationListQuery,
  cls: { lifecycle: NotificationLifecycle; priority: string; category: string },
): boolean {
  if (query.filter === 'actionable' && cls.lifecycle !== 'needs_action') return false;
  if (query.lifecycle.length > 0 && !query.lifecycle.includes(cls.lifecycle)) return false;
  if (query.priority.length > 0 && !query.priority.some((p) => p === cls.priority)) return false;
  if (query.category.length > 0 && !query.category.some((c) => c === cls.category)) return false;
  return true;
}

function parseSubject(value: unknown): NotificationSubject | null {
  const parsed = NotificationSubjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class NotificationCenter {
  private readonly now: () => number;

  constructor(private readonly d: NotificationCenterDeps) {
    this.now = d.now ?? Date.now;
  }

  async list(query: NotificationListQuery): Promise<NotificationList> {
    const items: NotificationItem[] = [];
    const shared: SharedFacts = {};
    const batchSize = query.limit + 1;
    let cursor = query.cursor;
    let scanned = 0;
    let exhausted = false;

    while (items.length < query.limit && scanned < MAX_SCAN_PER_REQUEST && !exhausted) {
      const batch = this.readBatch(query, cursor, batchSize);
      if (batch.length < batchSize) exhausted = true;
      if (batch.length === 0) break;
      const rows = batch.map((row) => ({ row, subject: parseSubject(row.subject) }));
      const facts = await this.loadFacts(
        rows.map((r) => r.subject),
        shared,
      );
      for (let i = 0; i < rows.length; i++) {
        const { row, subject } = rows[i]!;
        scanned += 1;
        cursor = row.id;
        const factsRow: NotificationFactsRow = {
          event: row.event,
          url: row.url,
          at: row.at,
          subject,
        };
        const live = resolveLive(factsRow, facts);
        const cls = classify(factsRow, live, facts.now);
        if (matchesFacets(query, cls)) {
          items.push({
            id: row.id,
            event: row.event as NotificationItem['event'],
            title: row.title,
            body: row.body,
            repoId: row.repoId,
            at: row.at,
            readAt: row.readAt,
            live,
            ...cls,
          });
        }
        if (items.length === query.limit) {
          // Stopped short of the batch's end: rows remain whatever the batch's size said.
          if (i < rows.length - 1) exhausted = false;
          break;
        }
      }
    }
    return { items, nextCursor: exhausted || cursor === undefined ? null : cursor };
  }

  /** Unread rows that still need you, among the newest unread ones. A bounded scan: the bell polls this. */
  async unreadNeedsAction(): Promise<number> {
    let n = 0;
    await this.scan({ unreadOnly: true, max: BELL_SCAN }, (_row, cls) => {
      if (cls.lifecycle === 'needs_action') n += 1;
    });
    return n;
  }

  /** Counts per lifecycle for the filter tabs, over the newest rows. `capped` = there were more than scanned. */
  async summary(repoId?: string): Promise<NotificationSummary> {
    const lifecycle: Record<NotificationLifecycle, number> = {
      needs_action: 0,
      stale: 0,
      handled_elsewhere: 0,
      info: 0,
    };
    const unreadLifecycle: Record<NotificationLifecycle, number> = {
      needs_action: 0,
      stale: 0,
      handled_elsewhere: 0,
      info: 0,
    };
    let unread = 0;
    let unreadNeedsAction = 0;
    const capped = await this.scan({ unreadOnly: false, repoId, max: SUMMARY_SCAN }, (row, cls) => {
      lifecycle[cls.lifecycle] += 1;
      if (row.readAt === null) {
        unread += 1;
        unreadLifecycle[cls.lifecycle] += 1;
        if (cls.lifecycle === 'needs_action') unreadNeedsAction += 1;
      }
    });
    return { lifecycle, unreadLifecycle, unread, unreadNeedsAction, capped };
  }

  /**
   * Marks read every unread row that was handled elsewhere or went stale, optionally in one repo. Local only,
   * like `markAllRead`. Repeats bounded scans until one finds nothing more to clear, so a single call clears all.
   */
  async dismissHandled(repoId?: string): Promise<number> {
    let total = 0;
    for (let round = 0; round < DISMISS_ROUNDS; round++) {
      const ids: number[] = [];
      const more = await this.scan(
        { unreadOnly: true, repoId, max: MAX_SCAN_PER_REQUEST },
        (row, cls) => {
          if (cls.lifecycle === 'handled_elsewhere' || cls.lifecycle === 'stale') ids.push(row.id);
        },
      );
      if (ids.length > 0) {
        const { changes } = this.d.store.db
          .update(notifications)
          .set({ readAt: this.now() })
          .where(and(inArray(notifications.id, ids), isNull(notifications.readAt)))
          .run();
        total += changes;
      }
      // Nothing cleared, or nothing left unvisited: the next scan would see the same rows.
      if (ids.length === 0 || !more) break;
    }
    if (total > 0) this.d.bus.emit({ type: 'notifications.changed' });
    return total;
  }

  /** Visits the newest rows with their class, up to `max`. True = rows remain that were not visited. */
  private async scan(
    opts: { unreadOnly: boolean; repoId?: string | undefined; max: number },
    visit: (row: Row, cls: ReturnType<typeof classify>) => void,
  ): Promise<boolean> {
    const shared: SharedFacts = {};
    let cursor: number | undefined;
    let scanned = 0;
    while (scanned < opts.max) {
      const size = Math.min(SCAN_BATCH, opts.max - scanned);
      const batch = this.readBatch(
        { filter: opts.unreadOnly ? 'unread' : 'all', repoId: opts.repoId },
        cursor,
        size,
      );
      if (batch.length === 0) return false;
      const rows = batch.map((row) => ({ row, subject: parseSubject(row.subject) }));
      const facts = await this.loadFacts(
        rows.map((r) => r.subject),
        shared,
      );
      for (const { row, subject } of rows) {
        const factsRow: NotificationFactsRow = {
          event: row.event,
          url: row.url,
          at: row.at,
          subject,
        };
        visit(row, classify(factsRow, resolveLive(factsRow, facts), facts.now));
        cursor = row.id;
      }
      scanned += batch.length;
      if (batch.length < size) return false;
    }
    return true;
  }

  unreadCount(): number {
    return (
      this.d.store.db
        .select({ n: count() })
        .from(notifications)
        .where(isNull(notifications.readAt))
        .get()?.n ?? 0
    );
  }

  /** False = no such notification. Already read keeps its first read time. */
  markRead(id: number): boolean {
    const db = this.d.store.db;
    const row = db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.id, id))
      .get();
    if (!row) return false;
    if (row.readAt === null) {
      db.update(notifications).set({ readAt: this.now() }).where(eq(notifications.id, id)).run();
      this.d.bus.emit({ type: 'notifications.changed' });
    }
    return true;
  }

  markAllRead(): number {
    const { changes } = this.d.store.db
      .update(notifications)
      .set({ readAt: this.now() })
      .where(isNull(notifications.readAt))
      .run();
    if (changes > 0) this.d.bus.emit({ type: 'notifications.changed' });
    return changes;
  }

  private readBatch(
    query: { filter: NotificationListQuery['filter']; repoId?: string | undefined },
    cursor: number | undefined,
    size: number,
  ): Row[] {
    return this.d.store.db
      .select()
      .from(notifications)
      .where(
        and(
          cursor !== undefined ? lt(notifications.id, cursor) : undefined,
          query.filter === 'unread' ? isNull(notifications.readAt) : undefined,
          query.repoId ? eq(notifications.repoId, query.repoId) : undefined,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(size)
      .all();
  }

  /** One read per kind of fact for the whole batch, and only for the kinds this batch is about. */
  private async loadFacts(
    subjects: readonly (NotificationSubject | null)[],
    shared: SharedFacts,
  ): Promise<NotificationFacts> {
    const of = <K extends NotificationSubject['kind']>(kind: K) =>
      subjects.filter((s): s is Extract<NotificationSubject, { kind: K }> => s?.kind === kind);
    const mrSubjects = of('mr');
    const branchSubjects = of('branch');

    const mrFacts = this.loadMrs(mrSubjects);
    const resolvedThreads = this.loadResolvedThreads(mrSubjects);
    const branchMrs = this.loadBranchMrs(branchSubjects);
    const jobFacts = this.loadJobs(of('job').map((s) => s.jobId));

    if (branchSubjects.length > 0 && shared.ready === undefined) {
      shared.ready = this.attempt('ready branches', () => {
        return new Set(this.d.ready.list().map((r) => readyKey(r.repoId, r.branch)));
      });
    }
    if (of('session').length > 0 && shared.sessions === undefined) {
      shared.sessions = await this.loadSessions();
    }
    if (of('mismatch').length > 0 && shared.mismatches === undefined) {
      shared.mismatches = this.attempt('mismatches', () => this.loadMismatches());
    }
    if ((of('card').length > 0 || of('month').length > 0) && shared.kpi === undefined) {
      shared.kpi = this.attempt('kpi', () => this.d.kpi.noticeFacts());
    }

    return {
      now: this.now(),
      mr: (repoId, iid) => mrFacts.get(`${repoId}:${iid}`) ?? null,
      repo: (repoId) => {
        const repo = this.d.config.getRepoPublic(repoId);
        return repo ? { reviewers: repo.reviewers, approvalMode: repo.approvalMode } : null;
      },
      threadResolved: (id) => resolvedThreads.has(id),
      branchMr: (repoId, branch) => branchMrs.get(readyKey(repoId, branch)) ?? null,
      job: (id) => jobFacts.get(id) ?? null,
      readyBranches: shared.ready ?? null,
      sessions: shared.sessions ?? null,
      mismatches: shared.mismatches ?? null,
      kpi: shared.kpi ?? null,
    };
  }

  private loadMrs(subjects: readonly { repoId: string; iid: number }[]): Map<string, MrFact> {
    const out = new Map<string, MrFact>();
    if (subjects.length === 0) return out;
    const rows = this.d.store.db
      .select({
        repoId: mrs.repoId,
        iid: mrs.iid,
        state: mrs.state,
        draft: mrs.draft,
        hasConflicts: mrs.hasConflicts,
        approvedBy: mrs.approvedBy,
        mergedAt: mrs.mergedAt,
        headPipeline: mrs.headPipeline,
        syncedAt: mrs.syncedAt,
      })
      .from(mrs)
      .where(
        and(
          inArray(mrs.repoId, [...new Set(subjects.map((s) => s.repoId))]),
          inArray(mrs.iid, [...new Set(subjects.map((s) => s.iid))]),
        ),
      )
      .all();
    for (const row of rows) {
      out.set(`${row.repoId}:${row.iid}`, { ...row, headPipeline: row.headPipeline ?? null });
    }
    return out;
  }

  /** Threads with resolvable notes, all of them resolved. */
  private loadResolvedThreads(subjects: readonly { discussionId: string | null }[]): Set<string> {
    const ids = [...new Set(subjects.flatMap((s) => (s.discussionId ? [s.discussionId] : [])))];
    if (ids.length === 0) return new Set();
    const rows = this.d.store.db
      .select({ id: notesCache.discussionId, resolved: notesCache.resolved })
      .from(notesCache)
      .where(and(inArray(notesCache.discussionId, ids), eq(notesCache.resolvable, true)))
      .all();
    const open = new Set(rows.filter((r) => !r.resolved).map((r) => r.id));
    return new Set(rows.filter((r) => !open.has(r.id)).map((r) => r.id));
  }

  /** The MR of a branch: a live one wins over a merged one, and that over a closed one; then the newest. */
  private loadBranchMrs(
    subjects: readonly { repoId: string; branch: string }[],
  ): Map<string, { iid: number; state: string }> {
    const out = new Map<string, { iid: number; state: string }>();
    if (subjects.length === 0) return out;
    const rows = this.d.store.db
      .select({ repoId: mrs.repoId, branch: mrs.sourceBranch, iid: mrs.iid, state: mrs.state })
      .from(mrs)
      .where(
        and(
          inArray(mrs.repoId, [...new Set(subjects.map((s) => s.repoId))]),
          inArray(mrs.sourceBranch, [...new Set(subjects.map((s) => s.branch))]),
        ),
      )
      .all();
    const rank = (state: string) => LIVE_MR_RANK[state] ?? 0;
    for (const row of rows) {
      const key = readyKey(row.repoId, row.branch);
      const best = out.get(key);
      const better =
        !best ||
        rank(row.state) > rank(best.state) ||
        (rank(row.state) === rank(best.state) && row.iid > best.iid);
      if (better) out.set(key, { iid: row.iid, state: row.state });
    }
    return out;
  }

  /** A build's QA link is noted on the build, and on its release (the only place it was noted for older builds). */
  private loadJobs(ids: readonly string[]): Map<string, { qaLinkOpenedAt: number | null }> {
    const out = new Map<string, { qaLinkOpenedAt: number | null }>();
    if (ids.length === 0) return out;
    const read = (jobIds: readonly string[]) =>
      this.d.store.db
        .select({ id: jobs.id, state: jobs.state, parentJobId: jobs.parentJobId })
        .from(jobs)
        .where(inArray(jobs.id, [...jobIds]))
        .all();
    const openedAt = (state: Record<string, Json>): number | null =>
      typeof state.qaLinkOpenedAt === 'number' ? state.qaLinkOpenedAt : null;
    const rows = read(ids);
    const parentIds = [...new Set(rows.flatMap((r) => (r.parentJobId ? [r.parentJobId] : [])))];
    const parents = new Map(
      (parentIds.length > 0 ? read(parentIds) : []).map((p) => [p.id, openedAt(p.state)] as const),
    );
    for (const row of rows) {
      const parent = row.parentJobId ? (parents.get(row.parentJobId) ?? null) : null;
      out.set(row.id, { qaLinkOpenedAt: openedAt(row.state) ?? parent });
    }
    return out;
  }

  private loadMismatches(): Set<string> {
    const report = buildHealthReport(
      this.d.store,
      this.d.config.listRepos(),
      this.d.config.getGlobalStored(),
      this.now(),
    );
    return new Set(
      report.verdicts
        .filter((v) => isMismatchRule(v.ruleId) && MISMATCH_SEVERITIES.has(v.severity))
        .map((v) => mismatchKey(v)),
    );
  }

  private async loadSessions(): Promise<ReadonlyMap<
    string,
    { state: string; waiting: boolean }
  > | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SESSIONS_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const sessions = await Promise.race([this.d.sessions.list(), timeout]);
      return sessions ? new Map(sessions.map((s) => [s.id, s] as const)) : null;
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'notification center: sessions unreadable');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One section failing must not take the list down: its rows show as unknown. */
  private attempt<T>(what: string, read: () => T): T | null {
    try {
      return read();
    } catch (e) {
      this.d.log.warn({ what, err: (e as Error).name }, 'notification center: section unreadable');
      return null;
    }
  }
}
