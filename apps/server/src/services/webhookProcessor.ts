import { createHash } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { WebhookEventStatus } from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { events } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { SyncEngine } from '../sync/syncEngine';
import type { Logger } from '../util/logger';
import {
  applyMergeRequestEvent,
  applyNoteEvent,
  applyPipelineEvent,
  applyPushEvent,
  type CacheUpdate,
} from './webhookCache';
import type { Notifier } from './notifier';
import { eventMeta, normalizeWebhook, type NormalizedEvent, type PushEvent } from './webhookEvents';

/**
 * Webhook intake + async processing:
 *   accept()   token already verified by the listener -> dedupe by X-Gitlab-Event-UUID (UNIQUE row in
 *              `events`) -> store the delivery -> returns at once so the listener can answer 200;
 *   enqueue()  runs AFTER the response: normalize -> cache update -> internal events -> debounced
 *              `SyncEngine.refreshNow(repo)` (which also pulls Notion incrementally).
 * Processing is serialized (one delivery at a time, in arrival order) and never throws into the caller.
 * Cache writes and refreshes are local reads of GitLab/Notion: nothing here writes to either.
 */

export interface WebhookIntakeInput {
  repoId: string;
  headers: Record<string, string | string[] | undefined>;
  payload: unknown;
}

export interface AcceptedDelivery {
  duplicate: boolean;
  /** `events.id` of the stored row (undefined for a duplicate). */
  eventRowId: number | undefined;
  eventUuid: string;
  receivedAt: number;
}

/** What the :3001 listener needs. */
export interface WebhookIntake {
  accept(input: WebhookIntakeInput): AcceptedDelivery;
  enqueue(input: WebhookIntakeInput, accepted: AcceptedDelivery): void;
}

export interface WebhookProcessorDeps {
  config: ConfigStore;
  store: AppDb;
  engine: Pick<SyncEngine, 'refreshNow'>;
  bus: EventBus;
  log: Logger;
  /** Qualifies the delivery for a push notification. Optional: absent = no notifications. */
  notifier?: Pick<Notifier, 'onWebhook'>;
  /** Push to a non-target branch ("Ready for MR"). Never throws. */
  onPush?: (repoId: string, ev: PushEvent) => void;
  /** Every authenticated, normalized delivery (Reviews: instant refresh + "this project has a webhook"). Never throws. */
  onEvent?: (projectId: number, ev: NormalizedEvent) => void;
  now?: () => number;
  /** Quiet period before a refresh runs; events inside it share one refresh. Default 1000 ms. */
  refreshDebounceMs?: number;
}

const UUID_RE = /^[A-Za-z0-9-]{8,100}$/;
/** Payloads larger than this are stored as a stub (the cache update has already used them). */
const MAX_STORED_PAYLOAD_BYTES = 200_000;
const RETENTION_MS = 30 * 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 3600 * 1000;
/** Terminal pipeline states: only these trigger a refresh (the cache is updated for every status). */
const TERMINAL_PIPELINE = new Set(['success', 'failed', 'canceled', 'cancelled', 'skipped']);

