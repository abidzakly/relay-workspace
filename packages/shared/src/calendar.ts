import { z } from 'zod';
import { EpochMsSchema } from './common';

/**
 * Google Calendar (read-only). Relay reads your meetings so a floating alert can stay on screen while one is under way
 * and you have not joined or dismissed it. The OAuth client is your own (Google Cloud, type "Desktop app"); its secret
 * and the refresh token are encrypted at rest and never returned by the API.
 */

/** Up to a month ahead. */
export const CALENDAR_MAX_LOOK_AHEAD_DAYS = 31;

/** Calendar ids are e-mail-like (`primary`, `you@company.com`, `…@group.calendar.google.com`). */
export const CalendarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s/?#]+$/, 'not a calendar id');

/**
 * How much a meeting asks for attention. `key`: never fades, gets a beam on the Horizon, an earlier alert and a
 * day-before reminder. `quiet`: dimmed (optional meetings, office hours). Set by a title rule or by hand.
 */
export const MEETING_PRIORITIES = ['key', 'normal', 'quiet'] as const;
export const MeetingPrioritySchema = z.enum(MEETING_PRIORITIES);
export type MeetingPriority = z.infer<typeof MeetingPrioritySchema>;

/** A title rule: a meeting whose title contains `match` (any case) gets `level`. The first matching rule wins. */
export const PriorityRuleSchema = z.object({
  match: z.string().trim().min(1).max(80),
  level: z.enum(['key', 'quiet']),
});
export type PriorityRule = z.infer<typeof PriorityRuleSchema>;

export const DEFAULT_PRIORITY_RULES: PriorityRule[] = [
  { match: 'Monthly', level: 'key' },
  { match: 'Sprint Review', level: 'key' },
  { match: 'Backlog', level: 'key' },
  { match: 'UAT', level: 'key' },
];

/** Non-secret settings (`state.calendar.config`). */
export const CalendarConfigSchema = z.object({
  /** OAuth client id of a Google Cloud "Desktop app" client. */
  clientId: z.string().trim().max(255).default(''),
  calendarIds: z.array(CalendarIdSchema).min(1).max(10).default(['primary']),
  /** How early the alert shows "starting soon", in seconds. 0 = only once the meeting has started. */
  leadSeconds: z.int().min(0).max(900).default(60),
  /** How far ahead Relay reads, in days: the Meetings page lists this range. 1 = the next 24 hours. */
  lookAheadDays: z.int().min(1).max(CALENDAR_MAX_LOOK_AHEAD_DAYS).default(1),
  priorityRules: z
    .array(PriorityRuleSchema)
    .max(30)
    .default(() => DEFAULT_PRIORITY_RULES.map((r) => ({ ...r }))),
  /** How early the alert shows a Key meeting, in seconds (normal meetings use `leadSeconds`). */
  keyLeadSeconds: z.int().min(0).max(3600).default(600),
});
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;

/** `PUT /api/calendar/config`. `clientSecret`: `undefined` keeps it, `null` clears it, a string replaces it. */
export const CalendarConfigUpdateSchema = CalendarConfigSchema.extend({
  clientSecret: z.string().trim().min(1).max(255).nullable().optional(),
});
export type CalendarConfigUpdate = z.infer<typeof CalendarConfigUpdateSchema>;

export const CalendarStatusSchema = z.object({
  config: CalendarConfigSchema,
  clientSecretSet: z.boolean(),
  connected: z.boolean(),
  /** The Google account the refresh token belongs to, when known. */
  accountEmail: z.string().nullable(),
  /** Last successful read of the calendar(s). */
  lastSyncAt: EpochMsSchema.nullable(),
  /** Last read error, worded for a person (never a token or response body). */
  lastError: z.string().nullable(),
  /** The redirect address Google sends you back to (shown so it can be checked against the client). */
  redirectUri: z.string(),
});
export type CalendarStatus = z.infer<typeof CalendarStatusSchema>;

export const MEETING_RESPONSES = ['accepted', 'tentative', 'needsAction', 'none'] as const;

