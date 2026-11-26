import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import {
  DAY_MS,
  dayStart,
  density,
  duration,
  groupByWeek,
  left,
  monthShort,
  shortWeekday,
  splitTitle,
  timeFmt,
  until,
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
  TagChip,
} from './parts';
import { PriorityMenu } from './PriorityMenu';

/**
 * The classic view, made to read at a glance: a strip of how full each day is, then weeks and days with a calendar
 * tile that stays in place while you scroll. Key meetings carry a violet rail and say why; plain meetings more than
 * three days out fold to one line; actions wait for the pointer (always there on touch).
 */

const COMPACT_AFTER_MS = 3 * DAY_MS;

export function MeetingList({
  rows,
  now,
  lookAheadDays,
  focusId,
  focusSeq,
}: {
  rows: readonly Row[];
  now: number;
  lookAheadDays: number;
  focusId: string | null;
  /** Bumped on every pick, so picking the same meeting twice still brings it back into view. */
  focusSeq: number;
}) {
  const reduced = useReducedMotion();
  const weeks = useMemo(() => groupByWeek(rows, now), [rows, now]);
  const days = useMemo(
    () => density(rows, now, Math.max(7, Math.min(31, lookAheadDays + 1))),
    [rows, now, lookAheadDays],
  );
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`meeting-${focusId}`);
    el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    setFlash(focusId);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [focusId, focusSeq, reduced]);

  return (
    <div className="flex flex-col gap-8">
      <DensityStrip days={days} now={now} />
      {weeks.map((w) => {
        const all = w.days.flatMap((d) => d.meetings);
        const keys = all.filter((m) => m.priority === 'key').length;
        return (
          <section key={w.key} className="flex flex-col gap-4">
            <div className="flex items-baseline gap-3 border-b border-hairline pb-2">
              <h2 className="type-micro text-foreground">{w.label}</h2>
              <span className="text-xs text-muted-foreground">
                {all.length} meeting{all.length === 1 ? '' : 's'}
                {keys ? (
                  <>
                    {' · '}
                    <span className="text-emphasis">◆ {keys} Key</span>
                  </>
                ) : null}
              </span>
            </div>
            {w.days.map((d) => (
              <div
                key={d.key}
                id={`day-${d.key}`}
                className="grid scroll-mt-24 grid-cols-[3.75rem_minmax(0,1fr)] gap-3 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-5"
              >
                <DateTile at={d.key} now={now} />
                <ul className="flex min-w-0 flex-col gap-1">
                  {d.meetings.map((m, i) => (
                    <MeetingRow
                      key={m.id}
                      m={m}
                      now={now}
                      i={i}
                      flash={flash === m.id}
                      compact={
                        m.phase === 'over' ||
                        (m.priority !== 'key' &&
                          m.phase === 'later' &&
                          m.start - now > COMPACT_AFTER_MS)
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function DateTile({ at, now }: { at: number; now: number }) {
  const today = dayStart(now) === at;
  const tomorrow = dayStart(now) + DAY_MS === dayStart(at + 2 * 3_600_000);
  return (
    <div className="sticky top-4 self-start">
      <div
        className={cn(
          'flex flex-col items-center rounded-[14px] border px-1 py-2 text-center',
          today
            ? 'border-emphasis/40 bg-emphasis/[0.07] shadow-[0_8px_24px_-14px_var(--emphasis)]'
            : 'border-hairline bg-card/60',
        )}
      >
        <span className={cn('type-micro', today ? 'text-emphasis' : 'text-muted-foreground')}>
          {today ? 'Today' : tomorrow ? 'Tmrw' : shortWeekday(at)}
        </span>
        <span className="text-[1.65rem] leading-none font-semibold tracking-[-0.03em] tabular-nums">
          {new Date(at).getDate()}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground uppercase">
          {monthShort(at)}
        </span>
      </div>
    </div>
  );
}

function DensityStrip({ days, now }: { days: ReturnType<typeof density>; now: number }) {
  const max = Math.max(4, ...days.map((d) => d.hours));
  return (
    <div className="rounded-[18px] border border-hairline bg-card/50 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="type-micro text-muted-foreground">How full each day is</span>
        <span className="text-xs text-muted-foreground">
          <span className="text-emphasis">◆</span> has a Key meeting
        </span>
      </div>
      <div className="flex h-24 items-end gap-1 overflow-x-auto sm:gap-1.5">
        {days.map((d, i) => {
          const today = d.key === dayStart(now);
          const weekend = [0, 6].includes(new Date(d.key).getDay());
          return (
            <button
              key={d.key}
              type="button"
              disabled={d.count === 0}
              onClick={() =>
                document
                  .getElementById(`day-${d.key}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              title={`${shortWeekday(d.key)} ${new Date(d.key).getDate()}: ${d.count} meeting${d.count === 1 ? '' : 's'}, ${Math.round(d.hours * 10) / 10} h`}
              className="group flex min-w-5 flex-1 cursor-pointer flex-col items-center gap-1 disabled:cursor-default"
            >
              <span className={cn('h-3 text-[10px] text-emphasis', !d.hasKey && 'invisible')}>
                ◆
              </span>
              <span className="relative flex h-12 w-full items-end justify-center">
                <motion.span
                  className={cn(
                    'w-full max-w-5 rounded-t-[4px]',
                    d.hasKey
                      ? 'bg-emphasis'
                      : today
                        ? 'bg-foreground/80'
                        : 'bg-foreground/35 group-hover:bg-foreground/55',
                  )}
                  initial={{ height: 0 }}
                  animate={{ height: d.count ? `${Math.max(10, (d.hours / max) * 100)}%` : 2 }}
                  transition={{ ...SPRING.settle, delay: 0.015 * i }}
                />
              </span>
              <span
                className={cn(
                  'font-mono text-[10px] tabular-nums',
                  today
                    ? 'font-semibold text-emphasis'
                    : weekend
                      ? 'text-muted-foreground/60'
                      : 'text-muted-foreground',
                )}
              >
                {new Date(d.key).getDate()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MeetingRow({
  m,
  now,
  i,
  compact,
  flash,
}: {
  m: Row;
  now: number;
  i: number;
  compact: boolean;
  flash: boolean;
}) {
  const live = m.phase === 'live';
  const soon = m.phase === 'soon';
  const ended = m.phase === 'over';
  // In the call / in the room: the row reads settled (green tint) instead of calling for attention.
  const settled = !!m.presence && !ended;
  const key = m.priority === 'key';
  const quiet = m.priority === 'quiet';
  const { tag, text } = splitTitle(m.title);
  const mins = (m.end - m.start) / 60_000;

  return (
    <motion.li
      id={`meeting-${m.id}`}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { ...SPRING.settle, delay: Math.min(i, 8) * 0.03 } }}
      className={cn(
        'group relative grid scroll-mt-24 items-center gap-x-4 gap-y-2 rounded-[14px] pr-2 pl-5 transition-[background-color,box-shadow]',
        'grid-cols-[4.25rem_minmax(0,1fr)] sm:grid-cols-[4.75rem_minmax(0,1fr)_auto]',
        compact ? 'py-1.5' : 'py-3',
        // Every row sits on its own paper with a hairline, so the day reads as a stack of meetings, not loose text.
        settled
          ? 'bg-success/[0.07] ring-1 ring-success/25'
          : live
            ? 'bg-emphasis/[0.07] ring-1 ring-emphasis/30'
            : key
              ? 'bg-[color-mix(in_oklch,var(--emphasis)_5%,var(--card))] ring-1 ring-emphasis/20 hover:ring-emphasis/35'
              : compact
                ? 'bg-card/45 ring-1 ring-hairline hover:bg-card'
                : 'bg-card/80 ring-1 ring-hairline hover:bg-card hover:shadow-[0_10px_24px_-18px_rgb(var(--elevation)/0.5)]',
        'duration-200',
        flash && 'ring-2 ring-emphasis',
        quiet && 'opacity-70',
        m.dismissed && !live && !settled && 'opacity-60',
        ended && 'opacity-60',
      )}
    >
      {/* The rail: violet for Key and live, nothing for the rest. */}
      {(key || live) && !settled && !ended ? (
        <span
          aria-hidden
          className="absolute inset-y-2 left-1.5 w-[3px] rounded-full bg-emphasis shadow-[0_0_12px_0_var(--emphasis)]"
        />
      ) : null}

      <div className="flex flex-col font-mono text-xs leading-tight whitespace-nowrap tabular-nums">
        <span className={cn(compact ? 'text-foreground/70' : 'font-medium text-foreground')}>
          {timeFmt.format(m.start)}
        </span>
        {compact ? null : <span className="text-muted-foreground">{timeFmt.format(m.end)}</span>}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {(live || soon) && !settled ? <LiveDot live={live} /> : null}
          <TagChip tag={tag} />
          <span
            className={cn(
              'truncate leading-snug tracking-[-0.01em]',
              compact ? 'text-sm' : 'text-[15px] font-semibold',
              quiet && 'font-normal',
              ended && 'text-muted-foreground line-through decoration-foreground/30',
            )}
          >
            {text}
          </span>
          {key ? <PriorityChip meeting={m} className="shrink-0" /> : null}
          {ended ? (
            <PresenceBadge m={m} className="ml-auto pl-2" />
          ) : compact ? (
            <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
              {duration(m)}
            </span>
          ) : null}
        </div>
        {compact ? null : (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className={cn(
                'font-medium',
                live ? 'text-emphasis' : soon ? 'text-foreground' : undefined,
              )}
            >
              {live ? left(m, now) : until(m.start - now)}
            </span>
            <ModeChip m={m} className="max-w-full sm:max-w-[24rem]" />
            <PresenceBadge m={m} />
            <span className="inline-flex items-center gap-1.5">
              <span
                className="relative h-1 w-14 overflow-hidden rounded-full bg-foreground/10"
                aria-hidden
              >
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-full',
                    key || live ? 'bg-emphasis' : 'bg-foreground/45',
                  )}
                  style={{ width: `${Math.min(100, (mins / 120) * 100)}%` }}
                />
              </span>
              {duration(m)}
            </span>
            {m.response === 'needsAction' ? (
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                Not answered
              </span>
            ) : null}
            {m.response === 'tentative' ? <span>Maybe</span> : null}
            {m.calendarId !== 'primary' ? <span className="truncate">{m.calendarId}</span> : null}
            {quiet ? <PriorityChip meeting={m} /> : null}
            {m.priorityReason && key ? (
              <span className="truncate text-emphasis/80">{m.priorityReason}</span>
            ) : null}
            {m.dismissed && !m.presence ? <span>Alert dismissed</span> : null}
          </div>
        )}
      </div>

      <div
        className={cn(
          'col-start-2 flex flex-wrap items-center gap-1 sm:col-start-auto sm:flex-nowrap sm:justify-end',
          !(live || soon || ended) &&
            'sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100',
          compact && !ended && 'hidden sm:flex',
        )}
      >
        {canMark(m) ? <PresenceActions m={m} compact={ended} wideLabels /> : null}
        {ended ? null : (
          <>
            <JoinButton m={m} prominent={(live || soon) && !settled} />
            <IconActions m={m} />
            <PriorityMenu meeting={m} />
          </>
        )}
      </div>
    </motion.li>
  );
}
