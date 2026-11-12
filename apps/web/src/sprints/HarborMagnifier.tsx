import * as DialogPrimitive from '@radix-ui/react-dialog';
import { MoveHorizontal, X } from 'lucide-react';
import { useCallback, useRef, useState, type CSSProperties } from 'react';
import type { Sprint, SprintTask } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import { HarborScene, ZONE_LABEL, type TapPoint } from './HarborScene';
import {
  HARBOR_ZONES,
  layoutHarbor,
  widenBox,
  zoneBox,
  zoneCrates,
  type HarborZone,
} from './harborLayout';

/** Scene units → px inside the lens. A crate is 26 units tall, so ≥ 1.75 makes it a ≥ 44 px touch target. */
const MIN_ZOOM = 1.75;
/** A narrow zone (the crane) is widened instead of blown up past this, so it keeps its context. */
const MAX_ZOOM = 2.2;
/** Matches the `.lens` transition in index.css, so the dialog unmounts after the shrink finishes. */
const LEAVE_MS = 380;
const LENS_MAX_W = 448;

/**
 * Phone-portrait "Magnify": a liquid-glass lens that grows out of the tap point and shows one zone of the harbor
 * (quay, crane or ship) enlarged, so its crates are big enough to tap. Picking a crate shrinks the lens back into the
 * scene and hands the task to the page. Radix Dialog gives the focus trap, Esc and the screen-reader title.
 */
export function HarborMagnifier({
  sprint,
  tasks,
  selectedId,
  zone,
  origin,
  onZone,
  onClose,
  onPick,
}: {
  sprint: Sprint;
  tasks: readonly SprintTask[];
  selectedId: string | null;
  zone: HarborZone;
  origin: TapPoint;
  onZone: (z: HarborZone) => void;
  onClose: () => void;
  onPick: (t: SprintTask) => void;
}) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<'from' | 'open'>('from');
  const [lensOrigin, setLensOrigin] = useState<{ x: number; y: number } | null>(null);
  const leaving = useRef(false);

  // A callback ref, not an effect: Radix's Portal mounts the lens one render later, so a layout effect would still
  // see `null`. Measure where the tap lies inside the (untransformed) lens, then flip to `open` two frames later so
  // the browser has painted the `from` state and the transition runs.
  const lensRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      setLensOrigin({ x: origin.x - el.offsetLeft, y: origin.y - el.offsetTop });
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          if (!leaving.current) setPhase('open');
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    },
    [origin.x, origin.y],
  );

  const leave = (then: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    setPhase('from');
    window.setTimeout(then, reduced ? 150 : LEAVE_MS);
  };

  const L = layoutHarbor(sprint, tasks);
  const viewportW = typeof window === 'undefined' ? 390 : window.innerWidth;
  // Lens = viewport minus the 12 px page gutter and the lens's own 8 px padding on each side.
  const windowW = Math.min(viewportW - 24, LENS_MAX_W) - 16;
  const tight = zoneBox(L, zone);
  const zoom = Math.min(Math.max(windowW / tight.w, MIN_ZOOM), MAX_ZOOM);
  const box = widenBox(tight, windowW / zoom);
  const sceneW = Math.round(box.w * zoom);
  const overflows = sceneW > windowW + 1;
  const count = zoneCrates(L, zone).length;

  const lensStyle = lensOrigin
    ? ({ '--ox': `${lensOrigin.x}px`, '--oy': `${lensOrigin.y}px` } as CSSProperties)
    : undefined;

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && leave(onClose)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-phase={phase}
          className="lens-backdrop fixed inset-0 z-50 bg-scrim/35 backdrop-blur-[3px]"
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-center justify-center p-3 outline-none"
          // The content box covers the screen: a tap beside the lens counts as "outside".
          onClick={(e) => e.target === e.currentTarget && leave(onClose)}
        >
          <div
            ref={lensRef}
            data-phase={phase}
            style={lensStyle}
            className="liquid-glass lens flex w-full flex-col gap-2 p-2"
          >
            <div className="flex items-center gap-2 pl-3">
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
                {ZONE_LABEL[zone]}
                <span className="font-normal text-muted-foreground">
                  {' '}
                  · {count} container{count === 1 ? '' : 's'}
                </span>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                aria-label="Close magnifier"
                className="lens-chip inline-flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-5" />
              </DialogPrimitive.Close>
            </div>

            <div className="relative overflow-hidden rounded-sheet">
              <div className="max-h-[58svh] overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="lens-zoom relative w-fit">
                  <HarborScene
                    sprint={sprint}
                    tasks={tasks}
                    selectedId={selectedId}
                    onPick={(t) => leave(() => onPick(t))}
                    viewBox={box}
                    zone={zone}
                    still
                    style={{ width: sceneW }}
                  />
                  {count === 0 && (
                    <p className="absolute inset-x-0 bottom-3 text-center text-sm font-medium text-harbor-label drop-shadow">
                      Nothing here in this sprint.
                    </p>
                  )}
                </div>
              </div>
              {/* The glass edge of the lens: highlights and shade over the picture, never in the way of a tap. */}
              <div
                aria-hidden
                className="lens-rim pointer-events-none absolute inset-0 rounded-sheet"
              />
              {overflows && (
                <span className="lens-chip pointer-events-none absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-medium">
                  <MoveHorizontal className="size-3.5" aria-hidden />
                  Swipe
                </span>
              )}
            </div>

            <div
              className="lens-chip grid grid-cols-3 gap-1 rounded-full p-1"
              role="group"
              aria-label="Zone"
            >
              {HARBOR_ZONES.map((z) => {
                const n = zoneCrates(L, z).length;
                return (
                  <button
                    key={z}
                    type="button"
                    aria-pressed={z === zone}
                    onClick={() => onZone(z)}
                    className={cn(
                      'h-10 rounded-full text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      z === zone ? 'lens-segment-on' : 'text-muted-foreground',
                    )}
                  >
                    {ZONE_LABEL[z]} <span className="tabular-nums opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
