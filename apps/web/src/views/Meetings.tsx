import { motion } from 'motion/react';
import { CalendarOff, DoorOpen, Flag, Headset, LayoutList, RotateCw, Waves } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { effectivePhase, meetingLead } from '@relay/shared';
import { PageTitle } from '@/components/PageTitle';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { useCalendarStatus, useMeetings, useNow, useRefreshMeetings } from '@/lib/calendarApi';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { HolidayStrip } from '@/meetings/HolidayStrip';
import { Horizon } from '@/meetings/Horizon';
import { MeetingList } from '@/meetings/MeetingList';
import { NextUp } from '@/meetings/NextUp';
import {
  DAY_MS,
  dayStart,
  until,
  useMeetingsView,
  weekStart,
  type MeetingsView,
  type Row,
} from '@/meetings/meetingView';

/**
 * Meetings: everything on your calendar(s) that has not ended yet, over the range set in Settings (24 hours to a
 * month). The meeting that matters now on top, then the Horizon (a timeline where distance fades and Key meetings
 * keep a beam) or the List. Priority (Key / Normal / Quiet) comes from title rules or a hand-set mark, and always
 * says why.
 */

function rangeLabel(days: number | undefined): string {
  if (!days || days === 1) return '24 hours';
  if (days === 7) return 'week';
  if (days === 31) return 'month';
  if (days % 7 === 0) return `${days / 7} weeks`;
  return `${days} days`;
}

const VIEWS: { id: MeetingsView; label: string; icon: typeof Waves }[] = [
  { id: 'horizon', label: 'Horizon', icon: Waves },
  { id: 'list', label: 'List', icon: LayoutList },
];

