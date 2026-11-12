import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { z } from 'zod';
import {
  BADGE_IDS,
  BadgeIdSchema,
  GamificationReleaseSchema,
  normalizeName,
  type AppEvent,
  type BadgeId,
  type GamificationBadge,
  type GamificationRelease,
  type GamificationReport,
  type Json,
  type SyncStatus,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { cards, gamification, mrs, notesCache } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import {
  APPROVALS_FOR_BADGE,
  earnsBugSlayer,
  earnsResearcher,
  hasOutsideComment,
  levelFor,
  MAX_ISSUE_XP_PER_DECK,
  reviewStreak,
  localDay,
  streakOf,
  tallySlaDays,
  XP,
  type SlaDayTally,
} from './gamificationRules';
import { buildHealthReport } from './healthReport';
import type { KpiService } from './kpiService';
import { monthOf } from './mrTiming';
import { isMismatchRule, MISMATCH_SEVERITIES } from './notificationRules';
import { isVersionMr } from './versionMr';

/**
 * Gamification. One ledger, `gamification`, whose UNIQUE `dedupe_key` is what makes every award idempotent:
 * replays and restarts hit the same key and change nothing. Totals and streaks are derived on read.
 *
 * Nothing is awarded from `mr.activity`, which has no id. Awards come from the cache, which only holds real writes (a
 * dry-run changes neither Notion nor the cache), re-read after each sync, and from `release.done`.
 *
 *   rule             source                      key
 *   card ready       cards table                 xp:card_ready:<cardId>             once per card, for life
 *   approval         mrs.approved_by             xp:approval:<repoId>:<iid>:<user>
 *   SLA met          KPI rows                    xp:sla_met:<cardId>
 *   release          release.done, not dry-run   xp:release:<jobId>
 *
 * What exists at the first evaluation of a source is recorded with no XP (`baseline`), so that connecting a board or a
 * repo with history does not pay out that history.
 */

export interface GamificationDeps {
  config: Pick<ConfigStore, 'getGlobalStored' | 'listRepos'>;
  store: AppDb;
  kpi: Pick<KpiService, 'monthlyViews'>;
  bus: EventBus;
  syncStatus: () => SyncStatus;
  log: Logger;
  now?: () => number;
  debounceMs?: number;
}

const DEBOUNCE_MS = 1000;
const HISTORY_RELEASES = 20;

const KIND = {
  xp: 'xp',
  badge: 'badge',
  release: 'release',
  slaDay: 'sla_day',
  baseline: 'baseline',
  monthDone: 'month_done',
} as const;
type Kind = (typeof KIND)[keyof typeof KIND];

const APPROVAL_PREFIX = 'xp:approval:';
const KPI_BASELINE_KEY = 'baseline:kpi';

const KpiBaselineSchema = z.object({ month: z.string(), day: z.string() });
const SlaDaySchema = z.object({ day: z.string(), breached: z.number() });
const BadgeDataSchema = z.object({ badge: BadgeIdSchema });
const ReleaseDataSchema = GamificationReleaseSchema.omit({ xpEarned: true, streak: true });

type ReleaseEvent = Extract<AppEvent, { type: 'release.done' }>;
type SourceState = SyncStatus['sources'][number]['state'];

export class GamificationService {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly d: GamificationDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────────── ledger ─────────────────────────────

  /** False when the key already exists: that is the whole of the idempotency. */
  private insert(kind: Kind, key: string, amount: number, data: Json | null, at: number): boolean {
    return (
      this.d.store.db
        .insert(gamification)
        .values({ kind, dedupeKey: key, amount, data, at })
        .onConflictDoNothing()
        .run().changes > 0
    );
  }

  private row(key: string) {
    return this.d.store.db.select().from(gamification).where(eq(gamification.dedupeKey, key)).get();
  }

  private badge(badge: BadgeId, instance: string, at: number): boolean {
    return this.insert(KIND.badge, `badge:${badge}:${instance}`, 0, { badge, instance }, at);
  }

  /** XP, or during a source's first evaluation the same key with none. */
  private award(key: string, amount: number, baseline: boolean, at: number): boolean {
    return baseline
      ? this.insert(KIND.baseline, key, 0, null, at)
      : this.insert(KIND.xp, key, amount, null, at);
  }

  // ───────────────────────────── release ─────────────────────────────

  private mismatchesFor(repoId: string, now: number): number {
    const report = buildHealthReport(
      this.d.store,
      this.d.config.listRepos(),
      this.d.config.getGlobalStored(),
      now,
    );
    // A card with no MR belongs to no repo, so it counts against any release.
    return report.verdicts.filter(
      (v) =>
        isMismatchRule(v.ruleId) &&
        MISMATCH_SEVERITIES.has(v.severity) &&
        (v.repoId === repoId || v.repoId === null),
    ).length;
  }

  /** The first `release.done` of a job decides its record: a resume during DONE changes nothing. */
  onReleaseDone(event: ReleaseEvent): void {
    if (event.dryRun) return;
    const key = `release:${event.jobId}`;
    if (this.row(key)) return;
    const mismatches = this.mismatchesFor(event.repoId, event.at);
    const record: z.infer<typeof ReleaseDataSchema> = {
      jobId: event.jobId,
      repoId: event.repoId,
      mode: event.mode,
      version: event.version,
      at: event.at,
      mismatches,
    };
    this.d.store.db.transaction(() => {
      this.insert(KIND.release, key, 0, record, event.at);
      this.insert(KIND.xp, `xp:release:${event.jobId}`, XP.release, null, event.at);
      if (mismatches === 0) this.badge('zero_mismatches', event.jobId, event.at);
    });
    this.d.bus.emit({ type: 'gamification.changed' });
  }

  // ───────────────────────────── cards ─────────────────────────────

  /** Cards count as in the KPI: not archived, and assigned to me or with a manual assigned-at. */
  private reconcileCards(state: SourceState | undefined, now: number): boolean {
    const key = 'baseline:cards';
    const baseline = !this.row(key);
    if (baseline && state !== 'ok') return false;
    const ready = normalizeName(this.d.config.getGlobalStored().notion.readyStatus);
    const mine = this.d.store.db
      .select()
      .from(cards)
      .where(eq(cards.archived, false))
      .all()
      .filter((c) => c.assignedToMe || c.assignedAtManual !== null);
    let changed = false;
    for (const c of mine) {
      if (!c.status || normalizeName(c.status) !== ready) continue;
      if (this.award(`xp:card_ready:${c.id}`, XP.cardReady, baseline, now)) changed = true;
    }
    if (baseline && mine.length > 0) this.insert(KIND.baseline, key, 0, null, now);
    return changed;
  }

  // ───────────────────────────── approvals ─────────────────────────────

  /**
   * `<repoId>:<iid>` of every MR with a recorded approval. Taken before this pass, so that First Try can tell an MR's
   * first approval from a later one, even if the earlier approver has since withdrawn.
   */
  private approvedMrsSoFar(): Set<string> {
    return new Set(
      this.d.store.db
        .select({ key: gamification.dedupeKey })
        .from(gamification)
        .where(like(gamification.dedupeKey, `${APPROVAL_PREFIX}%`))
        .all()
        .map((r) => r.key.slice(APPROVAL_PREFIX.length, r.key.lastIndexOf(':'))),
    );
  }

  private reconcileApprovals(state: (repoId: string) => SourceState | undefined, now: number) {
    const me = this.d.config.getGlobalStored().gitlab.myUsername?.toLowerCase();
    // "Received" means nothing until the dashboard knows who I am.
    if (me === undefined) return false;
    const before = this.approvedMrsSoFar();
    let changed = false;
    let awarded = false;

    for (const repo of this.d.config.listRepos()) {
      const key = `baseline:approvals:${repo.id}`;
      const baseline = !this.row(key);
      const repoState = state(repo.id);
      if (!repoState || repoState === 'error' || (baseline && repoState !== 'ok')) continue;
      const reviewers = new Set(repo.reviewers.map((r) => r.toLowerCase()));
      const rows = this.d.store.db.select().from(mrs).where(eq(mrs.repoId, repo.id)).all();

      for (const m of rows) {
        if (m.author?.toLowerCase() !== me) continue;
        let fresh = false;
        for (const user of m.approvedBy.map((u) => u.toLowerCase())) {
          if (user === me || !reviewers.has(user)) continue;
          const k = `${APPROVAL_PREFIX}${repo.id}:${m.iid}:${user}`;
          if (this.award(k, XP.approval, baseline, now)) fresh = true;
        }
        if (!fresh) continue;
        changed = true;
        if (baseline) continue;
        awarded = true;
        // Only an MR's first approval decides First Try. A version MR is not reviewed work, so it never earns it.
        if (before.has(`${repo.id}:${m.iid}`) || isVersionMr(m, repo.versionBranchPrefix)) continue;
        const notes = this.d.store.db
          .select({ author: notesCache.author, body: notesCache.body })
          .from(notesCache)
          .where(
            and(
              eq(notesCache.repoId, repo.id),
              eq(notesCache.mrIid, m.iid),
              eq(notesCache.system, false),
            ),
          )
          .all();
        if (!hasOutsideComment(notes, me, repo.approvalMode === 'note_keyword')) {
          this.badge('first_try', `${repo.id}:${m.iid}`, now);
        }
      }
      if (baseline && rows.length > 0) this.insert(KIND.baseline, key, 0, null, now);
    }

    if (awarded) this.checkApprovalDay(now);
    return changed;
  }

  /** Counts by when the approval was first seen, as the cache has no time per approver. */
  private checkApprovalDay(now: number): void {
    const d = new Date(now);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = this.d.store.db
      .select({ key: gamification.dedupeKey })
      .from(gamification)
      .where(
        and(
          eq(gamification.kind, KIND.xp),
          like(gamification.dedupeKey, `${APPROVAL_PREFIX}%`),
          gte(gamification.at, dayStart),
        ),
      )
      .all();
    if (today.length >= APPROVALS_FOR_BADGE) this.badge('five_approvals_day', localDay(now), now);
  }

  // ───────────────────────────── KPI: SLA met, SLA days, monthly badges ─────────────────────────────

  /** A frozen month is read from its snapshot once, then skipped for good. */
  private reconcileKpi(now: number): boolean {
    const db = this.d.store.db;
    const baselineRow = this.row(KPI_BASELINE_KEY);
    const start = KpiBaselineSchema.safeParse(baselineRow?.data);
    const firstRun = !start.success;
    const today = localDay(now);
    const current = monthOf(now);
    const since = start.success ? start.data.month : current;
    const done = new Set(
      db
        .select({ key: gamification.dedupeKey })
        .from(gamification)
        .where(eq(gamification.kind, KIND.monthDone))
        .all()
        .map((r) => r.key.slice(KIND.monthDone.length + 1)),
    );

    const views = this.d.kpi.monthlyViews(since, done, now);
    if (firstRun && views.every((v) => v.data.rows.length === 0)) return false;

    let changed = false;
    const days = new Map<string, SlaDayTally>();
    for (const { month, frozen, data } of views) {
      for (const row of data.rows) {
        if (row.sla.state !== 'met') continue;
        if (this.award(`xp:sla_met:${row.cardId}`, XP.slaMet, firstRun, now)) changed = true;
      }
      tallySlaDays(data.rows, days);
      const { bugRatio, research } = data.scorecard;
      // A running month can still go over the bug limit. Research only grows, so it pays as soon as it is met.
      if (frozen && earnsBugSlayer(bugRatio) && this.badge('bug_slayer', month, now)) {
        changed = true;
      }
      if (
        (frozen || month === current) &&
        earnsResearcher(research) &&
        this.badge('researcher', month, now)
      ) {
        changed = true;
      }
      if (frozen) this.insert(KIND.monthDone, `${KIND.monthDone}:${month}`, 0, null, now);
    }

    // A finished day is recorded once. The baseline day may have been half over, so it does not count.
    const fromDay = start.success ? start.data.day : today;
    for (const [day, tally] of days) {
      if (day <= fromDay || day >= today) continue;
      if (this.insert(KIND.slaDay, `sla_day:${day}`, 0, { day, ...tally }, now)) changed = true;
    }

    if (firstRun) {
      this.insert(KIND.baseline, KPI_BASELINE_KEY, 0, { month: current, day: today }, now);
    }
    return changed;
  }

  // ───────────────────────────── one pass ─────────────────────────────

  /**
   * Re-reads the cache. Safe to run at any time and any number of times. A source that failed waits: awards are put off,
   * not lost, and a baseline is only taken from a clean read of its source.
   */
  reconcile(): void {
    const sync = this.d.syncStatus();
    if (!sync.schedule?.catchUpDone) return;
    const states = new Map(sync.sources.map((s) => [s.source, s.state] as const));
    const notion = states.get('notion');
    const now = this.now();
    const changed = this.d.store.db.transaction(() => {
      let any = false;
      if (notion && notion !== 'error' && notion !== 'never') {
        any = this.reconcileCards(notion, now) || any;
      }
      any = this.reconcileApprovals((id) => states.get(`gitlab:${id}`), now) || any;
      // A freeze asks the same of every source (`KpiService.tick`).
      const all = sync.sources.map((s) => s.state);
      if (all.length > 0 && all.every((s) => s === 'ok' || s === 'skipped')) {
        any = this.reconcileKpi(now) || any;
      }
      return any;
    });
    if (changed) this.d.bus.emit({ type: 'gamification.changed' });
  }

  // ───────────────────────────── schedule ─────────────────────────────

  /** `health.changed` follows every sync run and every card write, so no timer of its own is needed. */
  start(): void {
    const schedule = () => this.schedule();
    this.d.bus.on('health.changed', schedule);
    this.d.bus.on('cards.changed', schedule);
    this.d.bus.on('mrs.changed', schedule);
    // Stays on through shutdown: a release finishing during it still counts, and the DB closes after the engine.
    this.d.bus.on('release.done', (e) => this.onReleaseDone(e));
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      try {
        this.reconcile();
      } catch (e) {
        this.d.log.error({ err: (e as Error).name }, 'gamification pass failed');
      }
    }, this.d.debounceMs ?? DEBOUNCE_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ───────────────────────────── review deck ─────────────────────────────

  /**
   * XP for a finished Review Deck (once per deck + diff) and for issues found in it (capped). Returns XP awarded now.
   */
  awardReviewDeck(deckId: string, diffSha: string, issueNoteIds: readonly string[]): number {
    const at = this.now();
    let xp = 0;
    if (
      this.insert(KIND.xp, `xp:deck_completed:${deckId}:${diffSha}`, XP.deckCompleted, null, at)
    ) {
      xp += XP.deckCompleted;
    }
    for (const id of issueNoteIds.slice(0, MAX_ISSUE_XP_PER_DECK)) {
      if (this.insert(KIND.xp, `xp:issue_found:${deckId}:${id}`, XP.issueFound, null, at)) {
        xp += XP.issueFound;
      }
    }
    if (xp > 0) this.d.bus.emit({ type: 'gamification.changed' });
    return xp;
  }

  // ───────────────────────────── read ─────────────────────────────

  report(): GamificationReport {
    const rows = this.d.store.db
      .select()
      .from(gamification)
      .where(inArray(gamification.kind, [KIND.xp, KIND.badge, KIND.release, KIND.slaDay]))
      .all();
    const xpRows = rows.filter((r) => r.kind === KIND.xp);
    const xp = xpRows.reduce((sum, r) => sum + r.amount, 0);

    const badges = new Map<BadgeId, GamificationBadge>(
      BADGE_IDS.map((id) => [id, { id, count: 0, lastEarnedAt: null }]),
    );
    for (const r of rows) {
      if (r.kind !== KIND.badge) continue;
      const data = BadgeDataSchema.safeParse(r.data);
      const entry = data.success ? badges.get(data.data.badge) : undefined;
      if (!entry) continue;
      entry.count += 1;
      entry.lastEarnedAt = Math.max(entry.lastEarnedAt ?? 0, r.at);
    }

    const recorded = rows
      .filter((r) => r.kind === KIND.release)
      .flatMap((r) => {
        const data = ReleaseDataSchema.safeParse(r.data);
        return data.success ? [data.data] : [];
      })
      .sort((a, b) => a.at - b.at);
    const releases: GamificationRelease[] = [];
    let run = 0;
    let previousAt = -Infinity;
    for (const r of recorded) {
      run = r.mismatches === 0 ? run + 1 : 0;
      const earned = xpRows
        .filter((x) => x.at > previousAt && x.at <= r.at)
        .reduce((sum, x) => sum + x.amount, 0);
      releases.push({ ...r, xpEarned: earned, streak: run });
      previousAt = r.at;
    }

    const slaDays = rows
      .filter((r) => r.kind === KIND.slaDay)
      .flatMap((r) => {
        const data = SlaDaySchema.safeParse(r.data);
        return data.success ? [data.data] : [];
      })
      .sort((a, b) => a.day.localeCompare(b.day));

    return {
      xp,
      level: levelFor(xp),
      streaks: {
        releases: streakOf(recorded.map((r) => r.mismatches === 0)),
        slaDays: streakOf(slaDays.map((d) => d.breached === 0)),
        reviewDays: reviewStreak(
          new Set(
            xpRows
              .filter((r) => r.dedupeKey.startsWith('xp:deck_completed:'))
              .map((r) => localDay(r.at)),
          ),
          localDay(this.now()),
        ),
      },
      badges: [...badges.values()],
      releases: releases.slice(-HISTORY_RELEASES).reverse(),
    };
  }
}
