import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { CalendarClock, ChevronDown, Video, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { meetingPhase, type Meeting, type MeetingPhase } from '@relay/shared';
import { useDismissMeeting, useMeetings, useNow } from '@/lib/calendarApi';
import { useFeatures } from '@/lib/features';
import { vibrate } from '@/lib/haptics';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useCoarsePointer, useReducedMotion } from '@/workspace/useMedia';

/**
 * The floating meeting alert: a small glass island at the top of every page while a meeting is under way (or about to
 * start) and you have neither joined it from here nor dismissed it. It does not time out on its own: a missed
 * meeting stays in view until it ends. Hover (or tap) opens it into a card with Join and Dismiss.
 */

type Shown = Meeting & { phase: Extract<MeetingPhase, 'soon' | 'live'> };

const pad = (n: number) => String(n).padStart(2, '0');

/** `4:07`, or `1:04:07` past an hour. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just started';
  if (min < 60) return `started ${min} min ago`;
  return `started ${Math.floor(min / 60)} h ${min % 60} min ago`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const range = (m: Meeting) => `${timeFmt.format(m.start)} – ${timeFmt.format(m.end)}`;

const RESPONSE_NOTE: Partial<Record<Meeting['response'], string>> = {
  tentative: 'You said maybe',
  needsAction: 'Not answered yet',
};

export function MeetingAlert() {
  const on = useFeatures().calendar;
  if (!on) return null;
  return <MeetingAlertInner />;
}

function MeetingAlertInner() {
  const q = useMeetings();
  const dismiss = useDismissMeeting();
  const reduced = useReducedMotion();
  const coarse = useCoarsePointer();
  const list = q.data;
  const skew = list ? list.now - q.dataUpdatedAt : 0;

  // A fast clock only while something is near; otherwise a slow one to notice the next "soon".
  const [fast, setFast] = useState(false);
  const now = useNow(fast ? 1000 : 15_000, skew);

  const shown = useMemo<Shown[]>(() => {
    if (!list?.connected) return [];
    const out: Shown[] = [];
    for (const m of list.meetings) {
      if (m.dismissed) continue;
      const phase = meetingPhase(m, now, list.leadSeconds);
      if (phase === 'soon' || phase === 'live') out.push({ ...m, phase });
    }
    // Under way first (the longest-running is the most missed), then the next to start.
    return out.sort((a, b) =>
      a.phase === b.phase ? a.start - b.start : a.phase === 'live' ? -1 : 1,
    );
  }, [list, now]);

  useEffect(() => {
    const near =
      list?.meetings.some(
        (m) => !m.dismissed && m.end > now && m.start - now < list.leadSeconds * 1000 + 20_000,
      ) ?? false;
    setFast(near);
  }, [list, now]);

  // One soft buzz when a meeting goes live in front of you.
  const liveKey = shown
    .filter((m) => m.phase === 'live')
    .map((m) => m.id)
    .join('\n');
  const seenLive = useRef(new Set<string>());
  useEffect(() => {
    for (const id of liveKey ? liveKey.split('\n') : []) {
      if (seenLive.current.has(id)) continue;
      seenLive.current.add(id);
      vibrate('pop');
    }
  }, [liveKey]);

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const expanded = open || pinned;
  const lead = shown[0];

  useEffect(() => {
    if (!lead) {
      setOpen(false);
      setPinned(false);
    }
  }, [lead]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setPinned(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const hoverIn = () => {
    if (coarse) return;
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hoverOut = () => {
    if (coarse) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 260);
  };

  const join = (m: Meeting) => {
    const url = m.joinUrl ?? m.htmlLink;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    dismiss.mutate({ id: m.id });
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[max(4rem,env(safe-area-inset-top))] min-[1440px]:top-[max(0.75rem,env(safe-area-inset-top))] z-50 flex justify-center px-3"
      aria-live="polite"
    >
      <AnimatePresence>
        {lead ? (
          <motion.section
            key="meeting-island"
            layout
            aria-label="Meeting alert"
            initial={{ opacity: 0, y: -28, scale: 0.86, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -20, scale: 0.92, filter: 'blur(4px)' }}
            transition={{ ...SPRING.wobble, layout: SPRING.settle }}
            style={{ borderRadius: expanded ? 22 : 999 }}
            onPointerEnter={hoverIn}
            onPointerLeave={hoverOut}
            className={cn(
              'glass pointer-events-auto relative isolate overflow-hidden text-foreground',
              '[--glass-blur:var(--glass-blur-strong)]',
              expanded
                ? 'w-[min(24rem,calc(100vw-1.5rem))]'
                : 'max-w-[min(26rem,calc(100vw-1.5rem))]',
            )}
          >
            <Glow live={lead.phase === 'live'} reduced={reduced} />
            <LayoutGroup>
              <AnimatePresence mode="popLayout" initial={false}>
                {expanded ? (
                  <Card
                    key="card"
                    meetings={shown}
                    now={now}
                    onJoin={join}
                    onDismiss={(m) => dismiss.mutate({ id: m.id })}
                    onCollapse={() => {
                      setOpen(false);
                      setPinned(false);
                    }}
                  />
                ) : (
                  <Pill
                    key="pill"
                    lead={lead}
                    more={shown.length - 1}
                    now={now}
                    reduced={reduced}
                    onOpen={() => setPinned(true)}
                  />
                )}
              </AnimatePresence>
            </LayoutGroup>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** A slow breathing wash of the emphasis ink behind a live meeting; a quiet one before it starts. */
