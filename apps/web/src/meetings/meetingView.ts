import { useCallback, useState } from 'react';
import type { Meeting, MeetingPhase } from '@relay/shared';

/** Pure helpers shared by the Meetings page's two views (Horizon and List), and the view choice itself. */

export type Row = Meeting & { phase: MeetingPhase };

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortWeekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const monthDayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });

/** `[MDD] Sprint Review` -> tag `MDD`, title `Sprint Review`. Teams prefix titles this way; the tag reads better apart. */
export function splitTitle(title: string): { tag: string | null; text: string } {
  const m = /^\s*[[(]([^\])]{1,24})[\])]\s*[-:·]?\s*(.+)$/.exec(title);
  return m ? { tag: m[1]!.trim(), text: m[2]!.trim() } : { tag: null, text: title };
}

export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 of the week `ms` falls in. */
export function weekStart(ms: number): number {
  const d = new Date(dayStart(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

const addDays = (ms: number, n: number) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};

export function dayLabel(start: number, now: number): string {
  const diff = Math.round((dayStart(start) - dayStart(now)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return weekdayFmt.format(start);
}

export const shortWeekday = (ms: number) => shortWeekdayFmt.format(ms);
export const monthDay = (ms: number) => monthDayFmt.format(ms);
export const monthShort = (ms: number) => monthFmt.format(ms);

export function weekLabel(ws: number, now: number): string {
  const diff = Math.round((ws - weekStart(now)) / (7 * DAY_MS));
  if (diff === 0) return 'This week';
  if (diff === 1) return 'Next week';
  return `${monthDay(ws)} – ${monthDay(addDays(ws, 6))}`;
}

export function duration(m: Pick<Meeting, 'start' | 'end'>): string {
  const min = Math.round((m.end - m.start) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** `in 12 min`, `in 3 h 5 min`, `in 2 days`. */
export function until(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return 'in a minute';
  if (min < 60) return `in ${min} min`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60);
    return min % 60 && h < 10 ? `in ${h} h ${min % 60} min` : `in ${h} h`;
  }
  return `in ${Math.round(min / 1440)} days`;
}

export function left(m: Pick<Meeting, 'end'>, now: number): string {
  const min = Math.max(1, Math.ceil((m.end - now) / 60_000));
  return min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h ${min % 60} min left`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A countdown split for poster type: `{ big: '44', unit: 'h', small: '34 min' }`. */
export function countdown(ms: number): { big: string; unit: string; small: string | null } {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days >= 2) return { big: String(days), unit: 'days', small: h ? `${h} h` : null };
  if (s >= 3600) return { big: String(Math.floor(s / 3600)), unit: 'h', small: `${m} min` };
  return { big: `${m}:${pad(s % 60)}`, unit: 'min', small: null };
}

export interface DayGroup {
  key: number;
  meetings: Row[];
}
export interface WeekGroup {
  key: number;
  label: string;
  days: DayGroup[];
}

/** Upcoming meetings (not live) by week, then by day. Live meetings are shown apart. */
export function groupByWeek(rows: readonly Row[], now: number): WeekGroup[] {
  const weeks = new Map<number, Map<number, Row[]>>();
  for (const m of rows) {
    const w = weekStart(m.start);
    const d = dayStart(m.start);
    const days = weeks.get(w) ?? new Map<number, Row[]>();
    days.set(d, [...(days.get(d) ?? []), m]);
    weeks.set(w, days);
  }
  return [...weeks].map(([w, days]) => ({
    key: w,
    label: weekLabel(w, now),
    days: [...days].map(([d, meetings]) => ({ key: d, meetings })),
  }));
}

export interface DensityDay {
  key: number;
  hours: number;
  count: number;
  hasKey: boolean;
}

/** Booked hours per day from today over `days` days, for the density strip. */
export function density(rows: readonly Row[], now: number, days: number): DensityDay[] {
  const first = dayStart(now);
  const out: DensityDay[] = Array.from({ length: days }, (_, i) => ({
    key: addDays(first, i),
    hours: 0,
    count: 0,
    hasKey: false,
  }));
  const byKey = new Map(out.map((d) => [d.key, d]));
  for (const m of rows) {
    const d = byKey.get(dayStart(m.start));
    if (!d) continue;
    d.hours += (m.end - m.start) / HOUR_MS;
    d.count += 1;
    if (m.priority === 'key') d.hasKey = true;
  }
  return out;
}

export type MeetingsView = 'horizon' | 'list';
const VIEW_KEY = 'relay.meetings.view';

/** Horizon or List, remembered on this device (not a setting: two browsers may want different ones). */
export function useMeetingsView(): [MeetingsView, (v: MeetingsView) => void] {
  const [view, setView] = useState<MeetingsView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'horizon';
    } catch {
      return 'horizon';
    }
  });
  const set = useCallback((v: MeetingsView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode: the choice lasts for this visit */
    }
  }, []);
  return [view, set];
}