export function Meetings() {
  const q = useMeetings();
  const status = useCalendarStatus();
  const refresh = useRefreshMeetings();
  const [view, setView] = useMeetingsView();
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const list = q.data;
  const skew = list ? list.now - q.dataUpdatedAt : 0;
  const now = useNow(1_000, skew);

  const rows = useMemo<Row[]>(
    () =>
      list
        ? list.meetings
            .map((m) => ({ ...m, phase: effectivePhase(m, now, meetingLead(m, list)) }))
            // A meeting you marked as ended stays (muted, with Undo) until its scheduled end.
            .filter((m) => m.phase !== 'over' || m.presence?.status === 'ended')
        : [],
    [list, now],
  );

  const summary = useMemo(() => {
    const weekEnd = weekStart(now) + 7 * DAY_MS;
    const thisWeek = rows.filter((m) => m.start < weekEnd);
    const keys = rows.filter((m) => m.priority === 'key').length;
    const next = rows.find((m) => m.phase !== 'live' && m.phase !== 'over');
    const today = rows.filter((m) => dayStart(m.start) === dayStart(now));
    const count = (s: string) => today.filter((m) => m.presence?.status === s).length;
    return {
      thisWeek: thisWeek.length,
      keys,
      next,
      today: {
        joined: count('joined'),
        here: count('here'),
        ended: count('ended'),
        toGo: today.filter((m) => !m.presence && m.phase !== 'over').length,
      },
    };
  }, [rows, now]);

  const connected = list?.connected ?? status.data?.connected ?? false;
  const loading = q.isPending || status.isPending;
  const lookAheadDays = list?.lookAheadDays ?? 1;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <PageTitle>Meetings</PageTitle>
          <p className="text-sm text-muted-foreground">
            {connected && rows.length > 0 ? (
              <>
                <span className="text-foreground">{summary.thisWeek}</span> this week
                {summary.keys ? (
                  <>
                    {' · '}
                    <span className="text-emphasis">◆ {summary.keys} Key</span>
                  </>
                ) : null}
                {summary.next ? <> · next {until(summary.next.start - now)}</> : null}
                {` · showing the next ${rangeLabel(lookAheadDays)}`}
              </>
            ) : (
              `What is left on your Google Calendar over the next ${rangeLabel(lookAheadDays)}.`
            )}
          </p>
          {connected ? <TodayTally t={summary.today} /> : null}
          {connected && list ? <HolidayStrip holidays={list.holidays} now={now} /> : null}
        </div>
        {connected ? (
          <div className="flex flex-wrap items-center gap-3">
            {status.data?.lastSyncAt ? (
              <span className="text-xs text-muted-foreground">
                Read <TimeAgo at={status.data.lastSyncAt} />
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RotateCw
                className={cn('size-4', refresh.isPending && 'motion-safe:animate-spin')}
                aria-hidden
              />
              {refresh.isPending ? 'Reading…' : 'Read now'}
            </Button>
            <div role="radiogroup" aria-label="View" className="glass inline-flex rounded-full p-1">
              {VIEWS.map((v) => {
                const on = view === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setView(v.id)}
                    className={cn(
                      'relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 type-micro transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      on ? 'text-primary-foreground' : 'text-foreground hover:bg-accent',
                    )}
                  >
                    {on ? (
                      <motion.span
                        layoutId="meetings-view"
                        className="absolute inset-0 rounded-full bg-primary"
                        transition={SPRING.settle}
                      />
                    ) : null}
                    <v.icon className="relative size-3.5" aria-hidden />
                    <span className="relative">{v.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {q.error || refresh.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load meetings</AlertTitle>
          <AlertDescription>{describeError(q.error ?? refresh.error)}</AlertDescription>
        </Alert>
      ) : null}
      {status.data?.lastError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not read the calendar</AlertTitle>
          <AlertDescription>{status.data.lastError}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !connected ? (
        <Empty
          title="Google Calendar is not connected"
          body="Connect it once and your meetings show up here, with a floating alert while one is under way."
          action={
            <Button asChild size="sm">
              <Link to="/settings#google">Open Calendar settings</Link>
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <Empty
          title="A clear calendar"
          body={`Nothing left for the next ${rangeLabel(lookAheadDays)}. New invitations show up within a minute.`}
        />
      ) : (
        <div className="flex flex-col gap-8">
          <NextUp
            rows={rows}
            now={now}
            onPick={(id) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))}
          />
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={SPRING.settle}
          >
            {view === 'horizon' ? (
              <Horizon
                rows={rows}
                now={now}
                lookAheadDays={lookAheadDays}
                focusId={focus?.id ?? null}
                focusSeq={focus?.n ?? 0}
              />
            ) : (
              <MeetingList
                rows={rows}
                now={now}
                lookAheadDays={lookAheadDays}
                focusId={focus?.id ?? null}
                focusSeq={focus?.n ?? 0}
              />
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING.settle}
      className="flex flex-col items-center gap-3 rounded-surface border border-dashed border-hairline px-6 py-14 text-center"
    >
      <CalendarOff className="size-6 text-muted-foreground" aria-hidden />
      <div className="grid gap-1">
        <p className="font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </motion.div>
  );
}

/** Today at a glance: what you marked (in the call, in the room, ended) and what is still to come. */
function TodayTally({ t }: { t: { joined: number; here: number; ended: number; toGo: number } }) {
  if (t.joined + t.here + t.ended + t.toGo === 0) return null;
  const items = [
    { n: t.joined, label: 'joined', icon: Headset, tone: 'text-success' },
    { n: t.here, label: 'in the room', icon: DoorOpen, tone: 'text-success' },
    { n: t.ended, label: 'ended', icon: Flag, tone: 'text-muted-foreground' },
  ].filter((i) => i.n > 0);
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="type-micro text-foreground">Today</span>
      {items.map((i) => (
        <motion.span
          key={i.label}
          layout
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING.settle}
          className={cn('inline-flex items-center gap-1', i.tone)}
        >
          <i.icon className="size-3.5" aria-hidden />
          <span className="font-mono tabular-nums">{i.n}</span> {i.label}
        </motion.span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="font-mono tabular-nums text-foreground">{t.toGo}</span> still to come
      </span>
    </p>
  );
}