function Glow({ live, reduced }: { live: boolean; reduced: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      style={{
        background: live
          ? 'radial-gradient(120% 140% at 0% 50%, color-mix(in oklch, var(--emphasis) 22%, transparent), transparent 70%)'
          : 'radial-gradient(120% 140% at 0% 50%, color-mix(in oklch, var(--emphasis) 9%, transparent), transparent 70%)',
      }}
      animate={live && !reduced ? { opacity: [0.55, 1, 0.55] } : { opacity: 0.8 }}
      transition={
        live && !reduced ? { duration: 2.8, ease: 'easeInOut', repeat: Infinity } : SPRING.settle
      }
    />
  );
}

function LiveDot({ live, reduced }: { live: boolean; reduced: boolean }) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center" aria-hidden>
      {live && !reduced ? (
        <motion.span
          className="absolute inset-0 rounded-full bg-emphasis"
          initial={{ scale: 1, opacity: 0.55 }}
          animate={{ scale: 2.6, opacity: 0 }}
          transition={{ duration: 1.6, ease: 'easeOut', repeat: Infinity }}
        />
      ) : null}
      <span
        className={cn(
          'relative size-2 rounded-full',
          live ? 'bg-emphasis' : 'border border-emphasis/70 bg-transparent',
        )}
      />
    </span>
  );
}

const fade = {
  initial: { opacity: 0, filter: 'blur(4px)' },
  animate: { opacity: 1, filter: 'blur(0px)' },
  exit: { opacity: 0, filter: 'blur(4px)' },
  transition: SPRING.settle,
};

function Pill({
  lead,
  more,
  now,
  reduced,
  onOpen,
}: {
  lead: Shown;
  more: number;
  now: number;
  reduced: boolean;
  onOpen: () => void;
}) {
  const live = lead.phase === 'live';
  return (
    <motion.button
      type="button"
      layout="position"
      {...fade}
      onClick={onOpen}
      aria-expanded={false}
      whileTap={{ scale: 0.97, transition: SPRING.press }}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 py-2 pr-2.5 pl-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <LiveDot live={live} reduced={reduced} />
      <span className="type-micro shrink-0 text-emphasis">{live ? 'Live' : 'Soon'}</span>
      <motion.span layoutId="meeting-title" className="min-w-0 truncate text-sm font-medium">
        {lead.title}
      </motion.span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {live ? clock(now - lead.start) : `in ${clock(lead.start - now)}`}
      </span>
      {more > 0 ? (
        <span className="shrink-0 rounded-full bg-foreground/8 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          +{more}
        </span>
      ) : null}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </motion.button>
  );
}

function Card({
  meetings,
  now,
  onJoin,
  onDismiss,
  onCollapse,
}: {
  meetings: Shown[];
  now: number;
  onJoin: (m: Meeting) => void;
  onDismiss: (m: Meeting) => void;
  onCollapse: () => void;
}) {
  return (
    <motion.div layout="position" {...fade} className="grid gap-1 p-2">
      <div className="flex items-center justify-between px-2 pt-1">
        <span className="type-micro text-muted-foreground">
          {meetings.length === 1 ? 'Meeting' : `${meetings.length} meetings`}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse"
          className="-mr-1 grid size-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronDown className="size-4 rotate-180" aria-hidden />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {meetings.map((m, i) => (
          <motion.article
            key={m.id}
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0, transition: { ...SPRING.settle, delay: i * 0.04 } }}
            exit={{ opacity: 0, x: 24, transition: SPRING.settle }}
            className={cn('grid gap-3 rounded-[16px] p-3', i > 0 && 'border-t border-hairline')}
          >
            <div className="grid gap-1">
              <span
                className={cn(
                  'type-micro',
                  m.phase === 'live' ? 'text-emphasis' : 'text-muted-foreground',
                )}
              >
                {m.phase === 'live'
                  ? `Live · ${ago(now - m.start)}`
                  : `Starts in ${clock(m.start - now)}`}
              </span>
              {i === 0 ? (
                <motion.h2
                  layoutId="meeting-title"
                  className="text-base leading-snug font-semibold tracking-[-0.01em]"
                >
                  {m.title}
                </motion.h2>
              ) : (
                <h2 className="text-base leading-snug font-semibold tracking-[-0.01em]">
                  {m.title}
                </h2>
              )}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {range(m)}
                </span>
                {m.calendarId !== 'primary' ? (
                  <span className="truncate">{m.calendarId}</span>
                ) : null}
                {RESPONSE_NOTE[m.response] ? <span>{RESPONSE_NOTE[m.response]}</span> : null}
              </p>
              {m.phase === 'live' ? <Progress start={m.start} end={m.end} now={now} /> : null}
            </div>
            <div className="flex items-center gap-2">
              <motion.button
                type="button"
                whileTap={{ scale: 0.96, transition: SPRING.press }}
                onClick={() => onJoin(m)}
                disabled={!m.joinUrl && !m.htmlLink}
                className="inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-primary px-4 text-xs font-semibold tracking-[0.04em] text-primary-foreground uppercase transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
              >
                <Video className="size-4" aria-hidden />
                {m.joinUrl ? 'Join' : 'Open event'}
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.96, transition: SPRING.press }}
                onClick={() => onDismiss(m)}
                className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-4 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X className="size-3.5" aria-hidden />
                Dismiss
              </motion.button>
            </div>
          </motion.article>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

/** How far into the meeting you are: a hairline that fills. */
function Progress({ start, end, now }: { start: number; end: number; now: number }) {
  const p = Math.min(1, Math.max(0, (now - start) / (end - start)));
  return (
    <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-foreground/8" aria-hidden>
      <motion.div
        className="h-full origin-left rounded-full bg-emphasis"
        initial={false}
        animate={{ scaleX: p }}
        transition={SPRING.settle}
      />
    </div>
  );
}
