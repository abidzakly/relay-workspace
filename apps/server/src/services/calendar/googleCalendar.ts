import { createHash, randomBytes } from 'node:crypto';
import { safeExternalUrl, type Meeting } from '@relay/shared';
import type { HttpClient } from '../httpClient';

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

/** One Calendar v3 event -> a meeting, or null when it is not one to alert about. Pure. */
export function toMeeting(calendarId: string, raw: unknown): Omit<Meeting, 'dismissed'> | null {
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
  return {
    id: `${calendarId}|${id}`.slice(0, 600),
    title: (str(ev.summary) ?? '(No title)').slice(0, 300),
    start,
    end,
    joinUrl: joinUrlOf(ev),
    htmlLink: safeExternalUrl(ev.htmlLink),
    calendarId,
    response,
  };
}

/** Pages of 250 events, at most this many: a month of a busy calendar fits with room to spare. */
const MAX_PAGES = 8;

/** Events of one calendar between `from` and `to` (recurring ones expanded), following `nextPageToken`. */
export async function listMeetings(
  http: HttpClient,
  o: { accessToken: string; calendarId: string; from: number; to: number },
): Promise<Omit<Meeting, 'dismissed'>[]> {
  const out: Omit<Meeting, 'dismissed'>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, next } = await listPage(http, o, pageToken);
    out.push(...items);
    if (!next) break;
    pageToken = next;
  }
  return out;
}

async function listPage(
  http: HttpClient,
  o: { accessToken: string; calendarId: string; from: number; to: number },
  pageToken: string | undefined,
): Promise<{ items: Omit<Meeting, 'dismissed'>[]; next: string | undefined }> {
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
    next: str(body.nextPageToken),
  };
}
