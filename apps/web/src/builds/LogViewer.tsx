import { useLayoutEffect, useRef, useState } from 'react';
import type { BuildLogTruncation } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { MAX_LINES, type BuildLog } from './useBuildLog';

const BOTTOM_SLACK_PX = 24;

const TRUNCATION_TEXT: Record<BuildLogTruncation, string> = {
  stored:
    'This log is cut: only the newest 64 KB of a finished build is kept, so the earlier lines are gone.',
  buffer: 'The oldest lines of this running build have left its 2 MB buffer and cannot be shown.',
  gap: 'The build ended while the stream was reconnecting, and its stored log is cut, so lines may be missing here. Reopening shows the newest 64 KB.',
};

/**
 * One build's log, from `useBuildLog`. Plain text in a `pre`, so nothing in the output can become markup. Scrolling up
 * pauses following, and scrolling back down to the end resumes it.
 */
export function LogViewer({ log }: { log: BuildLog }) {
  const { lines, truncations, ended, lost } = log;
  const box = useRef<HTMLPreElement>(null);
  const lastTop = useRef(0);
  const [clipped, setClipped] = useState(false);
  const [paused, setPaused] = useState(false);

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
