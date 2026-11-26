import { createHash, randomBytes } from 'node:crypto';
import { isHolidayCalendar, safeExternalUrl, type Holiday, type Meeting } from '@relay/shared';
import type { HttpClient } from '../httpClient';
import { CALENDAR_LIST_SCOPE } from '../oauth/providers';

/**
 * Google OAuth 2.0 (installed-app flow: PKCE + loopback redirect) and Calendar v3 `events.list`, as plain REST through
 * the shared HTTP client. Endpoints are fixed on purpose: nothing from a response chooses where a secret is sent.
 * Response shapes follow Google's documented OAuth2 and Calendar v3 APIs.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_EVENTS_URL = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
/** Read-only: Relay never writes to your calendar. */
export const CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  CALENDAR_LIST_SCOPE,
].join(' ');

/** A Google error worded for a person. Never carries a token or a response body. */
export class GoogleError extends Error {
  constructor(
    message: string,
    /** The refresh token is no longer valid: the user must connect again. */
    readonly revoked = false,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function makePkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authUrl(o: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPES,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    // A refresh token every time: Relay keeps reading after the browser tab is gone.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  email?: string;
}

/** The e-mail claim of the id_token. It came straight from Google's token endpoint over TLS, so it is not re-verified. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    return str(rec(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).email);
  } catch {
    return undefined;
  }
}

async function tokenRequest(
  http: HttpClient,
  form: Record<string, string>,
  now: number,
): Promise<TokenSet> {
  const res = await http.send({
    method: 'POST',
    url: GOOGLE_TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    maxRetries: 0,
  });
  const j = rec(res.json);
  const accessToken = str(j.access_token);
  if (res.status === 200 && accessToken) {
    const secs = typeof j.expires_in === 'number' ? j.expires_in : 3600;
    const refreshToken = str(j.refresh_token);
    const email = emailFromIdToken(str(j.id_token));
    return {
      accessToken,
      // A minute early: a token that expires in flight would fail the read.
      expiresAt: now + Math.max(60, secs - 60) * 1000,
      ...(refreshToken ? { refreshToken } : {}),
      ...(email ? { email } : {}),
    };
  }
  const err = str(j.error);
  if (err === 'invalid_grant')
    throw new GoogleError('Google no longer accepts this sign-in. Connect again.', true);
  if (err === 'invalid_client' || err === 'unauthorized_client')
    throw new GoogleError('Google rejected the OAuth client. Check the client ID and secret.');
  throw new GoogleError(`Google sign-in failed (${err ?? `HTTP ${res.status}`}).`);
}

export function exchangeCode(
  http: HttpClient,
  o: {
    clientId: string;
    clientSecret: string;
    code: string;
    verifier: string;
    redirectUri: string;
  },
  now: number,
): Promise<TokenSet> {
  return tokenRequest(
    http,
    {
      grant_type: 'authorization_code',
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      code_verifier: o.verifier,
      redirect_uri: o.redirectUri,
    },
    now,
  );
}

export function refreshAccess(
  http: HttpClient,
  o: { clientId: string; clientSecret: string; refreshToken: string },
  now: number,
): Promise<TokenSet> {
  return tokenRequest(
    http,
    {
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      client_id: o.clientId,
      client_secret: o.clientSecret,
    },
    now,
  );
}

/** Best effort: disconnecting must work even when Google cannot be reached. */
export async function revoke(http: HttpClient, token: string): Promise<void> {
  try {
    await http.send({
      method: 'POST',
      url: GOOGLE_REVOKE_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      maxRetries: 0,
    });
  } catch {
    /* offline: the token stays valid at Google until it expires or is removed there */
  }
}

/** A meeting as Google has it: no local state (dismissed, priority) yet. */
export type RawMeeting = Omit<
  Meeting,
  'dismissed' | 'presence' | 'priority' | 'priorityReason' | 'prioritySource'
>;

/** Event types that are not meetings. */
const SKIP_TYPES = new Set(['workingLocation', 'outOfOffice', 'focusTime', 'birthday']);
const MEETING_LINK =
  /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w-]+\.zoom\.us\/[^\s"'<>]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+)/i;

function joinUrlOf(ev: Record<string, unknown>): string | null {
  const hangout = safeExternalUrl(ev.hangoutLink);
  if (hangout) return hangout;
  const entries = rec(ev.conferenceData).entryPoints;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const ep = rec(e);
      if (ep.entryPointType === 'video') {
        const u = safeExternalUrl(ep.uri);
        if (u) return u;
      }
    }
  }
  for (const field of [ev.location, ev.description]) {
    const m = typeof field === 'string' ? MEETING_LINK.exec(field) : null;
    const u = m ? safeExternalUrl(m[0]) : null;
    if (u) return u;
  }
  return null;
}

/** Any link, and the dial-in noise invitations put in the location ("Zoom Meeting", "Microsoft Teams Meeting"). */
const ANY_URL = /https?:\/\/\S+/gi;
const CALL_WORDS =
  /^(?:google meet|meet|zoom(?: meeting)?|microsoft teams(?: meeting)?|teams(?: meeting)?|online|virtual|webex)$/i;

/** The place in an invitation's location: links and call-service names dropped, what is left trimmed. Pure. */
export function placeOf(location: unknown): string | null {
  if (typeof location !== 'string') return null;
  const parts = location
    .replace(ANY_URL, ' ')
    .split(/[;\n]+/)
    .map((p) => p.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, ''))
    .filter((p) => p && !CALL_WORDS.test(p));
  const place = parts.join(' · ').slice(0, 200);
  return place || null;
}

