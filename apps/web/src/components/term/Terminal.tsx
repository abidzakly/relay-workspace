import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { CockpitSession } from '@relay/shared';
import { resizeSession, sendInput } from '@/lib/sessionApi';

/**
 * Interactive terminal for a cockpit session: the release viewer's xterm, with stdin on.
 * Output comes over SSE from an offset; after a phone lock / network drop it reconnects with `since` and the host's
 * ring buffer replays what was missed. Keystrokes are batched (one POST per ~16 ms). Lazy-loaded (xterm is big).
 */

export type TerminalMood = 'start' | 'working' | 'waiting' | 'idle' | 'done' | 'failed';

export interface TerminalHandle {
  focus(): void;
  /** Sends raw input (extra-key bar, chips). */
  send(data: string): void;
}

/** The DM Mono face of the design system. */
function monoFont(): string {
  const f = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return f || "'DM Mono', ui-monospace, 'SF Mono', Menlo, monospace";
}

const Terminal = forwardRef<
  TerminalHandle,
  {
    sessionId: string;
    /** Every output chunk (Run view parses status / DevTools links). */
    onOutput?: (data: string) => void;
    onState?: (s: CockpitSession) => void;
    fontSize?: number;
    /** The agent's state (kept for callers; the terminal itself stays plain). */
    mood?: TerminalMood;
  }
>(function Terminal({ sessionId, onOutput, onState, fontSize = 13 }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const pending = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<'live' | 'reconnecting' | 'ended'>('live');
  const cb = useRef({ onOutput, onState });
  cb.current = { onOutput, onState };

  const send = (data: string) => {
    pending.current += data;
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      const d = pending.current;
      pending.current = '';
      flushTimer.current = null;
      if (d) void sendInput(sessionId, d).catch(() => undefined);
    }, 16);
  };

  useImperativeHandle(ref, () => ({ focus: () => term.current?.focus(), send }), [sessionId]);

  useEffect(() => {
    if (!host.current) return;
    const t = new XTerm({
      cursorBlink: true,
      scrollback: 10_000,
      fontSize,
      lineHeight: 1.2,
      fontFamily: monoFont(),
      allowProposedApi: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current);
    term.current = t;
    const doFit = () => {
      try {
        fit.fit();
        void resizeSession(sessionId, Math.max(20, t.cols), Math.max(5, t.rows)).catch(
          () => undefined,
        );
      } catch {
        /* not visible yet */
      }
    };
    requestAnimationFrame(doFit);
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host.current);
    const input = t.onData((d) => send(d));

    let offset = 0;
    let source: EventSource | null = null;
    let ended = false;
    const connect = () => {
      source?.close();
      source = new EventSource(
        `/api/cockpit/sessions/${encodeURIComponent(sessionId)}/stream?since=${offset}`,
      );
      source.addEventListener('out', (ev) => {
        const m = JSON.parse((ev as MessageEvent<string>).data) as { data: string; offset: number };
        // A replay overlapping what we have: keep only the new part.
        const skip = Math.max(0, offset - m.offset);
        const data = m.data.slice(skip);
        if (data) {
          t.write(data);
          cb.current.onOutput?.(data);
        }
        offset = Math.max(offset, m.offset + m.data.length);
        setStatus('live');
      });
      source.addEventListener('reset', (ev) => {
        const m = JSON.parse((ev as MessageEvent<string>).data) as { offset: number };
        t.reset();
        t.writeln('\x1b[2m[some older output is no longer available]\x1b[0m');
        offset = m.offset;
      });
      source.addEventListener('state', (ev) => {
        cb.current.onState?.(
          (JSON.parse((ev as MessageEvent<string>).data) as { session: CockpitSession }).session,
        );
      });
      source.addEventListener('exit', () => {
        ended = true;
        setStatus('ended');
        source?.close();
      });
      source.onerror = () => {
        if (ended) return;
        setStatus('reconnecting');
        if (source?.readyState === EventSource.CLOSED) setTimeout(connect, 1_500);
      };
    };
    connect();
    // Back from a locked phone / background tab: reconnect from the last offset right away.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ended) connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      input.dispose();
      source?.close();
      t.dispose();
      term.current = null;
    };
    // One terminal per session: callbacks are read through refs.
  }, [sessionId]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-surface bg-black p-2">
      <div ref={host} className="min-h-0 flex-1" role="application" aria-label="Terminal" />
      {status !== 'live' && (
        <span className="absolute top-2 right-3 rounded-full bg-black/80 px-2 py-0.5 text-2xs text-white/70">
          {status === 'ended' ? 'session ended' : 'reconnecting…'}
        </span>
      )}
    </div>
  );
});

export default Terminal;
