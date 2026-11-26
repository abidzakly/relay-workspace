import { PartyPopper } from 'lucide-react';
import type { Holiday } from '@relay/shared';
import { cn } from '@/lib/utils';
import { dayLabel, dayStart, DAY_MS, monthDay, shortWeekday } from './meetingView';

/** `YYYY-MM-DD` -> local midnight. Holiday dates have no time zone: the date is the same everywhere. */
function localDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

function when(at: number, now: number): string {
  const diff = Math.round((at - dayStart(now)) / DAY_MS);
  if (diff === 0 || diff === 1) return dayLabel(at, now);
  return `${shortWeekday(at)}, ${monthDay(at)}`;
}

/**
 * Public holidays in the range, from a holiday calendar (Settings > Google > Calendars). One quiet line under the
 * page title: a holiday is a day, not a meeting, so it never alerts.
 */
export function HolidayStrip({ holidays, now }: { holidays: Holiday[]; now: number }) {
  if (holidays.length === 0) return null;
  return (
    <ul
      aria-label="Public holidays"
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      <li className="inline-flex items-center gap-1 type-micro text-foreground">
        <PartyPopper className="size-3.5" aria-hidden />
        Holidays
      </li>
      {holidays.map((h) => {
        const at = localDay(h.date);
        const today = at === dayStart(now);
        return (
          <li
            key={h.id}
            title={h.calendarId}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-full border border-hairline px-2 py-0.5',
              today ? 'bg-foreground/[0.08] text-foreground' : 'bg-foreground/[0.04]',
            )}
          >
            <span className="font-mono tabular-nums">{when(at, now)}</span>
            <span className="truncate text-foreground">{h.title}</span>
          </li>
        );
      })}
    </ul>
  );
}
