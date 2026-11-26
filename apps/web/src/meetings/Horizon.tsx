import { AnimatePresence, motion } from 'motion/react';
import { CalendarClock } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import {
  assignLanes,
  COMPACT_W,
  horizonScale,
  horizonTicks,
  nightBands,
  type HorizonZoom,
} from './horizonScale';
import {
  DAY_MS,
  dayLabel,
  duration,
  left,
  splitTitle,
  timeFmt,
  until,
  type Row,
} from './meetingView';
import {
  canMark,
  IconActions,
  JoinButton,
  ModeChip,
  PresenceActions,
  PresenceBadge,
  PriorityChip,
  TagChip,
} from './parts';
import { PriorityMenu } from './PriorityMenu';

/**
 * The Horizon: your meetings as beads on one thread of time. Now is the glowing orb at the left; the next hours get
 * most of the width and the month folds up at the right. Near meetings are big and bright, far ones shrink and fade,
 * except Key meetings, which keep a beam of light and their name however far away they are. Hover or focus a bead to
 * look closer through the lens; click to pin it; arrows walk the beads.
 */

const STAGE_H = 340;
const THREAD_Y = 228;
const LANE_TOP = [14, 46, 78, 110, 142, 174];
const CHIP_H = 26;
const PAD_L = 56;
const PAD_R = 28;
const MIN_W = 760;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Bead {
  m: Row;
  /** Left edge and width in px (a capsule when the meeting is wide enough, else a round bead). */
  left: number;
  width: number;
  size: number;
  opacity: number;
  center: number;
  lane: number | null;
  chipLeft: number;
  chipW: number;
  /** The label folded to its diamond (no room for the name). */
  compact: boolean;
}

const ZOOMS: { id: HorizonZoom; label: string; minDays: number }[] = [
  { id: 'today', label: 'Today', minDays: 1 },
  { id: 'week', label: 'Week', minDays: 3 },
  { id: 'month', label: 'Month', minDays: 8 },
];

