import type { SyncStatus } from '@relay/shared';
import type { Logger } from '../util/logger';
import type { SyncEngine } from './syncEngine';

/** cadence. */
export const INCREMENTAL_INTERVAL_MS = 45_000;
export const FULL_INTERVAL_MS = 10 * 60_000;
/** Max wait for the run in progress when shutting down. */
const STOP_GRACE_MS = 15_000;

export interface PollerOptions {
  engine: SyncEngine;
  log: Logger;
  incrementalMs?: number;
  fullMs?: number;
  now?: () => number;
}

/**
 * Schedules the engine:
 *  1. `start()` = startup catch-up: one full sync right away (does not block boot: the caller need not await it),
 *  2. Notion incremental every ~45 s,
 *  3. full reconcile every 10 min.
 * Timers are self-rescheduling `setTimeout`s (never `setInterval`), so ticks cannot pile up; the engine's
 * overlap guard is the second line of defence (an incremental tick during a run is dropped, a full one is queued).
 * A failing run never stops the schedule.
 */
export class Poller {
  private readonly incrementalMs: number;
  private readonly fullMs: number;
  private readonly now: () => number;
  private incTimer: NodeJS.Timeout | undefined;
  private fullTimer: NodeJS.Timeout | undefined;
  private nextIncrementalAt: number | null = null;
  private nextFullAt: number | null = null;
  private started = false;
  private stopped = false;
  private catchUpDone = false;
  private catchUp: Promise<void> | undefined;

  constructor(private readonly o: PollerOptions) {
    this.incrementalMs = o.incrementalMs ?? INCREMENTAL_INTERVAL_MS;
    this.fullMs = o.fullMs ?? FULL_INTERVAL_MS;
    this.now = o.now ?? Date.now;
  }

  /** Starts the schedule and the catch-up sync. Resolves when the catch-up run is done. Idempotent. */
  start(): Promise<void> {
    if (this.catchUp) return this.catchUp;
    this.started = true;
    this.scheduleIncremental();
    this.scheduleFull();
    this.o.log.info(
      { incrementalMs: this.incrementalMs, fullMs: this.fullMs },
      'poller started (startup catch-up sync running)',
    );
    this.catchUp = this.o.engine
      .runFull()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.catchUpDone = true;
      });
    return this.catchUp;
  }

  /** Stops timers and waits (bounded) for the run in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.incTimer) clearTimeout(this.incTimer);
    if (this.fullTimer) clearTimeout(this.fullTimer);
    this.incTimer = this.fullTimer = undefined;
    this.nextIncrementalAt = this.nextFullAt = null;
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      this.o.engine.close(),
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, STOP_GRACE_MS);
      }),
    ]);
    if (grace) clearTimeout(grace);
  }

  /** Engine status + this poller's schedule. */
  status(): SyncStatus {
    return {
      ...this.o.engine.status(),
      schedule: this.started
        ? {
            incrementalMs: this.incrementalMs,
            fullMs: this.fullMs,
            nextIncrementalAt: this.nextIncrementalAt,
            nextFullAt: this.nextFullAt,
            catchUpDone: this.catchUpDone,
          }
        : null,
    };
  }

  private scheduleIncremental(): void {
    if (this.stopped) return;
    this.nextIncrementalAt = this.now() + this.incrementalMs;
    this.incTimer = setTimeout(() => {
      void this.o.engine
        .runIncremental()
        .catch(() => undefined)
        .finally(() => {
          this.scheduleIncremental();
        });
    }, this.incrementalMs);
    this.incTimer.unref();
  }

  private scheduleFull(): void {
    if (this.stopped) return;
    this.nextFullAt = this.now() + this.fullMs;
    this.fullTimer = setTimeout(() => {
      void this.o.engine
        .runFull()
        .catch(() => undefined)
        .finally(() => {
          this.scheduleFull();
        });
    }, this.fullMs);
    this.fullTimer.unref();
  }
}
