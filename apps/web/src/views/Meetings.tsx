import { AnimatePresence, motion } from 'motion/react';
import { CalendarClock, CalendarOff, ExternalLink, RotateCw, Undo2, Video, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { meetingPhase, type Meeting, type MeetingPhase } from '@relay/shared';
import { PageTitle, SectionLabel } from '@/components/PageTitle';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import {
  useCalendarStatus,
  useDismissMeeting,
  useMeetings,
  useNow,
  useRefreshMeetings,
} from '@/lib/calendarApi';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';

/**
 * Meetings: everything on your calendar(s) that has not ended yet, over the next day. Live meetings first, then each
 * day in order. Dismissing here hides a meeting from the floating alert; Undo brings it back.
 */

type Row = Meeting & { phase: MeetingPhase };

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'short',
});

const RESPONSE_NOTE: Partial<Record<Meeting['response'], string>> = {
  tentative: 'You said maybe',
  needsAction: 'Not answered yet',
};

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(start: number, now: number): string {
  const diff = Math.round((dayStart(start) - dayStart(now)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return dayFmt.format(start);
}

function duration(m: Meeting): string {
  const min = Math.round((m.end - m.start) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

function until(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return 'in a minute';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `in ${h} h ${min % 60} min` : `in ${h} h`;
}

function left(m: Meeting, now: number): string {
  const min = Math.max(1, Math.ceil((m.end - now) / 60_000));
  return min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h ${min % 60} min left`;
}

export function Meetings() {
  const q = useMeetings();
  const status = useCalendarStatus();
  const refresh = useRefreshMeetings();
  const list = q.data;
  const skew = list ? list.now - q.dataUpdatedAt : 0;
  const now = useNow(15_000, skew);

  const { live, days } = useMemo(() => {
    const rows: Row[] = (list?.meetings ?? [])
      .map((m) => ({ ...m, phase: meetingPhase(m, now, list?.leadSeconds ?? 0) }))
      .filter((m) => m.phase !== 'over');
    const groups = new Map<string, Row[]>();
    for (const m of rows) {
      if (m.phase === 'live') continue;
      const label = dayLabel(m.start, now);
      groups.set(label, [...(groups.get(label) ?? []), m]);
    }
    return { live: rows.filter((m) => m.phase === 'live'), days: [...groups] };
  }, [list, now]);

  const connected = list?.connected ?? status.data?.connected ?? false;
  const loading = q.isPending || status.isPending;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>Meetings</PageTitle>
          <p className="text-sm text-muted-foreground">
            What is left on your Google Calendar over the next 24 hours.
          </p>
        </div>
        {connected ? (
          <div className="flex items-center gap-3">
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
              <Link to="/settings#calendar">Open Calendar settings</Link>
            </Button>
          }
        />
      ) : live.length === 0 && days.length === 0 ? (
        <Empty
          title="A clear calendar"
          body="Nothing left for the next 24 hours. New invitations show up within a minute."
        />
      ) : (
        <div className="flex flex-col gap-8">
          {live.length > 0 ? (
            <section className="flex flex-col gap-3">
              <SectionLabel className="text-emphasis">Now</SectionLabel>
              <ul className="flex flex-col gap-2">
                <AnimatePresence initial={false}>
                  {live.map((m, i) => (
                    <MeetingRow key={m.id} m={m} now={now} index={i} />
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          ) : null}
          {days.map(([label, rows]) => (
            <section key={label} className="flex flex-col gap-3">
              <SectionLabel>
                {label}
                <span className="ml-2 text-muted-foreground">{rows.length}</span>
              </SectionLabel>
              <ul className="flex flex-col">
                <AnimatePresence initial={false}>
                  {rows.map((m, i) => (
                    <MeetingRow key={m.id} m={m} now={now} index={i} />
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          ))}
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

function MeetingRow({ m, now, index }: { m: Row; now: number; index: number }) {
  const dismiss = useDismissMeeting();
  const live = m.phase === 'live';
  const soon = m.phase === 'soon';
  const link = m.joinUrl ?? m.htmlLink;

  const join = () => {
    if (!link) return;
    window.open(link, '_blank', 'noopener,noreferrer');
    if (!m.dismissed && (live || soon)) dismiss.mutate({ id: m.id });
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { ...SPRING.settle, delay: index * 0.03 } }}
      exit={{ opacity: 0, x: 16, transition: SPRING.settle }}
      className={cn(
        'group grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 py-3 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]',
        live
          ? 'rounded-surface border border-emphasis/30 bg-emphasis/[0.04] px-4'
          : 'border-b border-hairline last:border-b-0',
      )}
    >
      <div className="flex flex-col pt-0.5 font-mono text-xs tabular-nums">
        <span className={cn(live || soon ? 'text-foreground' : 'text-foreground/80')}>
          {timeFmt.format(m.start)}
        </span>
        <span className="text-muted-foreground">{timeFmt.format(m.end)}</span>
      </div>

      <div className={cn('min-w-0', m.dismissed && !live && 'opacity-70')}>
        <div className="flex items-center gap-2">
          {live || soon ? <Dot live={live} /> : null}
          <h2 className="truncate text-sm leading-snug font-semibold tracking-[-0.01em]">
            {m.title}
          </h2>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className={cn(live ? 'text-emphasis' : soon && 'text-foreground')}>
            {live ? left(m, now) : until(m.start - now)}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="size-3.5" aria-hidden />
            {duration(m)}
          </span>
          {m.calendarId !== 'primary' ? <span className="truncate">{m.calendarId}</span> : null}
          {RESPONSE_NOTE[m.response] ? <span>{RESPONSE_NOTE[m.response]}</span> : null}
          {m.dismissed ? <span>Alert dismissed</span> : null}
        </p>
        {live ? <Progress start={m.start} end={m.end} now={now} /> : null}
      </div>

      <div className="col-start-2 flex items-center gap-1.5 sm:col-start-auto sm:justify-end">
        {m.joinUrl ? (
          <Button size="sm" variant={live || soon ? 'default' : 'outline'} onClick={join}>
            <Video className="size-4" aria-hidden />
            Join
          </Button>
        ) : null}
        {m.htmlLink ? (
          <Button
            size="icon"
            variant="ghost"
            asChild
            aria-label="Open in Google Calendar"
            title="Open in Google Calendar"
          >
            <a href={m.htmlLink} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden />
            </a>
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({ id: m.id, dismissed: !m.dismissed })}
          aria-label={m.dismissed ? 'Show the alert again' : 'Dismiss the alert'}
          title={m.dismissed ? 'Show the alert again' : 'Dismiss the alert'}
        >
          {m.dismissed ? (
            <Undo2 className="size-4" aria-hidden />
          ) : (
            <X className="size-4" aria-hidden />
          )}
        </Button>
      </div>
    </motion.li>
  );
}

function Dot({ live }: { live: boolean }) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center" aria-hidden>
      {live ? (
        <span className="absolute inset-0 rounded-full bg-emphasis/50 motion-safe:animate-ping" />
      ) : null}
      <span
        className={cn(
          'relative size-2 rounded-full',
          live ? 'bg-emphasis' : 'border border-emphasis/70',
        )}
      />
    </span>
  );
}

function Progress({ start, end, now }: { start: number; end: number; now: number }) {
  const p = Math.min(1, Math.max(0, (now - start) / (end - start)));
  return (
    <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-foreground/8" aria-hidden>
      <motion.div
        className="h-full origin-left rounded-full bg-emphasis"
        initial={false}
        animate={{ scaleX: p }}
        transition={SPRING.settle}
      />
    </div>
  );
}