export function Horizon({
  rows,
  now,
  lookAheadDays,
  focusId,
  focusSeq,
}: {
  rows: readonly Row[];
  now: number;
  lookAheadDays: number;
  /** A meeting picked elsewhere (the "Key ahead" chips): pinned and scrolled into view. */
  focusId: string | null;
  /** Bumped on every pick, so picking the same meeting twice still brings it back into view. */
  focusSeq: number;
}) {
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [zoom, setZoom] = useState<HorizonZoom>(lookAheadDays >= 7 ? 'week' : 'today');
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(MIN_W, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!focusId) return;
    setPinned(focusId);
    const el = stageRef.current?.querySelector<HTMLElement>(`[data-bead="${CSS.escape(focusId)}"]`);
    el?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center',
    });
    el?.focus({ preventScroll: true });
  }, [focusId, focusSeq, reduced]);

  const inner = width - PAD_L - PAD_R;
  const scale = useMemo(
    () => horizonScale(now, now + lookAheadDays * DAY_MS, zoom),
    // Re-scale once a minute, not on every tick: beads should not crawl.
    [Math.floor(now / 60_000), lookAheadDays, zoom],
  );
  const ticks = useMemo(() => horizonTicks(scale, inner), [scale, inner]);
  const nights = useMemo(() => nightBands(scale), [scale]);

  const beads = useMemo(() => {
    const visible = rows.filter((m) => m.phase !== 'over');
    const pre = visible.map((m) => {
      const f0 = scale.x(Math.max(m.start, now));
      const f1 = scale.x(m.end);
      const f = Math.min(1, f0);
      const key = m.priority === 'key';
      const quiet = m.priority === 'quiet';
      const size = key ? 16 : quiet ? lerp(11, 6, f) : lerp(16, 7, Math.pow(f, 0.7));
      const span = (f1 - f0) * inner;
      const capsule = span > size + 4;
      const x0 = PAD_L + f0 * inner;
      let opacity = key ? 1 : quiet ? lerp(0.6, 0.3, f) : lerp(1, 0.38, f);
      if ((m.dismissed || m.presence) && m.phase !== 'live') opacity *= 0.65;
      const chipW = Math.min(230, 34 + splitTitle(m.title).text.length * 6.4 + (key ? 14 : 0));
      return {
        m,
        size,
        opacity,
        left: capsule ? x0 : x0 - size / 2,
        width: capsule ? span : size,
        center: capsule ? x0 + span / 2 : x0,
        chipW,
        chipLeft: x0,
        labelled: key || (!quiet && f < 0.5) || m.phase === 'live',
      };
    });
    const lanes = assignLanes(
      pre
        .filter((b) => b.labelled)
        .map((b) => ({
          id: b.m.id,
          anchor: b.center,
          width: b.chipW,
          force: b.m.priority === 'key' || b.m.phase === 'live',
        })),
      LANE_TOP.length,
      { min: 8, max: width - 8 },
    );
    return pre.map((b): Bead => {
      const slot = b.labelled ? (lanes.get(b.m.id) ?? null) : null;
      return {
        ...b,
        lane: slot?.lane ?? null,
        chipLeft: slot?.left ?? b.chipLeft,
        chipW: slot?.compact ? COMPACT_W : b.chipW,
        compact: slot?.compact ?? false,
      };
    });
  }, [rows, scale, inner, width, now]);

  const open = beads.find((b) => b.m.id === (pinned ?? hover)) ?? null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      setPinned(null);
      setHover(null);
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const list = [...(stageRef.current?.querySelectorAll<HTMLElement>('[data-bead]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = list[i < 0 ? 0 : i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const zooms = ZOOMS.filter((z) => lookAheadDays >= z.minDays);

  return (
    <section aria-label="Meetings on a timeline" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-emphasis" aria-hidden>
              ◆
            </span>
            Key
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-foreground/70" aria-hidden />
            Meeting
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full border border-foreground/50" aria-hidden />
            Quiet
          </span>
          <span className="hidden sm:inline">Closer is bigger. ← → to walk, Esc to let go.</span>
        </div>
        {zooms.length > 1 ? (
          <div role="radiogroup" aria-label="Zoom" className="glass inline-flex rounded-full p-1">
            {zooms.map((z) => (
              <button
                key={z.id}
                type="button"
                role="radio"
                aria-checked={zoom === z.id}
                onClick={() => setZoom(z.id)}
                className={cn(
                  'relative h-7 cursor-pointer rounded-full px-3 type-micro transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  zoom === z.id ? 'text-primary-foreground' : 'text-foreground hover:bg-accent',
                )}
              >
                {zoom === z.id ? (
                  <motion.span
                    layoutId="horizon-zoom"
                    className="absolute inset-0 -z-0 rounded-full bg-primary"
                    transition={SPRING.settle}
                  />
                ) : null}
                <span className="relative">{z.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div
        ref={wrapRef}
        className="relative overflow-x-auto overflow-y-visible rounded-[22px] border border-hairline bg-card/60 [scrollbar-width:thin]"
        onKeyDown={onKey}
      >
        <div
          ref={stageRef}
          className="relative isolate"
          style={{ height: STAGE_H, minWidth: MIN_W }}
          onPointerLeave={() => setHover(null)}
        >
          {/* Sky: a violet dawn at "now", fading into the distance. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-20"
            style={{
              background:
                'radial-gradient(60% 90% at 0% 70%, color-mix(in oklch, var(--emphasis) 14%, transparent), transparent 70%), linear-gradient(to right, transparent 60%, color-mix(in oklch, var(--foreground) 3%, transparent))',
            }}
          />
          {/* Nights. */}
          {nights
            .filter((n) => (n.to - n.from) * inner >= 6)
            .map((n, i) => (
              <div
                key={i}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 -z-10 bg-scrim/[0.03] dark:bg-terracotta/[0.07]"
                style={{
                  left: PAD_L + n.from * inner,
                  width: Math.max(0, (n.to - n.from) * inner),
                }}
              />
            ))}
          {/* Midnights and Mondays. */}
          {ticks
            .filter((t) => t.kind !== 'hour')
            .map((t) => (
              <div
                key={`l${t.at}`}
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-0 -z-10 w-px',
                  t.kind === 'week' ? 'bg-foreground/15' : 'bg-foreground/[0.07]',
                )}
                style={{ left: PAD_L + t.x * inner, height: STAGE_H - 34 }}
              />
            ))}

          {/* The thread. */}
          <div
            aria-hidden
            className="absolute h-px"
            style={{
              top: THREAD_Y,
              left: PAD_L,
              right: PAD_R,
              background:
                'linear-gradient(to right, color-mix(in oklch, var(--foreground) 45%, transparent), color-mix(in oklch, var(--foreground) 12%, transparent))',
            }}
          />

          {/* Now. */}
          <div className="absolute" style={{ left: PAD_L, top: THREAD_Y }} aria-hidden>
            <span className="absolute -translate-x-1/2 -translate-y-1/2">
              {!reduced ? (
                <motion.span
                  className="absolute inset-0 rounded-full bg-emphasis"
                  initial={{ scale: 1, opacity: 0.5 }}
                  animate={{ scale: 3.2, opacity: 0 }}
                  transition={{ duration: 2.4, ease: 'easeOut', repeat: Infinity }}
                />
              ) : null}
              <span className="relative block size-3 rounded-full bg-emphasis shadow-[0_0_18px_2px_var(--emphasis)]" />
            </span>
            <span className="absolute top-4 -translate-x-1/2 text-center whitespace-nowrap">
              <span className="block type-micro text-emphasis">Now</span>
              <span className="block font-mono text-[10px] text-muted-foreground tabular-nums">
                {timeFmt.format(now)}
              </span>
            </span>
          </div>

          {/* Ticks. */}
          {ticks.map((t) => (
            <span
              key={`t${t.at}`}
              aria-hidden
              className={cn(
                'absolute -translate-x-1/2 whitespace-nowrap',
                t.kind === 'hour'
                  ? 'font-mono text-[10px] text-muted-foreground/80'
                  : 'type-micro text-foreground/80',
              )}
              style={{ left: PAD_L + t.x * inner, top: STAGE_H - 28 }}
            >
              {t.label}
            </span>
          ))}

          {/* Stems and beams. */}
          {beads.map((b) =>
            b.lane === null ? null : <Stem key={`s${b.m.id}`} b={b} reduced={reduced} />,
          )}

          {/* Labels. */}
          {beads.map((b, i) =>
            b.lane === null ? null : (
              <motion.button
                key={`c${b.m.id}`}
                type="button"
                tabIndex={-1}
                title={b.compact ? splitTitle(b.m.title).text : undefined}
                onClick={() => setPinned(pinned === b.m.id ? null : b.m.id)}
                onPointerEnter={() => setHover(b.m.id)}
                initial={{ opacity: 0, y: 6 }}
                animate={{
                  opacity: Math.max(0.55, b.opacity),
                  y: 0,
                  left: b.chipLeft,
                  top: LANE_TOP[b.lane]!,
                }}
                transition={{ ...SPRING.settle, delay: reduced ? 0 : 0.02 * i }}
                className={cn(
                  'absolute flex cursor-pointer items-center gap-1.5 rounded-full text-xs whitespace-nowrap backdrop-blur-sm',
                  b.compact ? 'justify-center px-0' : 'px-2.5',
                  b.m.priority === 'key'
                    ? 'border border-emphasis/40 bg-emphasis/[0.1] font-medium text-foreground shadow-[0_0_24px_-6px_var(--emphasis)]'
                    : 'border border-hairline bg-card/80 text-foreground/90',
                )}
                style={{ height: CHIP_H, maxWidth: b.chipW }}
              >
                {b.m.priority === 'key' ? (
                  <span className="text-emphasis" aria-hidden>
                    ◆
                  </span>
                ) : null}
                {b.compact ? null : <span className="truncate">{splitTitle(b.m.title).text}</span>}
              </motion.button>
            ),
          )}

          {/* Beads. */}
          {beads.map((b, i) => (
            <BeadView
              key={b.m.id}
              b={b}
              i={i}
              now={now}
              reduced={reduced}
              active={open?.m.id === b.m.id}
              onEnter={() => setHover(b.m.id)}
              onFocus={() => setHover(b.m.id)}
              onToggle={() => setPinned(pinned === b.m.id ? null : b.m.id)}
            />
          ))}

          {/* The lens. */}
          <AnimatePresence>
            {open ? (
              <Lens
                key={open.m.id}
                b={open}
                now={now}
                stageW={width}
                pinned={pinned === open.m.id}
                onClose={() => {
                  setPinned(null);
                  setHover(null);
                }}
              />
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

function Stem({ b, reduced }: { b: Bead; reduced: boolean }) {
  const key = b.m.priority === 'key';
  const top = LANE_TOP[b.lane!]! + CHIP_H;
  const bottom = THREAD_Y - b.size / 2 - 2;
  const x = Math.min(Math.max(b.center, b.chipLeft + 12), b.chipLeft + b.chipW - 12);
  const h = Math.max(0, bottom - top);
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute"
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: key ? 1 : 0.6, scaleY: 1, left: x, top, height: h }}
      transition={SPRING.settle}
      style={{ originY: 1, width: key ? 2 : 1 }}
    >
      {key ? (
        <>
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                'linear-gradient(to top, var(--emphasis), color-mix(in oklch, var(--emphasis) 15%, transparent))',
            }}
          />
          <div
            className="absolute -inset-x-2 inset-y-0 rounded-full blur-md"
            style={{
              background:
                'linear-gradient(to top, color-mix(in oklch, var(--emphasis) 45%, transparent), transparent)',
            }}
          />
          {!reduced ? (
            <motion.div
              className="absolute inset-x-0 h-6 rounded-full"
              style={{
                background:
                  'linear-gradient(to top, transparent, color-mix(in oklch, white 85%, var(--emphasis)), transparent)',
              }}
              initial={{ top: '100%', opacity: 0 }}
              animate={{ top: ['100%', '-20%'], opacity: [0, 0.9, 0] }}
              transition={{ duration: 3.2, ease: 'easeInOut', repeat: Infinity, repeatDelay: 1.4 }}
            />
          ) : null}
        </>
      ) : (
        <div className="absolute inset-0 bg-foreground/25" />
      )}
    </motion.div>
  );
}

function BeadView({
  b,
  i,
  now,
  reduced,
  active,
  onEnter,
  onFocus,
  onToggle,
}: {
  b: Bead;
  i: number;
  now: number;
  reduced: boolean;
  active: boolean;
  onEnter: () => void;
  onFocus: () => void;
  onToggle: () => void;
}) {
  const m = b.m;
  const key = m.priority === 'key';
  const quiet = m.priority === 'quiet';
  const live = m.phase === 'live';
  const soon = m.phase === 'soon';
  const p = live ? Math.min(1, Math.max(0, (now - m.start) / (m.end - m.start))) : 0;
  const label = `${splitTitle(m.title).text}, ${dayLabel(m.start, now)} ${timeFmt.format(m.start)}${key ? ', Key' : ''}`;
  return (
    <motion.button
      type="button"
      data-bead={m.id}
      aria-label={label}
      aria-pressed={active}
      onPointerEnter={onEnter}
      onFocus={onFocus}
      onClick={onToggle}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{
        opacity: b.opacity,
        scale: active ? 1.25 : 1,
        left: b.left,
        width: b.width,
        top: THREAD_Y - b.size / 2,
        height: b.size,
      }}
      whileHover={{ scale: 1.25 }}
      transition={{ ...SPRING.settle, delay: reduced ? 0 : 0.015 * i }}
      className={cn(
        'absolute cursor-pointer overflow-hidden rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        quiet
          ? 'border border-foreground/60 bg-transparent'
          : key || live || soon
            ? 'bg-emphasis'
            : 'bg-foreground/80',
        (key || live) && 'shadow-[0_0_20px_1px_var(--emphasis)]',
        active && 'z-10',
      )}
    >
      {live ? (
        <>
          <span
            className="absolute inset-y-0 left-0 bg-white/35"
            style={{ width: `${p * 100}%` }}
            aria-hidden
          />
          {!reduced ? (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-full"
              animate={{ opacity: [0.2, 0.6, 0.2] }}
              transition={{ duration: 2.6, ease: 'easeInOut', repeat: Infinity }}
              style={{ boxShadow: 'inset 0 0 10px 2px rgb(255 255 255 / 0.6)' }}
            />
          ) : null}
        </>
      ) : null}
      {soon && !reduced ? (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-emphasis"
          animate={{ scale: [1, 1.6], opacity: [0.8, 0] }}
          transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity }}
        />
      ) : null}
    </motion.button>
  );
}

const LENS_W = 320;

function Lens({
  b,
  now,
  stageW,
  pinned,
  onClose,
}: {
  b: Bead;
  now: number;
  stageW: number;
  pinned: boolean;
  onClose: () => void;
}) {
  const m = b.m;
  const { tag, text } = splitTitle(m.title);
  const x = Math.min(stageW - LENS_W - 12, Math.max(12, b.center - LENS_W / 2));
  const live = m.phase === 'live';
  return (
    <motion.div
      role="dialog"
      aria-label={text}
      initial={{ opacity: 0, y: 10, scale: 0.96, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
      transition={SPRING.settle}
      className={cn(
        'glass absolute z-30 grid gap-3 rounded-[18px] bg-popover/95 p-4',
        m.priority === 'key' && 'shadow-[0_18px_48px_-18px_var(--emphasis)]',
      )}
      style={{
        left: x,
        bottom: STAGE_H - THREAD_Y + 22,
        width: LENS_W,
        backdropFilter: 'var(--glass-blur-strong)',
        WebkitBackdropFilter: 'var(--glass-blur-strong)',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <TagChip tag={tag} />
          <PriorityChip meeting={m} />
          <span className={cn('type-micro', live ? 'text-emphasis' : 'text-muted-foreground')}>
            {live ? left(m, now) : until(m.start - now)}
          </span>
        </div>
        {pinned ? (
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer type-micro text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        ) : null}
      </div>
      <h3 className="text-base leading-snug font-semibold tracking-[-0.01em]">{text}</h3>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-mono tabular-nums">
          <CalendarClock className="size-3.5" aria-hidden />
          {dayLabel(m.start, now)} · {timeFmt.format(m.start)} – {timeFmt.format(m.end)}
        </span>
        <span>{duration(m)}</span>
        {m.response === 'needsAction' ? <span>Not answered yet</span> : null}
      </p>
      {m.mode !== 'unknown' || m.presence ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ModeChip m={m} className="max-w-full" />
          <PresenceBadge m={m} />
        </div>
      ) : null}
      {m.priorityReason ? (
        <p className="text-xs text-muted-foreground">{m.priorityReason}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <JoinButton m={m} prominent={(live || m.phase === 'soon') && !m.presence} />
        <IconActions m={m} />
        <PriorityMenu meeting={m} />
      </div>
      {canMark(m) ? <PresenceActions m={m} className="justify-self-start" /> : null}
    </motion.div>
  );
}