const header = (h: WebhookIntakeInput['headers'], name: string): string | undefined => {
  const v = h[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : undefined;
};

export class WebhookProcessor implements WebhookIntake {
  private readonly now: () => number;
  private readonly debounceMs: number;
  private chain: Promise<void> = Promise.resolve();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private lastPrune = 0;
  private inFlightRefreshes = new Set<Promise<unknown>>();

  constructor(private readonly d: WebhookProcessorDeps) {
    this.now = d.now ?? Date.now;
    this.debounceMs = d.refreshDebounceMs ?? 1000;
  }

  // ───────────── intake (synchronous: runs before the 200) ─────────────

  /**
   * Dedupe + store. `INSERT … ON CONFLICT DO NOTHING` on the UNIQUE `event_uuid`: zero changes =
   * a retry/duplicate. A delivery without a usable `X-Gitlab-Event-UUID` is keyed by a hash of its
   * body, so an identical re-send is still deduped. A DB failure throws (the listener answers 500
   * and GitLab retries with the same UUID).
   */
  accept(input: WebhookIntakeInput): AcceptedDelivery {
    const receivedAt = this.now();
    const rawUuid = header(input.headers, 'x-gitlab-event-uuid');
    const eventUuid =
      rawUuid && UUID_RE.test(rawUuid)
        ? rawUuid
        : `nouuid:${input.repoId}:${createHash('sha256')
            .update(JSON.stringify(input.payload) ?? '')
            .digest('hex')
            .slice(0, 40)}`;
    const eventHeader = header(input.headers, 'x-gitlab-event');
    const meta = eventMeta(eventHeader, input.payload);

    const serialized = JSON.stringify(input.payload) ?? 'null';
    const payload: unknown =
      serialized.length > MAX_STORED_PAYLOAD_BYTES
        ? { truncated: true, bytes: serialized.length }
        : input.payload;

    const res = this.d.store.db
      .insert(events)
      .values({
        eventUuid,
        repoId: input.repoId,
        eventType: (eventHeader ?? 'unknown').slice(0, 100),
        objectKind: meta.kind,
        action: meta.action,
        payload,
        status: 'received',
        receivedAt,
      })
      .onConflictDoNothing({ target: events.eventUuid })
      .returning({ id: events.id })
      .all();
    const row = res[0];
    this.maybePrune(receivedAt);
    return { duplicate: row === undefined, eventRowId: row?.id, eventUuid, receivedAt };
  }

  /** Schedules processing AFTER the response has been sent. Never throws, never rejects. */
  enqueue(input: WebhookIntakeInput, accepted: AcceptedDelivery): void {
    if (accepted.duplicate || accepted.eventRowId === undefined || this.closed) return;
    const rowId = accepted.eventRowId;
    this.chain = this.chain.then(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            this.process(input, rowId, accepted.receivedAt).then(resolve, () => resolve());
          });
        }),
    );
  }

  // ───────────── processing ─────────────

  private async process(
    input: WebhookIntakeInput,
    rowId: number,
    receivedAt: number,
  ): Promise<void> {
    const { repoId } = input;
    try {
      const eventHeader = header(input.headers, 'x-gitlab-event');
      const norm = normalizeWebhook(eventHeader, input.payload);
      if (!norm.ok) {
        this.finish(rowId, 'ignored', norm.reason);
        return;
      }
      const ev = norm.event;

      const repo = this.d.config.getRepo(repoId);
      if (!repo) {
        this.finish(rowId, 'ignored', 'repo no longer exists');
        return;
      }
      // Defence in depth: the token already proved the sender, but a hook pointed at the wrong repo
      // id would otherwise poison this repo's cache with another project's MRs.
      if (ev.projectId !== undefined && ev.projectId !== repo.gitlab.projectId) {
        this.d.log.warn({ repoId, kind: ev.kind }, 'webhook for a different project, ignored');
        this.finish(rowId, 'ignored', 'payload project does not match this repo');
        return;
      }

      this.d.bus.emit({ type: 'webhook.received', repoId, kind: ev.kind, at: receivedAt });

      // Qualify for a notification BEFORE the cache changes: the rules compare against the old state
      // (was the MR already merged? did the thread already have a note?). Never throws.
      this.d.notifier?.onWebhook(repoId, ev);
      try {
        this.d.onEvent?.(repo.gitlab.projectId, ev);
      } catch {
        /* a Reviews problem must never fail a delivery */
      }

      const update = this.updateCache(repoId, ev, repo.baseBranch);
      if (update.iids.length > 0) {
        this.d.bus.emit({ type: 'mrs.changed', repoId, iids: update.iids });
      }

      const refresh = this.wantsRefresh(ev, update);
      if (refresh) this.scheduleRefresh(repoId);
      this.d.log.debug(
        { repoId, kind: ev.kind, cache: update.note, changed: update.iids.length, refresh },
        'webhook processed',
      );
      this.finish(rowId, 'processed', null);
    } catch (e) {
      // Only our own message text, clipped: payload content never goes into logs or the row.
      const msg = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
      this.d.log.error({ repoId, err: (e as Error).name }, 'webhook processing failed');
      this.finish(rowId, 'failed', msg);
    }
  }

  private updateCache(
    repoId: string,
    ev: NormalizedEvent,
    baseBranch: string,
  ): CacheUpdate & { touchesTarget?: boolean } {
    const now = this.now();
    switch (ev.kind) {
      case 'merge_request':
        return applyMergeRequestEvent(this.d.store, repoId, ev, now);
      case 'note':
        return applyNoteEvent(this.d.store, repoId, ev, now, this.d.config.myUsernames());
      case 'pipeline':
        return applyPipelineEvent(this.d.store, repoId, ev);
      case 'push':
        this.d.onPush?.(repoId, ev);
        return applyPushEvent(this.d.store, repoId, ev, baseBranch, now);
    }
  }

  /** Which deliveries justify a refresh (a whole-repo MR sync + Notion incremental + relink). */
  private wantsRefresh(
    ev: NormalizedEvent,
    update: CacheUpdate & { touchesTarget?: boolean },
  ): boolean {
    switch (ev.kind) {
      case 'merge_request':
        return true;
      case 'note':
        // Notes on issues/commits/snippets are irrelevant to the dashboard.
        return ev.mrIid !== undefined;
      case 'pipeline':
        return TERMINAL_PIPELINE.has(ev.status) && !ev.tag;
      case 'push':
        return !ev.deleted && update.touchesTarget === true;
    }
  }

  /**
   * Leading-window debounce: the first qualifying event arms a timer, the rest inside the window
   * share it, so a burst (push + pipeline + MR update) costs one refresh. The engine additionally
   * coalesces anything arriving while a run executes.
   */
  private scheduleRefresh(repoId: string): void {
    if (this.closed || this.timers.has(repoId)) return;
    const t = setTimeout(() => {
      this.timers.delete(repoId);
      if (this.closed) return;
      const p = this.d.engine
        .refreshNow(repoId)
        .then(
          (r) => this.d.log.debug({ repoId, result: r.status }, 'webhook refresh finished'),
          () => this.d.log.warn({ repoId }, 'webhook refresh failed'),
        )
        .finally(() => this.inFlightRefreshes.delete(p));
      this.inFlightRefreshes.add(p);
    }, this.debounceMs);
    t.unref();
    this.timers.set(repoId, t);
  }

  private finish(rowId: number, status: WebhookEventStatus, error: string | null): void {
    try {
      this.d.store.db
        .update(events)
        .set({ status, error, processedAt: this.now() })
        .where(eq(events.id, rowId))
        .run();
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'could not update webhook event row');
    }
  }

  // ───────────── housekeeping ─────────────

  /** Deliveries still `received` at boot were cut off by a restart: mark them (the catch-up sync covers them). */
  recoverInterrupted(): number {
    const res = this.d.store.db
      .update(events)
      .set({ status: 'failed', error: 'interrupted by restart', processedAt: this.now() })
      .where(eq(events.status, 'received'))
      .run();
    return res.changes;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    try {
      this.d.store.db
        .delete(events)
        .where(lt(events.receivedAt, now - RETENTION_MS))
        .run();
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'webhook event pruning failed');
    }
  }

  /** Stops accepting work, drops pending refresh timers and waits for the delivery in progress. */
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.chain;
    await Promise.allSettled([...this.inFlightRefreshes]);
  }
}
