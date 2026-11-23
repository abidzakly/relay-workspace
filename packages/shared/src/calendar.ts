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

/** Non-secret settings (`state.calendar.config`). */
export const CalendarConfigSchema = z.object({
  /** OAuth client id of a Google Cloud "Desktop app" client. */
  clientId: z.string().trim().max(255).default(''),
  calendarIds: z.array(CalendarIdSchema).min(1).max(10).default(['primary']),
  /** How early the alert shows "starting soon", in seconds. 0 = only once the meeting has started. */
  leadSeconds: z.int().min(0).max(900).default(60),
  /** How far ahead Relay reads, in days: the Meetings page lists this range. 1 = the next 24 hours. */
  lookAheadDays: z.int().min(1).max(CALENDAR_MAX_LOOK_AHEAD_DAYS).default(1),
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
  response: z.enum(MEETING_RESPONSES),
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