/** Which call service a join link belongs to. */
export function providerOf(url: string | null): Meeting['provider'] {
  if (!url) return null;
  const host = new URL(url).hostname;
  if (host === 'meet.google.com') return 'meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
  return 'other';
}

export function modeOf(joinUrl: string | null, place: string | null): Meeting['mode'] {
  if (joinUrl && place) return 'hybrid';
  if (joinUrl) return 'online';
  if (place) return 'onsite';
  return 'unknown';
}

/** One Calendar v3 event -> a meeting, or null when it is not one to alert about. Pure. */
export function toMeeting(calendarId: string, raw: unknown): RawMeeting | null {
  const ev = rec(raw);
  const id = str(ev.id);
  if (!id || ev.status === 'cancelled' || ev.transparency === 'transparent') return null;
  if (typeof ev.eventType === 'string' && SKIP_TYPES.has(ev.eventType)) return null;
  // All-day events have `date`, not `dateTime`: they are not meetings.
  const start = Date.parse(str(rec(ev.start).dateTime) ?? '');
  const end = Date.parse(str(rec(ev.end).dateTime) ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  let response: Meeting['response'] = 'none';
  if (Array.isArray(ev.attendees)) {
    const self = ev.attendees.map(rec).find((a) => a.self === true);
    const r = self?.responseStatus;
    if (r === 'declined') return null;
    if (r === 'accepted' || r === 'tentative' || r === 'needsAction') response = r;
  }
  const joinUrl = joinUrlOf(ev);
  const place = placeOf(ev.location);
  return {
    id: `${calendarId}|${id}`.slice(0, 600),
    title: (str(ev.summary) ?? '(No title)').slice(0, 300),
    start,
    end,
    joinUrl,
    mode: modeOf(joinUrl, place),
    place,
    provider: providerOf(joinUrl),
    htmlLink: safeExternalUrl(ev.htmlLink),
    calendarId,
    seriesId: str(ev.recurringEventId)?.slice(0, 400) ?? null,
    response,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A holiday spanning more days than this is cut short (a holiday calendar never has one this long). */
const MAX_HOLIDAY_DAYS = 14;

/**
 * One all-day event of a holiday calendar -> one entry per day it covers (Google's end date is exclusive), or none
 * when it is not an all-day event. Pure.
 */
export function toHolidays(calendarId: string, raw: unknown): Holiday[] {
  const ev = rec(raw);
  const id = str(ev.id);
  const first = str(rec(ev.start).date);
  if (!id || ev.status === 'cancelled' || !first || !DATE_RE.test(first)) return [];
  const endRaw = str(rec(ev.end).date);
  const end = endRaw && DATE_RE.test(endRaw) && endRaw > first ? endRaw : null;
  const title = (str(ev.summary) ?? 'Public holiday').slice(0, 300);
  const out: Holiday[] = [];
  const d = new Date(`${first}T00:00:00Z`);
  for (let i = 0; i < MAX_HOLIDAY_DAYS; i++) {
    const date = d.toISOString().slice(0, 10);
    if (i > 0 && (!end || date >= end)) break;
    out.push({ id: `${calendarId}|${id}|${date}`.slice(0, 700), date, title, calendarId });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Pages of 250 events, at most this many: a month of a busy calendar fits with room to spare. */
const MAX_PAGES = 8;

/**
 * Events of one calendar between `from` and `to` (recurring ones expanded), following `nextPageToken`. Holidays are
 * read only from a holiday calendar; any other all-day event is left out, as before.
 */
export async function listEvents(
  http: HttpClient,
  o: { accessToken: string; calendarId: string; from: number; to: number },
): Promise<{ meetings: RawMeeting[]; holidays: Holiday[] }> {
  const meetings: RawMeeting[] = [];
  const holidays: Holiday[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listPage(http, o, pageToken);
    meetings.push(...res.items);
    holidays.push(...res.holidays);
    if (!res.next) break;
    pageToken = res.next;
  }
  return { meetings, holidays };
}

/** The meetings of one calendar (see `listEvents`). */
export async function listMeetings(
  http: HttpClient,
  o: { accessToken: string; calendarId: string; from: number; to: number },
): Promise<RawMeeting[]> {
  return (await listEvents(http, o)).meetings;
}

async function listPage(
  http: HttpClient,
  o: { accessToken: string; calendarId: string; from: number; to: number },
  pageToken: string | undefined,
): Promise<{ items: RawMeeting[]; holidays: Holiday[]; next: string | undefined }> {
  const q = new URLSearchParams({
    timeMin: new Date(o.from).toISOString(),
    timeMax: new Date(o.to).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
    ...(pageToken ? { pageToken } : {}),
  });
  const res = await http.send({
    url: `${CALENDAR_EVENTS_URL(o.calendarId)}?${q.toString()}`,
    headers: { authorization: `Bearer ${o.accessToken}` },
  });
  if (res.status === 401) throw new GoogleError('Google sign-in expired.', false);
  if (res.status === 403)
    throw new GoogleError(
      'Google refused the read. Enable the Google Calendar API for this OAuth client’s project.',
    );
  if (res.status === 404) throw new GoogleError(`Calendar “${o.calendarId}” was not found.`);
  if (res.status !== 200) throw new GoogleError(`Google Calendar answered HTTP ${res.status}.`);
  const body = rec(res.json);
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    items: items
      .map((it) => toMeeting(o.calendarId, it))
      .filter((m): m is NonNullable<typeof m> => m !== null),
    holidays: isHolidayCalendar(o.calendarId)
      ? items.flatMap((it) => toHolidays(o.calendarId, it))
      : [],
    next: str(body.nextPageToken),
  };
}
