import { randomUUID } from 'node:crypto';
import type { AppEvent, AppEventType } from '@relay/shared';
import type { Logger } from '../util/logger';

type Handler<T extends AppEventType> = (event: Extract<AppEvent, { type: T }>) => void;
type AnyHandler = (event: AppEvent) => void;

/** An event as the SSE endpoint sees it: `id` is `<bootId>.<seq>`, or null for events that are never replayed. */
export interface BusEnvelope {
  id: string | null;
  seq: number | null;
  event: AppEvent;
}
type EnvelopeHandler = (env: BusEnvelope) => void;

/** Events that are delivered live but never buffered or numbered (high volume; `job.log` has its own stream). */
const UNBUFFERED: ReadonlySet<AppEventType> = new Set<AppEventType>(['job.log', 'ping']);
/** How many numbered events are kept for `Last-Event-ID` resume. */
export const REPLAY_BUFFER_SIZE = 500;

/** Outcome of asking for the events a reconnecting client missed. */
export type Replay =
  | { kind: 'fresh'; events: [] } // no (usable) Last-Event-ID: nothing to replay
  | { kind: 'resumed'; events: BusEnvelope[] } // the buffer covers the whole gap (may be empty)
  | { kind: 'gap'; events: [] } // same boot, but the buffer no longer reaches back far enough
  | { kind: 'restart'; events: [] }; // the id belongs to a previous server process

/**
 * In-process typed event emitter over the shared `AppEvent` union (UI is push-driven).
 * The SSE endpoint (`http/sse.ts`) subscribes with `onEnvelope` and forwards events as they are.
 *  - Synchronous delivery; a throwing listener is logged and never affects the emitter or other listeners.
 *  - Events carry ids / counts only, never secrets.
 *  - Every event except `job.log` gets a sequence number and is kept in a bounded ring buffer
 *    (`REPLAY_BUFFER_SIZE`), so a client that reconnects with `Last-Event-ID` can be caught up.
 */
export class EventBus {
  /** Random per process: an id from an earlier run must never be replayed against this one. */
  readonly bootId = randomUUID();
  private readonly typed = new Map<AppEventType, Set<AnyHandler>>();
  private readonly any = new Set<AnyHandler>();
  private readonly envelopes = new Set<EnvelopeHandler>();
  private readonly buffer: BusEnvelope[] = [];
  private seq = 0;

  constructor(private readonly log?: Logger) {}

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<T extends AppEventType>(type: T, handler: Handler<T>): () => void {
    const set = this.typed.get(type) ?? new Set<AnyHandler>();
    const wrapped = handler as unknown as AnyHandler;
    set.add(wrapped);
    this.typed.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onAny(handler: AnyHandler): () => void {
    this.any.add(handler);
    return () => {
      this.any.delete(handler);
    };
  }

  /** Subscribe to every event together with its id (for SSE). Returns an unsubscribe function. */
  onEnvelope(handler: EnvelopeHandler): () => void {
    this.envelopes.add(handler);
    return () => {
      this.envelopes.delete(handler);
    };
  }

  /** Id of the newest numbered event (`<bootId>.<seq>`), or null before the first one. */
  lastId(): string | null {
    return this.seq === 0 ? null : `${this.bootId}.${this.seq}`;
  }

  /**
   * What did a client that last saw `lastEventId` miss? Pure read of the ring buffer.
   * Call it and subscribe in the same synchronous block so nothing falls between the two.
   */
  replaySince(lastEventId: string | undefined | null): Replay {
    if (!lastEventId) return { kind: 'fresh', events: [] };
    const dot = lastEventId.lastIndexOf('.');
    const boot = dot > 0 ? lastEventId.slice(0, dot) : '';
    const n = dot > 0 ? Number(lastEventId.slice(dot + 1)) : NaN;
    if (!boot || !Number.isSafeInteger(n) || n < 0) return { kind: 'fresh', events: [] }; // garbage
    if (boot !== this.bootId) return { kind: 'restart', events: [] };
    if (n > this.seq) return { kind: 'gap', events: [] };
    if (n === this.seq) return { kind: 'resumed', events: [] };
    const oldest = this.buffer[0]?.seq ?? null;
    if (oldest === null || oldest > n + 1) return { kind: 'gap', events: [] };
    return { kind: 'resumed', events: this.buffer.filter((e) => (e.seq ?? 0) > n) };
  }

  emit(event: AppEvent): void {
    let env: BusEnvelope;
    if (UNBUFFERED.has(event.type)) {
      env = { id: null, seq: null, event };
    } else {
      this.seq += 1;
      env = { id: `${this.bootId}.${this.seq}`, seq: this.seq, event };
      this.buffer.push(env);
      if (this.buffer.length > REPLAY_BUFFER_SIZE) this.buffer.shift();
    }
    const handlers = [...(this.typed.get(event.type) ?? []), ...this.any];
    for (const h of handlers) {
      try {
        h(event);
      } catch (e) {
        this.log?.error({ type: event.type, err: (e as Error).name }, 'event listener threw');
      }
    }
    for (const h of [...this.envelopes]) {
      try {
        h(env);
      } catch (e) {
        this.log?.error({ type: event.type, err: (e as Error).name }, 'event listener threw');
      }
    }
  }

  listenerCount(): number {
    let n = this.any.size + this.envelopes.size;
    for (const s of this.typed.values()) n += s.size;
    return n;
  }
}
