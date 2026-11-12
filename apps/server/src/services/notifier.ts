import { and, count, eq, inArray, ne } from 'drizzle-orm';
import {
  PUSH_PAYLOAD_VERSION,
  PushPayloadSchema,
  type ChannelResult,
  type NotificationEvent,
  type NotificationSubject,
  type PushPayload,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { mrs, notesCache, settings } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { buildHealthReport } from './healthReport';
import { recordNotification } from './notificationCenter';
import type { NotificationChannel } from './notificationChannel';
import {
  isMismatchRule,
  mismatchCandidate,
  mismatchKey,
  mismatchSummary,
  MISMATCH_SEVERITIES,
  qualifyWebhook,
  uploadedCandidate,
  type Candidate,
  type NotifyContext,
} from './notificationRules';
import type { NormalizedEvent } from './webhookEvents';

/**
 * Turns qualifying events into notifications. Webhook deliveries are qualified by the pure rules in
 * `notificationRules.ts`; "mismatch detected" comes from the Sync Health report after each sync.
 *
 *   qualify -> per-event toggle (Settings) -> dedupe -> bus `notification` event + every configured channel
 *
 * Nothing here writes to GitLab or Notion, and nothing throws into its callers (the webhook processor and the
 * event bus): failures are logged by name only. Notification text never contains a secret.
 */

export interface NotifierDeps {
  config: Pick<ConfigStore, 'getGlobalStored' | 'getRepoPublic' | 'listRepos'> &
    Partial<Pick<ConfigStore, 'tokenUsers'>>;
  store: AppDb;
  bus: EventBus;
  channels: NotificationChannel[];
  log: Logger;
  now?: () => number;
  /** A mismatch must persist this long before it notifies (a card edit about to be followed by its MR must not ping). */
  mismatchSettleMs?: number;
}

/** In-memory "same notification inside its window" guard. Bounded; expired keys are dropped as it grows. */
export class TtlDedupe {
  private readonly until = new Map<string, number>();
  constructor(
    private readonly now: () => number,
    private readonly maxKeys = 2000,
  ) {}

  /** True the first time `key` is seen inside `ttlMs`; false for repeats. */
  claim(key: string, ttlMs: number): boolean {
    const t = this.now();
    const exp = this.until.get(key);
    if (exp !== undefined && exp > t) return false;
    this.until.set(key, t + ttlMs);
    if (this.until.size > this.maxKeys) this.prune(t);
    return true;
  }

  private prune(t: number): void {
    for (const [k, exp] of this.until) if (exp <= t) this.until.delete(k);
    // Still too big (everything live): drop the oldest insertions.
    let over = this.until.size - this.maxKeys;
    for (const k of this.until.keys()) {
      if (over-- <= 0) break;
      this.until.delete(k);
    }
  }
}

const MISMATCH_STATE_KEY = 'notify.mismatch.state';
const MISMATCH_SETTLE_MS = 90_000;
const MISMATCH_EVAL_DEBOUNCE_MS = 500;
// More new mismatches than this at once are sent as ONE summary notification.
const MISMATCH_MAX_INDIVIDUAL = 3;
const CLOSE_WAIT_MS = 5_000;

/** What a qualified webhook means for the core's effects. Other notifications (pipeline, mismatch...) have no effect. */
const ACTIVITY: Partial<Record<NotificationEvent, 'comment' | 'approval' | 'merge'>> = {
  approved: 'approval',
  comment: 'comment',
  reply: 'comment',
  merged: 'merge',
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type NamedChannelResult = ChannelResult & { name: string };

export class Notifier {
  private readonly now: () => number;
  private readonly dedupe: TtlDedupe;
  /** Apart from `dedupe`: a notification claiming a key must not silence the activity event, or the reverse. */
  private readonly activityDedupe: TtlDedupe;
  private readonly settleMs: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Mismatch findings seen but not yet settled (key -> first seen). */
  private readonly pending = new Map<string, number>();
  private mismatchTimer: NodeJS.Timeout | undefined;
  private unwatch: (() => void) | undefined;
  private closed = false;

  constructor(private readonly d: NotifierDeps) {
    this.now = d.now ?? Date.now;
    this.dedupe = new TtlDedupe(this.now);
    this.activityDedupe = new TtlDedupe(this.now);
    this.settleMs = d.mismatchSettleMs ?? MISMATCH_SETTLE_MS;
  }

  // ───────────────────────────── webhook deliveries ─────────────────────────────

  /**
   * Call BEFORE the delivery updates the cache (the rules need the old state). Synchronous qualification, async
   * delivery; never throws.
   */
  onWebhook(repoId: string, ev: NormalizedEvent): void {
    if (this.closed) return;
    try {
      const cfg = this.d.config.getGlobalStored();
      const repo = this.d.config.getRepoPublic(repoId);
      if (!repo) return;
      const base = this.loadContext(
        {
          id: repo.id,
          name: repo.name,
          reviewers: repo.reviewers,
          approvalMode: repo.approvalMode,
        },
        cfg.gitlab.myUsername,
        false,
        ev,
      );
      this.emitActivity(repoId, ev, base);
      if (cfg.notifications.events.length === 0) return;
      const ctx = { ...base, ignoreOwn: cfg.notifications.ignoreOwn };
      const enabled = new Set<string>(cfg.notifications.events);
      for (const c of qualifyWebhook(ev, ctx)) {
        if (!enabled.has(c.event)) continue;
        if (!this.dedupe.claim(c.key, c.ttlMs)) {
          this.d.log.debug({ event: c.event }, 'notification deduplicated');
          continue;
        }
        this.dispatch(c);
      }
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'notification qualification failed');
    }
  }

  /** The same rules as the notifications, before toggles and `ignoreOwn`, so that the core reacts to the user's own actions. */
  private emitActivity(repoId: string, ev: NormalizedEvent, ctx: NotifyContext): void {
    const iid = ev.kind === 'merge_request' ? ev.iid : ev.kind === 'note' ? ev.mrIid : undefined;
    if (iid === undefined) return;
    for (const c of qualifyWebhook(ev, ctx)) {
      const activity = ACTIVITY[c.event];
      if (!activity || !this.activityDedupe.claim(c.key, c.ttlMs)) continue;
      this.d.bus.emit({ type: 'mr.activity', repoId, iid, activity });
    }
  }

  private loadContext(
    repo: NotifyContext['repo'],
    me: string | undefined,
    ignoreOwn: boolean,
    ev: NormalizedEvent,
  ): NotifyContext {
    const db = this.d.store.db;
    const mrRow = (iid: number) =>
      db
        .select({ iid: mrs.iid, title: mrs.title, state: mrs.state })
        .from(mrs)
        .where(and(eq(mrs.repoId, repo.id), eq(mrs.iid, iid)))
        .get() ?? null;

    let mr: NotifyContext['mr'] = null;
    let repliesToExisting = false;
    let pipelineMrs: NotifyContext['pipelineMrs'] = [];

    if (ev.kind === 'merge_request') {
      mr = mrRow(ev.iid);
    } else if (ev.kind === 'note' && ev.mrIid !== undefined) {
      mr = mrRow(ev.mrIid);
      if (ev.discussionId) {
        const n =
          db
            .select({ n: count() })
            .from(notesCache)
            .where(
              and(
                eq(notesCache.repoId, repo.id),
                eq(notesCache.mrIid, ev.mrIid),
                eq(notesCache.discussionId, ev.discussionId),
                eq(notesCache.system, false),
                ne(notesCache.noteId, ev.noteId),
              ),
            )
            .get()?.n ?? 0;
        repliesToExisting = n > 0;
      }
    } else if (ev.kind === 'pipeline' && ev.status === 'failed' && !ev.tag) {
      const open = ['opened', 'locked'];
      const byIid = ev.mrIid;
      const byRef = ev.ref;
      if (byIid !== undefined) {
        pipelineMrs = db
          .select({ iid: mrs.iid, title: mrs.title })
          .from(mrs)
          .where(and(eq(mrs.repoId, repo.id), eq(mrs.iid, byIid), inArray(mrs.state, open)))
          .all();
      } else if (byRef) {
        pipelineMrs = db
          .select({ iid: mrs.iid, title: mrs.title })
          .from(mrs)
          .where(
            and(eq(mrs.repoId, repo.id), eq(mrs.sourceBranch, byRef), inArray(mrs.state, open)),
          )
          .all();
      }
    }
    const tokenUsers = [...(this.d.config.tokenUsers?.().values() ?? [])];
    return { repo, me, tokenUsers, ignoreOwn, mr, repliesToExisting, pipelineMrs };
  }

  // ───────────────────────────── uploads ─────────────────────────────

  /** A staging APK reached Drive. Honours the `buildDone` toggle. Never throws. */
  notifyUploaded(input: Parameters<typeof uploadedCandidate>[0]): void {
    if (this.closed) return;
    try {
      if (!this.d.config.getGlobalStored().notifications.events.includes('buildDone')) return;
      const candidate = uploadedCandidate(input);
      if (this.dedupe.claim(candidate.key, candidate.ttlMs)) this.dispatch(candidate);
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'upload notification failed');
    }
  }

  // ───────────────────────────── cockpit ─────────────────────────────

  /**
   * A cockpit notice (branch ready for MR, agent finished). Honours the event's toggle and the dedupe window.
   * Never throws.
   */
  notifyCockpit(candidate: Candidate): void {
    if (this.closed) return;
    try {
      if (!this.d.config.getGlobalStored().notifications.events.includes(candidate.event)) return;
      if (this.dedupe.claim(candidate.key, candidate.ttlMs)) this.dispatch(candidate);
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'cockpit notification failed');
    }
  }

  // ───────────────────────────── KPI ─────────────────────────────

  /** SLA and research notices chosen by `KpiService`. Honours each one's toggle. Never throws. */
  notifyKpi(candidates: readonly Candidate[]): void {
    if (this.closed) return;
    try {
      const enabled = new Set<string>(this.d.config.getGlobalStored().notifications.events);
      for (const c of candidates) {
        if (enabled.has(c.event) && this.dedupe.claim(c.key, c.ttlMs)) this.dispatch(c);
      }
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'KPI notification failed');
    }
  }

  // ───────────────────────────── sync mismatch ─────────────────────────────

  /** Start watching `health.changed` (emitted after every sync run). Returns an unsubscribe function. */
  watchHealth(): () => void {
    this.unwatch?.();
    this.unwatch = this.d.bus.on('health.changed', () => this.scheduleMismatchCheck());
    return () => {
      this.unwatch?.();
      this.unwatch = undefined;
    };
  }

  private scheduleMismatchCheck(): void {
    if (this.closed || this.mismatchTimer) return;
    this.mismatchTimer = setTimeout(() => {
      this.mismatchTimer = undefined;
      if (this.closed) return;
      try {
        this.checkMismatches();
      } catch (e) {
        this.d.log.error({ err: (e as Error).name }, 'mismatch check failed');
      }
    }, MISMATCH_EVAL_DEBOUNCE_MS);
    this.mismatchTimer.unref();
  }

  /**
   * Notify about Sync Health mismatches that are NEW:
   *  - the first evaluation with data only records what exists (no flood after enabling / a fresh DB);
   *  - a finding must persist `mismatchSettleMs` before it counts;
   *  - once notified it is remembered (persisted) until it disappears, so repeated syncs / restarts stay quiet
   *    and a recurrence notifies again;
   *  - with the `mismatch` toggle off the memory is dropped, so re-enabling starts from a silent baseline.
   */
  checkMismatches(): void {
    const cfg = this.d.config.getGlobalStored();
    if (!cfg.notifications.events.includes('mismatch')) {
      this.pending.clear();
      this.clearMismatchState();
      return;
    }
    const repos = this.d.config.listRepos();
    const now = this.now();
    const report = buildHealthReport(this.d.store, repos, cfg, now);
    const current = new Map<string, (typeof report.verdicts)[number]>();
    for (const v of report.verdicts) {
      if (isMismatchRule(v.ruleId) && MISMATCH_SEVERITIES.has(v.severity)) {
        current.set(mismatchKey(v), v);
      }
    }

    const state = this.readMismatchState();
    if (state === null) {
      // Nothing synced yet: wait, so the first real data set becomes the baseline.
      if (report.counts.cards === 0 && report.verdicts.length === 0) return;
      this.writeMismatchState(new Set(current.keys()), now);
      return;
    }

    let changed = false;
    for (const k of [...state]) {
      if (!current.has(k)) {
        state.delete(k);
        changed = true;
      }
    }
    for (const k of [...this.pending.keys()]) if (!current.has(k)) this.pending.delete(k);

    const fresh: (typeof report.verdicts)[number][] = [];
    for (const [k, v] of current) {
      if (state.has(k)) continue;
      const first = this.pending.get(k) ?? now;
      this.pending.set(k, first);
      if (now - first >= this.settleMs) fresh.push(v);
    }
    for (const v of fresh) {
      const k = mismatchKey(v);
      state.add(k);
      this.pending.delete(k);
      changed = true;
    }
    if (changed) this.writeMismatchState(state, now);
    if (fresh.length === 0) return;

    const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
    if (fresh.length > MISMATCH_MAX_INDIVIDUAL) {
      this.dispatch(mismatchSummary(fresh.length));
    } else {
      for (const v of fresh) this.dispatch(mismatchCandidate(v, repoName));
    }
  }

  private readMismatchState(): Set<string> | null {
    const row = this.d.store.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, MISMATCH_STATE_KEY))
      .get();
    if (!row) return null;
    try {
      const v = JSON.parse(row.value) as { notified?: unknown };
      if (!Array.isArray(v.notified)) return null;
      return new Set(v.notified.filter((x): x is string => typeof x === 'string'));
    } catch {
      return null;
    }
  }

  private writeMismatchState(keys: Set<string>, now: number): void {
    const value = JSON.stringify({ v: 1, notified: [...keys] });
    this.d.store.db
      .insert(settings)
      .values({ key: MISMATCH_STATE_KEY, value, encrypted: false, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, encrypted: false, updatedAt: now },
      })
      .run();
  }

  private clearMismatchState(): void {
    this.d.store.db.delete(settings).where(eq(settings.key, MISMATCH_STATE_KEY)).run();
  }

  // ───────────────────────────── delivery ─────────────────────────────

  private dispatch(c: Candidate): void {
    const parsed = PushPayloadSchema.safeParse({
      v: PUSH_PAYLOAD_VERSION,
      event: c.event,
      title: clip(c.title, 120),
      body: clip(c.body, 240),
      tag: c.tag.slice(0, 100),
      url: c.url,
      at: this.now(),
      repoId: c.repoId,
    } satisfies PushPayload);
    if (!parsed.success) {
      this.d.log.warn({ event: c.event }, 'notification dropped: invalid payload');
      return;
    }
    const payload = parsed.data;
    this.record(payload, c.subject);
    // The browser tab (SSE) sees it immediately, even when no push channel is configured.
    this.d.bus.emit({
      type: 'notification',
      event: c.event,
      title: payload.title,
      body: payload.body,
      repoId: payload.repoId,
      url: payload.url,
    });
    for (const ch of this.d.channels) {
      if (!ch.isConfigured()) continue;
      const p = ch
        .deliver(payload)
        .then(
          (r) =>
            this.d.log.debug({ channel: ch.name, event: c.event, ...r }, 'notification delivered'),
          (e: unknown) =>
            this.d.log.error(
              { channel: ch.name, err: (e as Error).name },
              'notification channel threw',
            ),
        )
        .finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }

  /** Keeps it for the notification center. A failure here must not cost the delivery. */
  private record(payload: PushPayload, subject: NotificationSubject | null): void {
    try {
      recordNotification(this.d.store, payload, subject);
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'notification could not be logged');
    }
  }

  /** Sends a payload to every configured channel right now (the manual test button). Never throws. */
  async sendTest(): Promise<NamedChannelResult[]> {
    const payload: PushPayload = {
      v: PUSH_PAYLOAD_VERSION,
      event: 'test',
      title: 'Relay',
      body: 'Test notification: push is working.',
      tag: 'test',
      url: '/settings',
      at: this.now(),
      repoId: null,
    };
    this.record(payload, null);
    this.d.bus.emit({ type: 'notifications.changed' });
    const out: NamedChannelResult[] = [];
    for (const ch of this.d.channels) {
      if (!ch.isConfigured()) continue;
      try {
        out.push({ name: ch.name, ...(await ch.deliver(payload)) });
      } catch (e) {
        this.d.log.error(
          { channel: ch.name, err: (e as Error).name },
          'notification channel threw',
        );
        out.push({ name: ch.name, attempted: 0, sent: 0, removed: 0, failed: 1 });
      }
    }
    return out;
  }

  /** Stops watching, cancels the pending check and waits (briefly) for deliveries in flight. */
  async close(): Promise<void> {
    this.closed = true;
    this.unwatch?.();
    this.unwatch = undefined;
    if (this.mismatchTimer) clearTimeout(this.mismatchTimer);
    this.mismatchTimer = undefined;
    const wait = Promise.allSettled([...this.inFlight]);
    await Promise.race([wait, new Promise<void>((r) => setTimeout(r, CLOSE_WAIT_MS).unref())]);
  }
}
