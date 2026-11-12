import { desc, eq } from 'drizzle-orm';
import {
  formatDuration,
  KpiSnapshotDataSchema,
  type AssignedAtOverrideResult,
  type AuditEntry,
  type GlobalConfigStored,
  type Json,
  type KpiCardRow,
  type KpiCardsResponse,
  type KpiFocusResponse,
  type KpiHistoryItem,
  type KpiReport,
  type KpiScorecard,
  type KpiSnapshotData,
  type SyncStatus,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import { newUndoToken } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { cards, kpiSnapshots, links, mrs, settings } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { loadTimingNotes, rowToMr } from './healthReport';
import {
  advanceNotices,
  buildCardRow,
  buildScorecard,
  historyItem,
  isOpenTimer,
  monthBounds,
  monthAsOf,
  monthReviewLatency,
  noticeKey,
  slaNotices,
  todaysFocus,
  type KpiCardInput,
  type KpiMrInput,
  type KpiRowConfig,
} from './kpiEngine';
import { scorecardCsv, scorecardMarkdown } from './kpiExport';
import { deriveMrTiming, monthOf, type LatencyInput } from './mrTiming';
import type { Notifier } from './notifier';
import {
  researchReminderCandidate,
  slaBreachCandidate,
  slaSummaryCandidate,
  slaWarnCandidate,
  type Candidate,
} from './notificationRules';
import { researchQuotaStatus, resolveAssignedAt, sameCardType } from './slaEngine';
import { normalizeNotionId } from './notionUrl';
import { mrKey } from './syncHealthEngine';
import type { UndoHandler } from './undoEngine';
import { isVersionMr } from './versionMr';

/**
 * KPI service: serves scorecards from the local cache, freezes finished months and sends the SLA
 * and research pushes. Reads the cache only, and never calls GitLab or Notion.
 *
 * Whose cards: not archived, and either assigned to me at the last sync or given a manual assigned-at.
 */

export interface KpiServiceDeps {
  config: Pick<ConfigStore, 'getGlobalStored' | 'listRepos'>;
  store: AppDb;
  audit: AuditWriter;
  notifier: Pick<Notifier, 'notifyKpi'>;
  bus?: EventBus;
  /** The poller's status: pushes and freezes wait for a cache that reflects the sources. */
  syncStatus: () => SyncStatus;
  log: Logger;
  now?: () => number;
  tickMs?: number;
}

const TICK_MS = 60_000;
const STATE_KEY = 'notify.kpi.state';
// More new notices than this at once are sent as ONE summary, per event.
const MAX_INDIVIDUAL = 3;
const HISTORY_MONTHS = 24;
/** Accepts a little clock skew and a same-day typo. Assignment in the real future means nothing. */
const FUTURE_SLACK_MS = 60_000;
const ASSIGNED_AT_ACTION = 'card.assignedAt';

interface NoticeState {
  warn: string[] | null;
  breach: string[] | null;
  /** The month whose research reminder went out. */
  research: string | null;
}

type CardDbRow = typeof cards.$inferSelect;

const manualOf = (v: unknown): { assignedAtManual: number | null } | null => {
  if (typeof v !== 'object' || v === null || !('assignedAtManual' in v)) return null;
  const m = (v as { assignedAtManual: unknown }).assignedAtManual;
  return m === null || typeof m === 'number' ? { assignedAtManual: m } : null;
};

export class KpiService {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly d: KpiServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────────── reads ─────────────────────────────

  private rowConfig(cfg: GlobalConfigStored): KpiRowConfig {
    return {
      sla: cfg.sla,
      readyStatus: cfg.notion.readyStatus,
      statusGroups: cfg.notion.statusGroups,
    };
  }

  /** Every card of mine with the MRs linked to it. */
  private loadInputs(): KpiCardInput[] {
    const db = this.d.store.db;
    const prefixes = new Map(this.d.config.listRepos().map((r) => [r.id, r.versionBranchPrefix]));
    const mrBy = new Map(
      db
        .select()
        .from(mrs)
        .all()
        .map((m) => [mrKey(m.repoId, m.iid), m] as const),
    );

    const linked = new Map<string, KpiMrInput[]>();
    for (const l of db.select().from(links).all()) {
      const m = mrBy.get(mrKey(l.repoId, l.mrIid));
      if (!m) continue;
      const prefix = prefixes.get(m.repoId);
      const input: KpiMrInput = {
        repoId: m.repoId,
        iid: m.iid,
        state: m.state as KpiMrInput['state'],
        createdAt: m.createdAt,
        webUrl: m.webUrl,
        conflict: l.conflict,
        isVersionMr: prefix !== undefined && isVersionMr(m, prefix),
      };
      const list = linked.get(l.cardId);
      if (list) list.push(input);
      else linked.set(l.cardId, [input]);
    }

    return db
      .select()
      .from(cards)
      .where(eq(cards.archived, false))
      .all()
      .filter((c) => c.assignedToMe || c.assignedAtManual !== null)
      .map((c) => ({
        id: c.id,
        title: c.title,
        url: c.url,
        status: c.status,
        type: c.type,
        estimationStart: c.estimationStart,
        assignedAtManual: c.assignedAtManual,
        assignedAtProperty: c.assignedAtProperty,
        assignedAtFirstSeen: c.assignedAtFirstSeen,
        assignedAtApprox: c.assignedAtApprox,
        point: c.point,
        mrs: linked.get(c.id) ?? [],
      }));
  }

  private buildRows(
    inputs: readonly KpiCardInput[],
    cfg: GlobalConfigStored,
    asOf: number,
  ): KpiCardRow[] {
    const config = this.rowConfig(cfg);
    return inputs.flatMap((c) => buildCardRow(c, config, asOf) ?? []);
  }

  /** My non-version MRs, or everyone's when I am not configured, with their first reviewer response. */
  private loadLatencyInputs(cfg: GlobalConfigStored, now: number): LatencyInput[] {
    const repos = new Map(this.d.config.listRepos().map((r) => [r.id, r]));
    const notes = loadTimingNotes(this.d.store);
    const me = cfg.gitlab.myUsername?.toLowerCase();
    return this.d.store.db
      .select()
      .from(mrs)
      .all()
      .filter((row) => me === undefined || row.author?.toLowerCase() === me)
      .map((row) => {
        const m = rowToMr(row);
        const repo = repos.get(m.repoId);
        const timing = deriveMrTiming(m, notes.get(mrKey(m.repoId, m.iid)) ?? [], {
          now,
          reviewers: repo?.reviewers ?? [],
          me: cfg.gitlab.myUsername,
          thresholds: cfg.mrTiming,
        });
        return {
          state: m.state,
          draft: m.draft,
          isVersionMr: repo !== undefined && isVersionMr(m, repo.versionBranchPrefix),
          createdAt: m.createdAt,
          firstReviewerResponseAt: timing.firstReviewerResponseAt,
        };
      });
  }

  /** A month computed from the cache right now. This is also exactly what a freeze stores. */
  private compute(month: string, now: number): KpiSnapshotData {
    const cfg = this.d.config.getGlobalStored();
    const asOf = monthAsOf(month, now);
    const rows = this.buildRows(this.loadInputs(), cfg, asOf).filter((r) => r.month === month);
    return {
      rows,
      scorecard: buildScorecard({
        month,
        asOf,
        now,
        rows,
        sla: cfg.sla,
        reviewLatency: monthReviewLatency(month, asOf, this.loadLatencyInputs(cfg, now)),
      }),
    };
  }

  private readSnapshot(month: string): { data: KpiSnapshotData; frozenAt: number } | null {
    const row = this.d.store.db
      .select()
      .from(kpiSnapshots)
      .where(eq(kpiSnapshots.month, month))
      .get();
    if (!row) return null;
    const parsed = KpiSnapshotDataSchema.safeParse(row.data);
    if (!parsed.success) {
      this.d.log.warn({ month }, 'KPI snapshot unreadable: showing the month as computed');
      return null;
    }
    return { data: parsed.data, frozenAt: row.frozenAt };
  }

  /** Throws 400 on a month that has not begun. */
  private resolveMonth(month: string | undefined, now: number): string {
    const current = monthOf(now);
    const m = month ?? current;
    if (m > current) {
      throw new ActionError(400, 'month_in_future', 'That month has not begun');
    }
    return m;
  }

  private history(): KpiHistoryItem[] {
    const out: KpiHistoryItem[] = [];
    for (const row of this.d.store.db
      .select()
      .from(kpiSnapshots)
      .orderBy(desc(kpiSnapshots.month))
      .limit(HISTORY_MONTHS)
      .all()) {
      const parsed = KpiSnapshotDataSchema.safeParse(row.data);
      if (parsed.success) {
        out.push(historyItem(row.month, row.frozenAt, parsed.data.scorecard));
      }
    }
    return out;
  }

  report(monthParam: string | undefined): KpiReport {
    const now = this.now();
    const month = this.resolveMonth(monthParam, now);
    const snapshot = this.readSnapshot(month);
    const cfg = this.d.config.getGlobalStored();
    return {
      month,
      current: month === monthOf(now),
      frozen: snapshot !== null,
      frozenAt: snapshot?.frozenAt ?? null,
      meConfigured: Boolean(cfg.gitlab.myUsername) || cfg.notion.assigneeAliases.length > 0,
      scorecard: snapshot?.data.scorecard ?? this.compute(month, now).scorecard,
      history: this.history(),
    };
  }

  cardsTable(monthParam: string | undefined): KpiCardsResponse {
    const now = this.now();
    const month = this.resolveMonth(monthParam, now);
    const current = month === monthOf(now);
    const snapshot = this.readSnapshot(month);
    let rows: KpiCardRow[];
    if (snapshot) {
      rows = snapshot.data.rows;
    } else if (current) {
      // This month's cards, plus last month's still-actionable open timers (work carried over). Older leftovers
      // cannot change this month's scorecard.
      const previous = monthOf(new Date(monthBounds(month).start - 1).getTime());
      rows = this.buildRows(this.loadInputs(), this.d.config.getGlobalStored(), now).filter(
        (r) => r.month === month || (r.month === previous && isOpenTimer(r)),
      );
    } else {
      rows = this.compute(month, now).rows;
    }
    return {
      month,
      current,
      frozen: snapshot !== null,
      frozenAt: snapshot?.frozenAt ?? null,
      rows,
    };
  }

  /** What the notification center needs to tell whether an SLA or research notice still stands. Cache only. */
  noticeFacts(now: number = this.now()): {
    timers: Map<string, { open: boolean; deadline: number | null }>;
    month: string;
    researchMet: boolean;
  } {
    const cfg = this.d.config.getGlobalStored();
    const rows = this.buildRows(this.loadInputs(), cfg, now);
    const month = monthOf(now);
    const quota = researchQuotaStatus({
      count: rows.filter((r) => r.month === month && sameCardType(r.type, cfg.sla.researchType))
        .length,
      required: cfg.sla.researchMinPerMonth,
      month,
      now,
    });
    return {
      timers: new Map(
        rows.map((r) => [r.cardId, { open: isOpenTimer(r), deadline: r.sla.deadline ?? null }]),
      ),
      month,
      researchMet: quota.count >= quota.required,
    };
  }

  focus(limit: number): KpiFocusResponse {
    const now = this.now();
    const rows = todaysFocus(
      this.buildRows(this.loadInputs(), this.d.config.getGlobalStored(), now),
      monthOf(now),
    );
    return { generatedAt: now, rows: rows.slice(0, limit), total: rows.length };
  }

  export(
    monthParam: string | undefined,
    format: 'md' | 'csv',
  ): { fileName: string; contentType: string; body: string } {
    const now = this.now();
    const month = this.resolveMonth(monthParam, now);
    const snapshot = this.readSnapshot(month);
    const data = snapshot?.data ?? this.compute(month, now);
    const s: KpiScorecard = data.scorecard;
    return format === 'csv'
      ? {
          fileName: `kpi-${month}.csv`,
          contentType: 'text/csv; charset=utf-8',
          body: scorecardCsv(s, data.rows),
        }
      : {
          fileName: `kpi-${month}.md`,
          contentType: 'text/markdown; charset=utf-8',
          body: scorecardMarkdown(s, data.rows, snapshot?.frozenAt ?? null),
        };
  }

  /**
   * Each month from `since` on that has cards, as the KPI view shows it: the snapshot of a frozen month, otherwise
   * computed. For the gamification service, which must not award from anything else. `skip` months are not read.
   */
  monthlyViews(
    since: string,
    skip: ReadonlySet<string>,
    now: number = this.now(),
  ): { month: string; frozen: boolean; data: KpiSnapshotData }[] {
    const cfg = this.d.config.getGlobalStored();
    const months = new Set(this.buildRows(this.loadInputs(), cfg, now).map((r) => r.month));
    for (const row of this.d.store.db
      .select({ month: kpiSnapshots.month })
      .from(kpiSnapshots)
      .all()) {
      months.add(row.month);
    }
    const current = monthOf(now);
    return [...months]
      .filter((m) => m >= since && m <= current && !skip.has(m))
      .sort()
      .map((month) => {
        const snapshot = this.readSnapshot(month);
        return {
          month,
          frozen: snapshot !== null,
          data: snapshot?.data ?? this.compute(month, now),
        };
      });
  }

  // ───────────────────────────── manual assigned-at ─────────────────────────────

  /** Local only: nothing goes to Notion, so the global dry-run does not apply. Audited and undoable. */
  setAssignedAt(rawId: string, assignedAt: number | null): AssignedAtOverrideResult {
    const now = this.now();
    if (assignedAt !== null && assignedAt > now + FUTURE_SLACK_MS) {
      throw new ActionError(400, 'assigned_at_in_future', 'Assigned-at cannot be in the future');
    }
    const id = normalizeNotionId(rawId);
    const row = id ? this.d.store.db.select().from(cards).where(eq(cards.id, id)).get() : undefined;
    if (!row) throw new ActionError(404, 'card_not_found', 'This card is not in the local cache');
    if (row.archived) {
      throw new ActionError(409, 'card_archived', 'This card is archived or in the trash');
    }

    let auditId: number | null = null;
    if (row.assignedAtManual !== assignedAt) {
      auditId = this.writeManual(row, assignedAt, {
        action: ASSIGNED_AT_ACTION,
        undoToken: newUndoToken(),
      });
    }
    const cfg = this.d.config.getGlobalStored();
    return {
      cardId: row.id,
      assignedAt: resolveAssignedAt({
        source: cfg.sla.assignedAtSource,
        manual: assignedAt,
        property: row.assignedAtProperty,
        firstSeen: row.assignedAtFirstSeen,
        firstSeenApprox: row.assignedAtApprox,
      }),
      auditId,
    };
  }

  private writeManual(
    row: CardDbRow,
    value: number | null,
    audit: { action: string; undoToken?: string; undoOf?: number },
  ): number {
    const entry = this.d.store.db.transaction((tx) => {
      tx.update(cards).set({ assignedAtManual: value }).where(eq(cards.id, row.id)).run();
      return this.d.audit.write({
        actor: 'user',
        action: audit.action,
        targetType: 'card',
        targetId: row.id,
        before: { assignedAtManual: row.assignedAtManual },
        after: { assignedAtManual: value },
        ...(audit.undoToken ? { undoToken: audit.undoToken } : {}),
        ...(audit.undoOf ? { undoOf: audit.undoOf } : {}),
      });
    });
    this.d.bus?.emit({ type: 'cards.changed', cardIds: [row.id] });
    return entry.id;
  }

  readonly assignedAtUndoHandler: UndoHandler = {
    action: ASSIGNED_AT_ACTION,
    undo: (entry: AuditEntry) => {
      const before = manualOf(entry.before);
      const after = manualOf(entry.after);
      const id = normalizeNotionId(entry.targetId);
      const row = id
        ? this.d.store.db.select().from(cards).where(eq(cards.id, id)).get()
        : undefined;
      if (!before || !after || !row) {
        throw new ActionError(409, 'undo_unsupported', 'The audit entry has no restorable state');
      }
      if (row.assignedAtManual !== after.assignedAtManual) {
        throw new ActionError(
          409,
          'undo_conflict',
          'Cannot undo: the assigned-at of this card was changed again after this write.',
        );
      }
      const auditId = this.writeManual(row, before.assignedAtManual, {
        action: 'undo',
        undoOf: entry.id,
      });
      return Promise.resolve({ dryRun: false, auditId });
    },
  };

  // ───────────────────────────── month-end freeze ─────────────────────────────

  /**
   * Freezes every finished month that has cards and no snapshot. Idempotent twice over: months with a row are skipped,
   * and the insert cannot replace one. A month with no cards stays open, so a late sync can still fill it.
   */
  freezeFinishedMonths(now: number = this.now()): string[] {
    const cfg = this.d.config.getGlobalStored();
    const current = monthOf(now);
    const frozen = new Set(
      this.d.store.db
        .select({ month: kpiSnapshots.month })
        .from(kpiSnapshots)
        .all()
        .map((r) => r.month),
    );
    const due = new Set(
      this.buildRows(this.loadInputs(), cfg, now)
        .map((r) => r.month)
        .filter((m) => m < current && !frozen.has(m)),
    );
    const done: string[] = [];
    for (const month of [...due].sort()) {
      const data = this.compute(month, now);
      const res = this.d.store.db
        .insert(kpiSnapshots)
        .values({ month, data: data as unknown as Json, frozenAt: now })
        .onConflictDoNothing()
        .run();
      if (res.changes > 0) done.push(month);
    }
    if (done.length > 0) this.d.log.info({ months: done }, 'KPI months frozen');
    return done;
  }

  // ───────────────────────────── pushes ─────────────────────────────

  private readState(): NoticeState {
    const empty: NoticeState = { warn: null, breach: null, research: null };
    const row = this.d.store.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, STATE_KEY))
      .get();
    if (!row) return empty;
    const list = (v: unknown): string[] | null =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
    try {
      const v = JSON.parse(row.value) as Record<string, unknown>;
      return {
        warn: list(v.warn),
        breach: list(v.breach),
        research: typeof v.research === 'string' ? v.research : null,
      };
    } catch {
      return empty;
    }
  }

  private writeState(state: NoticeState, now: number): void {
    const value = JSON.stringify({ v: 1, ...state });
    this.d.store.db
      .insert(settings)
      .values({ key: STATE_KEY, value, encrypted: false, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, encrypted: false, updatedAt: now },
      })
      .run();
  }

  /**
   * SLA 80% and breach, research on day 20. Remembered in `settings`, so repeats and restarts stay quiet:
   *  - the first evaluation with cards only records what already qualifies (no flood after enabling or on a fresh DB);
   *  - a notice is remembered until it stops qualifying;
   *  - with its toggle off the memory is dropped, so re-enabling starts from a silent baseline;
   *  - the state is saved before sending, so a crash loses a push rather than repeating it.
   */
  checkPushes(now: number = this.now()): void {
    const cfg = this.d.config.getGlobalStored();
    const enabled = new Set<string>(cfg.notifications.events);
    const rows = this.buildRows(this.loadInputs(), cfg, now);
    // Nothing synced yet: wait, so the first real data set becomes the baseline.
    if (rows.length === 0) return;

    const before = this.readState();
    const notices = slaNotices(rows);
    const byKey = new Map(rows.map((r) => [noticeKey(r), r] as const));
    const out: Candidate[] = [];

    const stream = (
      event: 'slaWarn' | 'slaBreach',
      sent: string[] | null,
      current: readonly KpiCardRow[],
      one: (r: KpiCardRow) => Candidate,
    ): string[] | null => {
      if (!enabled.has(event)) return null;
      const next = advanceNotices(sent, current.map(noticeKey));
      if (next.fresh.length > MAX_INDIVIDUAL) {
        out.push(slaSummaryCandidate(event, next.fresh.length));
      } else {
        for (const k of next.fresh) out.push(one(byKey.get(k)!));
      }
      return next.sent;
    };

    const state: NoticeState = {
      warn: stream('slaWarn', before.warn, notices.warn, (r) =>
        slaWarnCandidate({
          id: r.cardId,
          title: r.title,
          deadline: r.sla.deadline ?? 0,
          percent: Math.floor((r.sla.elapsedFraction ?? 0) * 100),
          timeLeft: formatDuration(Math.max(0, r.sla.remainingMs ?? 0)),
        }),
      ),
      breach: stream('slaBreach', before.breach, notices.breach, (r) =>
        slaBreachCandidate({ id: r.cardId, title: r.title, deadline: r.sla.deadline ?? 0 }),
      ),
      research: before.research,
    };

    const month = monthOf(now);
    const quota = researchQuotaStatus({
      count: rows.filter((r) => r.month === month && sameCardType(r.type, cfg.sla.researchType))
        .length,
      required: cfg.sla.researchMinPerMonth,
      month,
      now,
    });
    if (
      cfg.kpi.researchQuota &&
      quota.reminderDue &&
      enabled.has('slaWarn') &&
      before.research !== month
    ) {
      state.research = month;
      out.push(researchReminderCandidate({ month, count: quota.count, required: quota.required }));
    }

    if (JSON.stringify(state) !== JSON.stringify(before)) this.writeState(state, now);
    if (out.length > 0) this.d.notifier.notifyKpi(out);
  }

  // ───────────────────────────── schedule ─────────────────────────────

  /**
   * One pass. Before the startup sync finishes the cache can miss MRs opened while the server was off, and a push from it
   * would be wrong. A freeze is forever, so it also needs every source's last run to have fully succeeded.
   */
  tick(): void {
    const sync = this.d.syncStatus();
    if (!sync.schedule?.catchUpDone || sync.sources.length === 0) return;
    if (sync.sources.some((s) => s.state === 'never' || s.state === 'error')) return;
    const now = this.now();
    this.checkPushes(now);
    if (sync.sources.every((s) => s.state === 'ok' || s.state === 'skipped')) {
      this.freezeFinishedMonths(now);
    }
  }

  start(): void {
    if (this.timer || this.closed) return;
    const run = () => {
      this.timer = setTimeout(() => {
        if (this.closed) return;
        try {
          this.tick();
        } catch (e) {
          this.d.log.error({ err: (e as Error).name }, 'KPI tick failed');
        }
        run();
      }, this.d.tickMs ?? TICK_MS);
      this.timer.unref();
    };
    run();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