export const MeetingSchema = z.object({
  /** `<calendarId>|<eventId>`: unique across calendars, stable across polls. */
  id: z.string().min(1).max(600),
  title: z.string(),
  start: EpochMsSchema,
  end: EpochMsSchema,
  /** Google Meet / Zoom / Teams link when the event has one. */
  joinUrl: z.string().nullable(),
  /** The event in Google Calendar. */
  htmlLink: z.string().nullable(),
  calendarId: z.string(),
  /** Google's `recurringEventId`: every occurrence of a repeating meeting shares it. */
  seriesId: z.string().nullable(),
  response: z.enum(MEETING_RESPONSES),
  priority: MeetingPrioritySchema,
  /** Why it has that priority, for a person: `Marked by you`, `Title contains “UAT”`. Null for plain normal. */
  priorityReason: z.string().nullable(),
  /** Where the priority came from: a hand-set mark (one meeting / every occurrence), a title rule, or nothing. */
  prioritySource: z.enum(['one', 'series', 'rule', 'none']),
  /** Dismissed here (or joined from the alert): the alert no longer shows it. */
  dismissed: z.boolean(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const MeetingListSchema = z.object({
  meetings: z.array(MeetingSchema),
  connected: z.boolean(),
  leadSeconds: z.int().nonnegative(),
  /** The range read ahead, in days (`CalendarConfig.lookAheadDays`). */
  lookAheadDays: z.int().positive(),
  keyLeadSeconds: z.int().nonnegative(),
  /** Server clock when the list was made: the browser corrects its own clock drift with it. */
  now: EpochMsSchema,
});
export type MeetingList = z.infer<typeof MeetingListSchema>;

/** Where a meeting stands at `now`. `soon` = inside the lead time before it starts. */
export type MeetingPhase = 'later' | 'soon' | 'live' | 'over';

export function meetingPhase(
  m: Pick<Meeting, 'start' | 'end'>,
  now: number,
  leadSeconds: number,
): MeetingPhase {
  if (now >= m.end) return 'over';
  if (now >= m.start) return 'live';
  if (now >= m.start - leadSeconds * 1000) return 'soon';
  return 'later';
}

/**
 * Only `https:` links leave Relay. Event links come from whoever wrote the invitation, so anything else (a
 * `javascript:` URL in a location field, say) is dropped.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The alert lead for one meeting: Key meetings show earlier. */
export function meetingLead(
  m: Pick<Meeting, 'priority'>,
  list: Pick<MeetingList, 'leadSeconds' | 'keyLeadSeconds'>,
): number {
  return m.priority === 'key' ? Math.max(list.leadSeconds, list.keyLeadSeconds) : list.leadSeconds;
}

/** Hand-set priorities (`state.calendar.marks`). `one:<meetingId>` or `series:<calendarId>|<seriesId>`. */
export type PriorityMarks = Record<string, MeetingPriority>;
export const PriorityMarksSchema = z.record(z.string().min(1).max(700), MeetingPrioritySchema);

export const markKeyOne = (meetingId: string) => `one:${meetingId}`;
export const markKeySeries = (calendarId: string, seriesId: string) =>
  `series:${calendarId}|${seriesId}`;

export function matchPriority(title: string, rules: readonly PriorityRule[]): PriorityRule | null {
  const t = title.toLowerCase();
  return rules.find((r) => t.includes(r.match.toLowerCase())) ?? null;
}

/** One-off mark, then series mark, then the first title rule, then normal. Pure. */
export function resolvePriority(
  m: Pick<Meeting, 'id' | 'title' | 'calendarId' | 'seriesId'>,
  rules: readonly PriorityRule[],
  marks: PriorityMarks,
): Pick<Meeting, 'priority' | 'priorityReason' | 'prioritySource'> {
  const one = marks[markKeyOne(m.id)];
  if (one)
    return { priority: one, priorityReason: 'Marked by you (this meeting)', prioritySource: 'one' };
  const series = m.seriesId ? marks[markKeySeries(m.calendarId, m.seriesId)] : undefined;
  if (series)
    return {
      priority: series,
      priorityReason: 'Marked by you (every occurrence)',
      prioritySource: 'series',
    };
  const rule = matchPriority(m.title, rules);
  if (rule)
    return {
      priority: rule.level,
      priorityReason: `Title contains “${rule.match}”`,
      prioritySource: 'rule',
    };
  return { priority: 'normal', priorityReason: null, prioritySource: 'none' };
}

/** `POST /api/calendar/meetings/priority`. `level: null` drops the mark: the rules decide again. */
export const MeetingPriorityBodySchema = z.object({
  id: z.string().min(1).max(600),
  calendarId: z.string().min(1).max(255),
  seriesId: z.string().min(1).max(400).nullable(),
  scope: z.enum(['one', 'series']),
  level: MeetingPrioritySchema.nullable(),
});
export type MeetingPriorityBody = z.infer<typeof MeetingPriorityBodySchema>;
