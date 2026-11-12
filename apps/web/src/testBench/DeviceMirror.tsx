import {
  ArrowLeft,
  Camera,
  Circle,
  Keyboard,
  Loader2,
  RefreshCw,
  Smartphone,
  Square,
} from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DeviceControl, MirrorMeta } from '@relay/shared';
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openMirror, screenshotUrl, sendControl } from '@/lib/testBenchApi';
import { cn } from '@/lib/utils';
import { mirrorPackets } from './mirrorStream';

/**
 * Live phone screen with input. Video: the server's binary stream decoded with WebCodecs.
 * Input: pointer events mapped to 0..1 of the frame, batched once per animation frame. Without WebCodecs it falls back
 * to a screenshot every ~2 s (view only). A calm zone: no reward effects here.
 */

export interface DeviceMirrorHandle {
  /** The current frame as PNG (decoder snapshot, else an adb screenshot). */
  snapshot(): Promise<Blob | null>;
}

type Phase = 'idle' | 'connecting' | 'live' | 'ended' | 'error';

export const DeviceMirror = forwardRef<
  DeviceMirrorHandle,
  { serial: string; className?: string; overlay?: { src: string; opacity: number } | null }
>(function DeviceMirror({ serial, className, overlay }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const decoderRef = useRef<WebCodecsVideoDecoder | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [typing, setTyping] = useState('');
  const supported = typeof window !== 'undefined' && WebCodecsVideoDecoder.isSupported;
  const [still, setStill] = useState<string | null>(null);

  // ── video
  useEffect(() => {
    if (!supported) return;
    const abort = new AbortController();
    const el = host.current;
    let decoder: WebCodecsVideoDecoder | null = null;
    setPhase('connecting');
    setError(null);
    void (async () => {
      try {
        const body = await openMirror(serial, abort.signal);
        const packets = mirrorPackets(body, {
          onMeta: (meta: MirrorMeta) => {
            const renderer = WebGLVideoFrameRenderer.isSupported
              ? new WebGLVideoFrameRenderer()
              : new BitmapVideoFrameRenderer();
            const canvas = renderer.canvas as HTMLCanvasElement;
            canvas.className = 'block h-full w-full object-contain';
            el?.replaceChildren(canvas);
            decoder = new WebCodecsVideoDecoder({ codec: meta.codec as never, renderer });
            decoderRef.current = decoder;
            decoder.sizeChanged((s) => setSize(s));
            if (meta.width && meta.height) setSize({ width: meta.width, height: meta.height });
            setPhase('live');
          },
          onSize: (s) => setSize(s),
        });
        // Wait for the first meta frame to have built the decoder.
        for (let i = 0; i < 100 && !decoder; i++) await new Promise((r) => setTimeout(r, 30));
        if (!decoder) throw new Error('The phone sent no video.');
        await packets.pipeTo((decoder as WebCodecsVideoDecoder).writable, { signal: abort.signal });
        setPhase('ended');
      } catch (e) {
        if (abort.signal.aborted) return;
        setError((e as Error).message);
        setPhase('error');
      }
    })();
    return () => {
      abort.abort();
      decoder?.dispose();
      decoderRef.current = null;
    };
  }, [serial, attempt, supported]);

  // ── fallback: screenshots
  useEffect(() => {
    if (supported) return;
    setPhase('live');
    const tick = () => setStill(screenshotUrl(serial));
    tick();
    const t = setInterval(tick, 2_000);
    return () => clearInterval(t);
  }, [serial, supported]);

  // ── input, batched per frame
  const pending = useRef<DeviceControl[]>([]);
  const flushing = useRef(false);
  const queue = useCallback(
    (ev: DeviceControl) => {
      // Consecutive moves collapse into the latest one.
      const last = pending.current.at(-1);
      if (
        ev.kind === 'touch' &&
        ev.action === 'move' &&
        last?.kind === 'touch' &&
        last.action === 'move'
      ) {
        pending.current[pending.current.length - 1] = ev;
      } else pending.current.push(ev);
      if (flushing.current) return;
      flushing.current = true;
      requestAnimationFrame(() => {
        const events = pending.current.splice(0, 64);
        flushing.current = false;
        if (events.length)
          void sendControl(serial, events).catch((e) => setError((e as Error).message));
      });
    },
    [serial],
  );

  const pointer = (action: 'down' | 'move' | 'up') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase !== 'live' || !supported) return;
    if (action === 'move' && e.buttons === 0) return;
    e.preventDefault();
    if (action === 'down') e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    // The canvas is letterboxed (object-contain): map into the video's own box.
    const ratio = size ? size.width / size.height : r.width / r.height;
    const boxW = Math.min(r.width, r.height * ratio);
    const boxH = boxW / ratio;
    const x = (e.clientX - r.left - (r.width - boxW) / 2) / boxW;
    const y = (e.clientY - r.top - (r.height - boxH) / 2) / boxH;
    if (action === 'down' && (x < 0 || x > 1 || y < 0 || y > 1)) return;
    queue({
      kind: 'touch',
      action,
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      pointerId: 0,
    });
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (phase !== 'live' || !supported) return;
    const r = e.currentTarget.getBoundingClientRect();
    queue({
      kind: 'scroll',
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      dx: Math.max(-16, Math.min(16, -e.deltaX / 50)),
      dy: Math.max(-16, Math.min(16, -e.deltaY / 50)),
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      async snapshot() {
        const shot = await decoderRef.current?.snapshot().catch(() => undefined);
        if (shot) return shot;
        const res = await fetch(screenshotUrl(serial)).catch(() => null);
        return res?.ok ? await res.blob() : null;
      },
    }),
    [serial],
  );

  const ratio = size ? `${size.width} / ${size.height}` : '9 / 19.5';

  return (
    <div className={cn('flex min-h-0 flex-col items-center gap-3', className)}>
      <div
        className="relative max-w-full overflow-hidden rounded-sheet border-4 border-foreground/80 bg-foreground shadow-lift"
        // Sized by height so the whole phone fits on screen next to the checklist.
        style={{ aspectRatio: ratio, height: 'min(64vh, 44rem)' }}
      >
        <div
          ref={host}
          className={cn(
            'absolute inset-0 touch-none select-none',
            supported && phase === 'live' && 'cursor-pointer',
          )}
          onPointerDown={pointer('down')}
          onPointerMove={pointer('move')}
          onPointerUp={pointer('up')}
          onPointerCancel={pointer('up')}
          onWheel={onWheel}
          aria-label="Phone screen"
        />
        {overlay && (
          <img
            src={overlay.src}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full object-fill"
            style={{ opacity: overlay.opacity }}
          />
        )}
        {!supported && still && (
          <img
            src={still}
            alt="Phone screen (refreshes every 2 seconds)"
            className="absolute inset-0 size-full object-contain"
          />
        )}
        {phase !== 'live' && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-background">
            {phase === 'connecting' && (
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 motion-safe:animate-spin" /> Starting the mirror…
              </p>
            )}
            {(phase === 'error' || phase === 'ended') && (
              <div className="grid justify-items-center gap-3">
                <Smartphone className="size-6" />
                <p className="text-sm">{phase === 'ended' ? 'The mirror stopped.' : error}</p>
                <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                  <RefreshCw className="size-4" /> Reconnect
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {!supported && (
        <p className="text-xs text-muted-foreground">
          This browser has no WebCodecs: showing a screenshot every 2 seconds, view only.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Back"
          onClick={() => queue({ kind: 'key', key: 'back' })}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Home"
          onClick={() => queue({ kind: 'key', key: 'home' })}
        >
          <Circle className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Recent apps"
          onClick={() => queue({ kind: 'key', key: 'app_switch' })}
        >
          <Square className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Save a screenshot"
          onClick={() => window.open(screenshotUrl(serial), '_blank', 'noopener')}
        >
          <Camera className="size-4" />
        </Button>
      </div>

      <form
        className="flex w-full max-w-sm items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!typing) return;
          queue({ kind: 'text', text: typing.slice(0, 300) });
          setTyping('');
        }}
      >
        <Keyboard className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          placeholder="Type into the focused field"
          aria-label="Text to type on the phone"
          disabled={phase !== 'live' || !supported}
        />
      </form>
      {phase === 'live' && error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
});
