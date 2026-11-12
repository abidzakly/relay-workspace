import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  AppEventSchema,
  SSE_EVENTS_PATH,
  SSE_FRAME_HELLO,
  SSE_FRAME_PING,
  SSE_FRAME_RESYNC,
  SSE_STALE_AFTER_MS,
  SseHelloSchema,
  type AppEvent,
} from '@relay/shared';
import { gamificationKeys } from './gamificationApi';
import { kpiKeys } from './kpiApi';
import { mrKeys } from './mrApi';
import { notificationKeys } from './notificationApi';
import { queryClient } from './queryClient';
import { releaseKeys } from './releaseApi';
import { reviewsKeys } from './reviewsApi';
import { keys as settingsKeys } from './settingsApi';
import { useSseStore } from './sseState';
import { stateKeys } from './stateApi';
import { testBenchKeys } from './testBenchApi';
import { webhookKeys } from './webhookApi';

/* ───────────────────────── event -> query keys ───────────────────────── */

/** Roots of server-data queries that do not exist yet (later parts); invalidating an unused key is a no-op. */
const FUTURE = {
  audit: ['audit'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['job', id] as const,
  builds: ['builds'] as const,
};

/** More iids than this in one `mrs.changed` -> invalidate the whole repo's MR details instead. */
const MAX_DETAIL_KEYS = 25;

/** `'all'` = refetch every active query (used after a gap the server could not replay). */
export type Invalidation = readonly QueryKey[] | 'all';

/**
 * Which TanStack Query keys an event makes stale. Pure; exhaustive over `AppEvent` (adding an event type
 * without deciding its keys is a compile error). Keys are PREFIXES: `['mrs']` covers every inbox filter,
 * `['mr', repo]` every detail of that repo.
 *
 *  cards.changed    cards feed the snapshot, health, the inbox's linked card and MR detail
 *  mrs.changed      snapshot, health, inbox, and the details of exactly those MRs
 *  links.changed    same set as cards (links are shown everywhere a card or MR is)
 *  health.changed   verdicts + sync status live in the health report and in the snapshot
 *  settings.changed config drives repos/reviewers/statuses, so everything derived from it
 *  audit.added      audit log
 *  webhook.received webhook health panel only (the cache changes arrive as mrs.changed)
 *  job.updated      jobs / builds / release views (and that job)
 *  build.upload    builds view (the answer carries the bytes sent so far)
 *  gamification.changed  the level panel
 *  notification, notifications.changed  the notification center
 *  release.done, mr.activity, job.log, ping: nothing to refetch (log lines have their own stream; toasts are a UI concern)
 *
 *  Notification center: each row's actions are derived from MRs, cards, links, health, jobs, sessions and settings,
 *  so a change to any of them refreshes it. That is how "Merge now" disappears the moment the MR is merged.
 *
 *  KPI: cards, MRs, links and settings feed it. `health.changed` follows every sync run, so a timer that crossed a
 *  state with no data change, and a month that was just frozen, are picked up then.
 */
export function invalidationsFor(event: AppEvent): Invalidation {
  switch (event.type) {
    case 'cards.changed':
      // Release jobs too: their Notion proposal shows each card's status.
      return [
        stateKeys.state,
        stateKeys.health,
        mrKeys.inboxRoot,
        mrKeys.detailRoot,
        releaseKeys.jobs,
        kpiKeys.root,
        notificationKeys.root,
      ];
    case 'links.changed':
      return [
        stateKeys.state,
        stateKeys.health,
        mrKeys.inboxRoot,
        mrKeys.detailRoot,
        kpiKeys.root,
        notificationKeys.root,
      ];
    case 'mrs.changed': {
      const details: QueryKey[] =
        event.iids.length > MAX_DETAIL_KEYS
          ? [[...mrKeys.detailRoot, event.repoId]]
          : event.iids.map((iid) => [...mrKeys.detailRoot, event.repoId, iid]);
      return [
        stateKeys.state,
        stateKeys.health,
        mrKeys.inboxRoot,
        kpiKeys.root,
        notificationKeys.root,
        testBenchKeys.open,
        ...details,
      ];
    }
    case 'health.changed':
      return [stateKeys.health, stateKeys.state, kpiKeys.root, notificationKeys.root];
    case 'settings.changed':
      return [
        settingsKeys.settings,
        settingsKeys.repos,
        stateKeys.state,
        stateKeys.health,
        mrKeys.inboxRoot,
        webhookKeys.health,
        kpiKeys.root,
        notificationKeys.root,
      ];
    case 'audit.added':
      return [FUTURE.audit];
    case 'webhook.received':
      return [webhookKeys.health];
    case 'job.updated':
      return [
        FUTURE.jobs,
        FUTURE.job(event.jobId),
        FUTURE.builds,
        releaseKeys.root,
        notificationKeys.root,
      ];
    case 'build.upload':
      return [FUTURE.builds];
    case 'gamification.changed':
      return [gamificationKeys.root];
    case 'reviews.changed':
      return [reviewsKeys.desk];
    case 'cockpit.changed':
      return [['cockpit', event.what], notificationKeys.root];
    case 'testbench.changed':
      return [
        ['test-bench', event.repoId, event.branch],
        ['cockpit', 'ready', 'preview', event.repoId, event.branch],
        testBenchKeys.open,
      ];
    case 'notification':
    case 'notifications.changed':
      return [notificationKeys.root];
    case 'release.done':
    case 'mr.activity': // `mrs.changed` carries the cache change
    case 'job.log':
    case 'ping':
      return [];
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/* ───────────────────────── connection manager ───────────────────────── */

/** Invalidations from one burst of events (a sync run emits 4-5 at once) are merged and flushed together. */
const FLUSH_MS = 75;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const WATCHDOG_EVERY_MS = 5_000;

type Timer = ReturnType<typeof setTimeout>;
type AppEventListener = (event: AppEvent) => void;

export interface EventStreamOptions {
  url?: string;
  /** Tests/dev can swap the transport; defaults to the browser's `EventSource`. */
  createSource?: (url: string) => EventSource;
}

/**
 * Owns the one `EventSource` of the page.
 *  - Resume: remembers the last event id; the browser's own retry sends `Last-Event-ID`, and our manual
 *    reconnects pass `?lastEventId=` (EventSource cannot set headers).
 *  - A reconnect the server could not resume (hello `resumed:false`, or a `resync` frame) refetches everything.
 *  - Failure handling: HTTP errors close an EventSource for good, so we reconnect ourselves with
 *    exponential backoff + jitter; a watchdog drops a connection that went silent (no frame for
 *    `staleAfterMs`: half-open sockets, laptop sleep) and reconnects it.
 *  - Invalidations are deduplicated and flushed in batches.
 * `start()`/`stop()` are idempotent so React StrictMode's double mount is harmless.
 */
export class EventStreamClient {
  private source: EventSource | null = null;
  private running = false;
  private lastEventId: string | null = null;
  private bootId: string | null = null;
  private everLive = false;
  private attempt = 0;
  private staleAfterMs = SSE_STALE_AFTER_MS;
  private lastFrameAt = 0;
  private reconnectTimer: Timer | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private flushTimer: Timer | null = null;
  private pending = new Map<string, QueryKey>();
  private pendingAll = false;
  private readonly listeners = new Set<AppEventListener>();
  private readonly url: string;
  private readonly create: (url: string) => EventSource;

  constructor(
    private readonly qc: QueryClient,
    opts: EventStreamOptions = {},
  ) {
    this.url = opts.url ?? SSE_EVENTS_PATH;
    this.create = opts.createSource ?? ((u) => new EventSource(u));
  }

  /** Raw events as they arrive (for toasts / 3D bursts in later parts). Returns an unsubscribe function. */
  subscribe(fn: AppEventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchdog = setInterval(() => this.checkStale(), WATCHDOG_EVERY_MS);
    window.addEventListener('online', this.onWake);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.closeSource();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.reconnectTimer = this.watchdog = this.flushTimer = null;
    window.removeEventListener('online', this.onWake);
    document.removeEventListener('visibilitychange', this.onVisible);
    useSseStore.getState().set({ state: 'connecting', attempt: 0 });
  }

  private readonly onWake = (): void => {
    if (this.running && useSseStore.getState().state !== 'live') this.reconnectNow();
  };

  private readonly onVisible = (): void => {
    if (!this.running || document.visibilityState !== 'visible') return;
    // Background tabs throttle timers: re-check right away instead of waiting for the watchdog.
    if (useSseStore.getState().state !== 'live') this.reconnectNow();
    else this.checkStale();
  };

  private connect(): void {
    if (!this.running) return;
    this.closeSource();
    const qs = this.lastEventId ? `?lastEventId=${encodeURIComponent(this.lastEventId)}` : '';
    let es: EventSource;
    try {
      es = this.create(`${this.url}${qs}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = es;
    this.lastFrameAt = Date.now(); // the watchdog measures from the attempt, not from page load

    es.addEventListener(SSE_FRAME_HELLO, (e) => this.onHello(e as MessageEvent<string>));
    es.addEventListener(SSE_FRAME_PING, () => this.touch());
    es.addEventListener(SSE_FRAME_RESYNC, () => {
      this.touch();
      this.queueAll();
    });
    es.onmessage = (e) => this.onMessage(e);
    es.onerror = () => {
      if (this.source !== es) return;
      if (es.readyState === EventSource.CLOSED) {
        // HTTP error (429 / 403 / 5xx) or the browser gave up: no automatic retry from here.
        this.closeSource();
        this.scheduleReconnect();
      } else {
        // CONNECTING: the browser retries by itself (and sends Last-Event-ID). Just show it.
        useSseStore.getState().set({ state: 'reconnecting' });
      }
    };
  }

  private onHello(e: MessageEvent<string>): void {
    this.touch();
    const parsed = SseHelloSchema.safeParse(safeJson(e.data));
    if (!parsed.success) return;
    const hello = parsed.data;
    this.staleAfterMs = Math.max(SSE_STALE_AFTER_MS, hello.heartbeatMs * 3);
    this.bootId = hello.bootId;
    // Reconnected but the server could not tell us exactly what we missed: refetch everything.
    if (this.everLive && !hello.resumed) this.queueAll();
    this.everLive = true;
    this.attempt = 0;
    useSseStore.getState().set({ state: 'live', attempt: 0 });
  }

  private onMessage(e: MessageEvent<string>): void {
    this.touch();
    const parsed = AppEventSchema.safeParse(safeJson(e.data));
    if (!parsed.success) return; // unknown / future event type: ignore, never crash the stream
    // `lastEventId` is only trusted when it belongs to the boot we said hello to.
    if (e.lastEventId && this.bootId && e.lastEventId.startsWith(`${this.bootId}.`)) {
      this.lastEventId = e.lastEventId;
    }
    const event = parsed.data;
    useSseStore.getState().set({ lastEventAt: Date.now() });
    this.queue(invalidationsFor(event));
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch {
        /* one broken subscriber must not stop the others or the stream */
      }
    }
  }

  private touch(): void {
    this.lastFrameAt = Date.now();
    useSseStore.getState().set({ lastFrameAt: this.lastFrameAt });
  }

  private checkStale(): void {
    if (!this.running || !this.source) return;
    if (Date.now() - this.lastFrameAt > this.staleAfterMs) {
      this.closeSource();
      this.scheduleReconnect();
    }
  }

  private closeSource(): void {
    if (!this.source) return;
    this.source.onerror = null;
    this.source.onmessage = null;
    this.source.close();
    this.source = null;
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.attempt += 1;
    useSseStore.getState().set({ state: 'reconnecting', attempt: this.attempt });
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1));
    const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5)); // jitter: 50-100 %
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  /* ── batched invalidation ── */

  private queueAll(): void {
    this.pendingAll = true;
    this.armFlush();
  }

  private queue(inv: Invalidation): void {
    if (inv === 'all') return this.queueAll();
    if (inv.length === 0) return;
    for (const key of inv) this.pending.set(JSON.stringify(key), key);
    this.armFlush();
  }

  private armFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const all = this.pendingAll;
    const keys = [...this.pending.values()];
    this.pendingAll = false;
    this.pending.clear();
    // Active queries refetch now; inactive ones are only marked stale and refetch when next shown.
    if (all) void this.qc.invalidateQueries();
    else for (const queryKey of keys) void this.qc.invalidateQueries({ queryKey });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/* ───────────────────────── page-level singleton + hook ───────────────────────── */

let client: EventStreamClient | null = null;

/** The page's one stream client (created on first use, so StrictMode remounts keep the resume position). */
export function getEventStream(): EventStreamClient {
  client ??= new EventStreamClient(queryClient);
  return client;
}

/** Mount once, in the app shell: opens `GET /api/events` and keeps TanStack Query fresh from it. */
export function useEventStream(): void {
  useEffect(() => {
    const c = getEventStream();
    c.start();
    return () => c.stop();
  }, []);
}
