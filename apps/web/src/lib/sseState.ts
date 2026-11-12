import { create } from 'zustand';

/**
 * - `connecting`   first attempt of this page load
 * - `live`         the server said hello and frames keep arriving
 * - `reconnecting` the stream dropped (or went silent); retrying with backoff
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

interface SseConnection {
  state: ConnectionState;
  /** Consecutive failed attempts since the last hello (0 while live). */
  attempt: number;
  /** Last frame of any kind (hello, ping, event). */
  lastFrameAt: number | null;
  /** Last real event (not a heartbeat). */
  lastEventAt: number | null;
  set: (patch: Partial<Omit<SseConnection, 'set'>>) => void;
}

/** Connection state of `GET /api/events`. In memory only; written by `lib/sse.ts`, read by the UI. */
export const useSseStore = create<SseConnection>()((set) => ({
  state: 'connecting',
  attempt: 0,
  lastFrameAt: null,
  lastEventAt: null,
  set: (patch) => set(patch),
}));

export const FALLBACK_POLL_MS = 30_000;

/**
 * The UI is push-driven, no client polling. The only exception is a safety net: while the
 * stream is NOT live, views refetch every 30 s so a dead stream never leaves the screen stale.
 * Use as `refetchInterval: useFallbackPollMs()`.
 */
export function useFallbackPollMs(ms: number = FALLBACK_POLL_MS): number | false {
  const live = useSseStore((s) => s.state === 'live');
  return live ? false : ms;
}
