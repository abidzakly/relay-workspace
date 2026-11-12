import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  PTY_COLS,
  PTY_FRAME_END,
  PTY_FRAME_OUTPUT,
  PTY_FRAME_TRUNCATED,
  PTY_ROWS,
  ptyStreamPath,
} from '@relay/shared';

/**
 * Read-only view of one PTY job's stream, loaded on demand because xterm is large. `disableStdin` and the absence of any
 * write path are deliberate: keystrokes here must never reach `vu`.
 */
export default function PtyTerminal({ jobId }: { jobId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cols: PTY_COLS,
      rows: PTY_ROWS,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    });
    term.open(host.current);

    const source = new EventSource(ptyStreamPath(jobId));
    source.addEventListener(PTY_FRAME_OUTPUT, (e) => {
      setLost(false);
      term.write((JSON.parse((e as MessageEvent<string>).data) as { data: string }).data);
    });
    source.addEventListener(PTY_FRAME_TRUNCATED, () => {
      term.writeln('[older output is no longer available]');
    });
    source.addEventListener(PTY_FRAME_END, () => source.close());
    source.onerror = () => {
      // EventSource retries by itself unless it has given up.
      if (source.readyState === EventSource.CLOSED) setLost(true);
    };

    return () => {
      source.close();
      term.dispose();
    };
  }, [jobId]);

  return (
    <div className="grid gap-1">
      <div
        ref={host}
        role="log"
        aria-label="vu terminal output"
        className="max-w-full overflow-x-auto rounded-md bg-terminal p-1"
      />
      {lost && (
        <p role="alert" className="text-xs text-destructive">
          The output stream was lost. Reload the page to reconnect. The job itself keeps running.
        </p>
      )}
    </div>
  );
}
