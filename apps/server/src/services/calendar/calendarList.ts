import type { CalendarListResult, CalendarOption } from '@relay/shared';
import type { HttpClient } from '../httpClient';
import { GoogleError } from './googleCalendar';

const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * The calendars of the signed-in account (Calendar API `calendarList.list`), primary first. A sign-in made before
 * Relay asked for the calendar list answers 403: that is `needsConsent`, not an error.
 */
export async function listCalendars(
  http: HttpClient,
  accessToken: string,
): Promise<CalendarListResult> {
  const out: CalendarOption[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({
      maxResults: '250',
      minAccessRole: 'reader',
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await http.send({
      url: `${CALENDAR_LIST_URL}?${q.toString()}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 403) return { calendars: [], needsConsent: true };
    if (res.status === 401) throw new GoogleError('Google sign-in expired.', false);
    if (res.status !== 200) throw new GoogleError(`Google Calendar answered HTTP ${res.status}.`);
    const j = rec(res.json);
    for (const item of Array.isArray(j.items) ? (j.items as unknown[]) : []) {
      const o = rec(item);
      const id = str(o.id);
      if (!id || o.hidden === true) continue;
      out.push({
        id,
        summary: str(o.summaryOverride) ?? str(o.summary) ?? id,
        primary: o.primary === true,
        color: str(o.backgroundColor) ?? null,
        accessRole: str(o.accessRole) ?? 'reader',
      });
    }
    pageToken = str(j.nextPageToken);
    if (!pageToken) break;
  }
  out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
  return { calendars: out, needsConsent: false };
}
