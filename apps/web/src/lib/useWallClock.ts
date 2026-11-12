import { useSyncExternalStore } from 'react';

/**
 * One wall clock for the whole page, ticking on each minute boundary (and when a hidden tab comes back, since hidden
 * tabs throttle timers). The header clock and the Living Workspace's daylight read it, so the hour on screen and the
 * light in the scene never disagree.
 */
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function tick() {
  now = Date.now();
  clearTimeout(timer);
  timer = setTimeout(tick, 60_000 - (now % 60_000) + 50);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    tick();
    document.addEventListener('visibilitychange', tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
    }
  };
}

const snapshot = () => now;

/** Milliseconds since the epoch, updated once a minute, on the minute. */
export function useWallClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
