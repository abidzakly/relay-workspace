import { AnimatePresence, motion } from 'motion/react';
import { CalendarClock } from 'lucide-react';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import {
  countdown,
  dayLabel,
  duration,
  left,
  monthDay,
  shortWeekday,
  splitTitle,
  timeFmt,
  type Row,
} from './meetingView';
import {
  canMark,
  IconActions,
  JoinButton,
  LiveDot,
  ModeChip,
  PresenceActions,
  PresenceBadge,
  PriorityChip,
  ProgressRing,
  TagChip,
} from './parts';
import { PriorityMenu } from './PriorityMenu';

/**
 * The hero over both views: the meeting that matters now (the live one, else the next), as poster type with a
 * countdown. A violet aura breathes behind it when it is live or about to start, or when it is Key.
 */
export function NextUp({
  rows,
  now,
  onPick,
}: {
  rows: readonly Row[];
  now: number;
  onPick: (id: string) => void;
}) {
  const reduced = useReducedMotion();
  // The live one you have not marked yet comes first; then any live one; then the next.
  const m =
    rows.find((r) => r.phase === 'live' && !r.presence) ??
    rows.find((r) => r.phase === 'live') ??
    rows.find((r) => r.phase !== 'over');
  const keys = rows.filter((r) => r.priority === 'key' && r.id !== m?.id).slice(0, 6);
  if (!m) return null;

  const live = m.phase === 'live';
  const soon = m.phase === 'soon';
  // Marked as joined / in the room: the hero settles (the aura calms, the ring keeps running).
  const settled = !!m.presence;
  const lit = !settled && (live || soon || m.priority === 'key');
  const { tag, text } = splitTitle(m.title);
  const cd = countdown(live ? m.end - now : m.start - now);

  return (
    <section aria-label="Next meeting" className="flex flex-col gap-3">
      <motion.div
        layout
        initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={SPRING.settle}
        className={cn(
          'relative isolate overflow-hidden rounded-[22px] border p-5 sm:p-7',
          lit ? 'border-emphasis/25' : 'border-hairline',
          'bg-card/70',
        )}
      >
        {/* The aura: a soft violet field, breathing while it is live. */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-24 -z-10"
          style={{
            background: `radial-gradient(42% 60% at 18% 30%, color-mix(in oklch, var(--emphasis) ${lit ? 26 : 9}%, transparent), transparent 70%), radial-gradient(40% 55% at 88% 90%, color-mix(in oklch, var(--terracotta) ${lit ? 18 : 6}%, transparent), transparent 70%)`,
          }}
          animate={
            live && !settled && !reduced
              ? { opacity: [0.7, 1, 0.7], scale: [1, 1.04, 1] }
              : { opacity: 1, scale: 1 }
          }
          transition={
            live && !settled && !reduced
              ? { duration: 5, ease: 'easeInOut', repeat: Infinity }
              : SPRING.settle
          }
        />

        <div className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-10">
          <div className="flex items-center gap-4">
            {live ? (
              <div className="relative grid place-items-center">
                <ProgressRing start={m.start} end={m.end} now={now} size={64} stroke={4} />
                <span className="absolute">
                  <LiveDot live={!settled} />
                </span>
              </div>
            ) : null}
            <div className="grid gap-1">
              <span
                className={cn(
                  'type-micro',
                  settled
                    ? 'text-success'
                    : live || soon
                      ? 'text-emphasis'
                      : 'text-muted-foreground',
                )}
              >
                {settled && live
                  ? m.presence?.status === 'here'
                    ? 'You’re in the room · ends in'
                    : 'You’re in · ends in'
                  : live
                    ? 'Live now · ends in'
                    : soon
                      ? 'Starting in'
                      : 'Next up in'}
              </span>
              <div className="flex items-baseline gap-2 tabular-nums">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={cd.big}
                    initial={reduced ? false : { y: 12, opacity: 0, filter: 'blur(4px)' }}
                    animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
                    exit={reduced ? undefined : { y: -12, opacity: 0, filter: 'blur(4px)' }}
                    transition={SPRING.settle}
                    className="type-display leading-none"
                  >
                    {cd.big}
                  </motion.span>
                </AnimatePresence>
                <span className="type-micro text-muted-foreground">{cd.unit}</span>
                {cd.small ? (
                  <span className="font-mono text-sm text-muted-foreground">{cd.small}</span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid min-w-0 gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <TagChip tag={tag} />
              <PriorityChip meeting={m} withReason />
            </div>
            <h2 className="text-2xl leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-[1.75rem]">
              {text}
            </h2>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                <CalendarClock className="size-4" aria-hidden />
                {dayLabel(m.start, now)} · {timeFmt.format(m.start)} – {timeFmt.format(m.end)}
              </span>
              <span>{live ? left(m, now) : duration(m)}</span>
              {m.response === 'needsAction' ? <span>Not answered yet</span> : null}
              {m.response === 'tentative' ? <span>You said maybe</span> : null}
              {m.calendarId !== 'primary' ? <span className="truncate">{m.calendarId}</span> : null}
            </p>
            {m.mode !== 'unknown' || m.presence ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ModeChip m={m} className="max-w-full" />
                <PresenceBadge m={m} />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <JoinButton m={m} prominent={(live || soon) && !settled} size="default" />
              {canMark(m) ? <PresenceActions m={m} /> : null}
              <IconActions m={m} />
              <PriorityMenu meeting={m} />
            </div>
          </div>
        </div>
      </motion.div>

      {keys.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1">
          <span className="shrink-0 type-micro text-muted-foreground">Key ahead</span>
          {keys.map((k, i) => (
            <motion.button
              key={k.id}
              type="button"
              onClick={() => onPick(k.id)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { ...SPRING.settle, delay: 0.05 * i } }}
              whileTap={{ scale: 0.97, transition: SPRING.press }}
              className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-emphasis/30 bg-emphasis/[0.06] px-3 py-1.5 text-xs transition-colors hover:bg-emphasis/[0.12] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="text-emphasis" aria-hidden>
                ◆
              </span>
              <span className="max-w-[16rem] truncate font-medium">{splitTitle(k.title).text}</span>
              <span className="font-mono text-muted-foreground tabular-nums">
                {shortWeekday(k.start)} {monthDay(k.start)}
              </span>
            </motion.button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
