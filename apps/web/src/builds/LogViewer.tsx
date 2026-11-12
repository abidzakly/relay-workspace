import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BUILD_FRAME_END,
  BUILD_FRAME_LINE,
  BUILD_FRAME_TRUNCATED,
  buildLogPath,
  type BuildLogTruncation,
} from '@relay/shared';
import { Button } from '@/components/ui/button';
import { cleanLogLine } from './cleanLogLine';

const MAX_LINES = 20_000;
const FLUSH_MS = 100;
const BOTTOM_SLACK_PX = 24;

const TRUNCATION_TEXT: Record<BuildLogTruncation, string> = {
  stored:
    'This log is cut: only the newest 64 KB of a finished build is kept, so the earlier lines are gone.',
  buffer: 'The oldest lines of this running build have left its 2 MB buffer and cannot be shown.',
  gap: 'The build ended while the stream was reconnecting, and its stored log is cut, so lines may be missing here. Reopening shows the newest 64 KB.',
};

/**
 * One build's log. Plain text in a `pre`, so nothing in the output can become markup. Mount with `key={jobId}`. Lines
 * arrive in batches, or a chatty build would re-render per line. Scrolling up pauses following, and scrolling back down
 * to the end resumes it.
 */
export function LogViewer({ jobId }: { jobId: string }) {
  const box = useRef<HTMLPreElement>(null);
  const lastTop = useRef(0);
  const [lines, setLines] = useState<string[]>([]);
  const [truncations, setTruncations] = useState<BuildLogTruncation[]>([]);
  const [clipped, setClipped] = useState(false);
  const [ended, setEnded] = useState(false);
  const [lost, setLost] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
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
      setLines((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    };

    source.onopen = () => {
      setLost(false);
      // With no line id yet, the server starts over.
      if (lastSeq !== 0) return;
      pending = [];
      setLines([]);
      setTruncations([]);
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
      setTruncations((prev) => (prev.includes(reason) ? prev : [...prev, reason]));
    });
    source.addEventListener(BUILD_FRAME_END, () => {
      source.close();
      flush();
      setEnded(true);
    });
    source.onerror = () => {
      // EventSource retries by itself unless it has given up.
      if (source.readyState === EventSource.CLOSED) setLost(true);
    };

    return () => {
      source.close();
      if (timer !== null) clearTimeout(timer);
    };
  }, [jobId]);

  if (lines.length >= MAX_LINES && !clipped) setClipped(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    if (!atEnd) setPaused(true);
    else if (el.scrollTop > lastTop.current) setPaused(false);
    lastTop.current = el.scrollTop;
  };

  return (
    <div className="grid gap-2">
      {truncations.map((reason) => (
        <p key={reason} className="text-xs text-warning">
          {TRUNCATION_TEXT[reason]}
        </p>
      ))}
      {clipped && (
        <p className="text-xs text-warning">
          Only the newest {MAX_LINES.toLocaleString()} lines are shown here.
        </p>
      )}
      <pre
        ref={box}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label="Build log"
        tabIndex={0}
        className="h-96 overflow-auto rounded-md bg-terminal p-3 font-mono text-xs whitespace-pre text-terminal-foreground"
      >
        {lines.join('\n')}
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {lines.length.toLocaleString()} lines
          {ended ? ', log complete' : ', following'}
        </span>
      </div>
      {lost && (
        <p role="alert" className="text-xs text-destructive">
          The log stream was lost. Reload the page to reconnect. A running build keeps running.
        </p>
      )}
    </div>
  );
}
