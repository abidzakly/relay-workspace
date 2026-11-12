import { useEffect, useState } from 'react';

/** Re-renders on an interval, so anything measured from "now" does not go stale on a long-lived tab. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
