import { useEffect, useState } from 'react';
import {
  BUILD_FRAME_END,
  BUILD_FRAME_LINE,
  BUILD_FRAME_TRUNCATED,
  buildLogPath,
  type BuildLogTruncation,
} from '@relay/shared';
import { cleanLogLine } from './cleanLogLine';

export const MAX_LINES = 20_000;
const FLUSH_MS = 100;

export interface BuildLog {
  lines: string[];
  truncations: BuildLogTruncation[];
  /** The stream said the log is complete. */
  ended: boolean;
  /** The stream gave up reconnecting. */
  lost: boolean;
}

const EMPTY: BuildLog = { lines: [], truncations: [], ended: false, lost: false };

/**
 * One build's log, streamed once for both the picture and the plain view. Lines arrive in batches, or a chatty build
 * would re-render per line. Null `jobId` streams nothing.
 */
export function useBuildLog(jobId: string | null): BuildLog {
  const [log, setLog] = useState<BuildLog>(EMPTY);

  useEffect(() => {
    setLog(EMPTY);
    if (jobId === null) return;
    const source = new EventSource(buildLogPath(jobId));
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = 0;

    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setLog((prev) => {
        const next = prev.lines.concat(batch);
        return { ...prev, lines: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next };
      });
    };

    source.onopen = () => {
      setLog((prev) => ({ ...prev, lost: false }));
      // With no line id yet, the server starts over.
      if (lastSeq !== 0) return;
      pending = [];
      setLog((prev) => ({ ...prev, lines: [], truncations: [] }));
    };
    source.addEventListener(BUILD_FRAME_LINE, (e) => {
      const message = e as MessageEvent<string>;
      const seq = Number.parseInt(message.lastEventId, 10);
      if (Number.isSafeInteger(seq)) lastSeq = seq;
      pending.push(cleanLogLine((JSON.parse(message.data) as { line: string }).line));
      timer ??= setTimeout(flush, FLUSH_MS);
    });
    source.addEventListener(BUILD_FRAME_TRUNCATED, (e) => {
      const { reason } = JSON.parse((e as MessageEvent<string>).data) as {
        reason: BuildLogTruncation;
      };
      setLog((prev) =>
        prev.truncations.includes(reason)
          ? prev
          : { ...prev, truncations: [...prev.truncations, reason] },
      );
    });
    source.addEventListener(BUILD_FRAME_END, () => {
      source.close();
      flush();
      setLog((prev) => ({ ...prev, ended: true }));
    });
    source.onerror = () => {
      // EventSource retries by itself unless it has given up.
      if (source.readyState === EventSource.CLOSED) setLog((prev) => ({ ...prev, lost: true }));
    };

    return () => {
      source.close();
      if (timer !== null) clearTimeout(timer);
    };
  }, [jobId]);

  return log;
}
