/** Resolves on `drain`, or at once when the viewer has gone (a closed socket never drains). */
export function drained(
  out: { once(e: 'drain', f: () => void): unknown; off(e: 'drain', f: () => void): unknown },
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      out.off('drain', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    out.once('drain', done);
    signal.addEventListener('abort', done, { once: true });
  });
}
