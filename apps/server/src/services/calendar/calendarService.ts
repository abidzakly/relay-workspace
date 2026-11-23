import { randomBytes } from 'node:crypto';
import {
  CalendarConfigSchema,
  type CalendarConfig,
  type CalendarConfigUpdate,
  type CalendarStatus,
  type Meeting,
  type MeetingList,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { EventBus } from '../../sync/eventBus';
import type { Logger } from '../../util/logger';
import type { HttpClient } from '../httpClient';
import type { Notifier } from '../notifier';
import {
  authUrl,
  exchangeCode,
  GoogleError,
  listMeetings,
  makePkce,
  refreshAccess,
  revoke,
} from './googleCalendar';

/**
 * Google Calendar meetings for the floating alert. A light poll (once a minute while connected and switched on) keeps
 * today's meetings in memory; a timer fires at the next start so the push notification is on time. Read-only: nothing
 * here writes to Google. Everything is kept in `settings` rows (no table of its own):
 *   state.calendar.config     client id, calendar ids, lead time
 *   state.calendar.account    the connected Google account's e-mail
 *   state.calendar.dismissed  meeting id -> its end (pruned once it is over)
 *   secret.gcal.clientSecret  the OAuth client secret        (encrypted)
 *   secret.gcal.refreshToken  the refresh token              (encrypted)
 */

/** Also read by the config backup (`services/configBackup.ts`). */
export const CALENDAR_CONFIG_KEY = 'calendar.config';
export const CALENDAR_CLIENT_SECRET_KEY = 'gcal.clientSecret';
const CONFIG = CALENDAR_CONFIG_KEY;
const ACCOUNT = 'calendar.account';
const DISMISSED = 'calendar.dismissed';
const CLIENT_SECRET = CALENDAR_CLIENT_SECRET_KEY;
const REFRESH_TOKEN = 'gcal.refreshToken';

export const CALENDAR_POLL_MS = 60_000;
/** Read from 12 h back (a long meeting already under way) to 24 h ahead. */
const LOOK_BACK_MS = 12 * 3_600_000;
const LOOK_AHEAD_MS = 24 * 3_600_000;
const OAUTH_TTL_MS = 10 * 60_000;
/** A push for a meeting that started longer ago than this is not sent (a restart mid-meeting must not ping). */
const NOTIFY_GRACE_MS = 5 * 60_000;

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

export interface CalendarServiceDeps {
  config: Pick<
    ConfigStore,
    'getGlobalStored' | 'getState' | 'setState' | 'getSecret' | 'setSecret'
  >;
  http: HttpClient;
  bus: EventBus;
  notifier?: Pick<Notifier, 'notifyCockpit'>;
  log: Logger;
  /** Where Google sends the browser back: `http://127.0.0.1:<port>/api/calendar/oauth/callback`. */
  redirectUri: string;
  now?: () => number;
}

type Raw = Omit<Meeting, 'dismissed'>;

export class CalendarService {
  private readonly now: () => number;
  private pollTimer: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private access: { token: string; expiresAt: number } | undefined;
  private meetings: Raw[] = [];
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private readonly pending = new Map<string, { verifier: string; at: number }>();
  private readonly notified = new Set<string>();
  private inFlight: Promise<void> | undefined;

  constructor(private readonly d: CalendarServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Starts the poll loop. Each tick checks the switch and the connection itself, so a change applies at once. */
  start(): void {
    if (this.pollTimer) return;
    this.stopped = false;
    const tick = () => {
      void this.refresh().finally(() => {
        if (!this.stopped) this.pollTimer = setTimeout(tick, CALENDAR_POLL_MS);
      });
    };
    this.pollTimer = setTimeout(tick, 3_000);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.startTimer);
    this.pollTimer = undefined;
    this.startTimer = undefined;
  }

  private enabled(): boolean {
    return this.d.config.getGlobalStored().features.calendar;
  }

  private connected(): boolean {
    return !!this.d.config.getSecret(REFRESH_TOKEN);
  }

  // ───────────────────────────── settings ─────────────────────────────

  getConfig(): CalendarConfig {
    const parsed = CalendarConfigSchema.safeParse(this.d.config.getState(CONFIG) ?? {});
    return parsed.success ? parsed.data : CalendarConfigSchema.parse({});
  }

  status(): CalendarStatus {
    return {
      config: this.getConfig(),
      clientSecretSet: !!this.d.config.getSecret(CLIENT_SECRET),
      connected: this.connected(),
      accountEmail: this.d.config.getState<{ email?: string }>(ACCOUNT)?.email ?? null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      redirectUri: this.d.redirectUri,
    };
  }

  /** Saves the settings. A different OAuth client cannot use the old refresh token, so that disconnects. */
  async saveConfig(input: CalendarConfigUpdate): Promise<CalendarStatus> {
    const before = this.getConfig();
    const { clientSecret, ...rest } = input;
    const next = CalendarConfigSchema.parse(rest);
    this.d.config.setState(CONFIG, next);
    if (clientSecret !== undefined) this.d.config.setSecret(CLIENT_SECRET, clientSecret);
    if (before.clientId !== next.clientId || clientSecret !== undefined) {
      if (this.connected()) await this.disconnect();
    } else {
      void this.refresh();
    }
    this.changed();
    return this.status();
  }

  // ───────────────────────────── OAuth ─────────────────────────────

  /** The Google consent URL to open. Needs a saved client id and secret. */
  beginConnect(): string {
    const cfg = this.getConfig();
    if (!cfg.clientId || !this.d.config.getSecret(CLIENT_SECRET)) {
      throw new OAuthStateError('Save the OAuth client ID and secret first.');
    }
    this.prunePending();
    const state = randomBytes(24).toString('base64url');
    const pkce = makePkce();
    this.pending.set(state, { verifier: pkce.verifier, at: this.now() });
    return authUrl({
      clientId: cfg.clientId,
      redirectUri: this.d.redirectUri,
      state,
      challenge: pkce.challenge,
    });
  }

  /** Google's redirect: checks the one-time `state`, trades the code for tokens and keeps the refresh token. */
  async completeConnect(code: string, state: string): Promise<{ email: string | null }> {
    this.prunePending();
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p) throw new OAuthStateError('This sign-in link expired. Start again from Settings.');
    const cfg = this.getConfig();
    const clientSecret = this.d.config.getSecret(CLIENT_SECRET);
    if (!cfg.clientId || !clientSecret) throw new OAuthStateError('The OAuth client was removed.');
    const t = await exchangeCode(
      this.d.http,
      {
        clientId: cfg.clientId,
        clientSecret,
        code,
        verifier: p.verifier,
        redirectUri: this.d.redirectUri,
      },
      this.now(),
    );
    if (!t.refreshToken) {
      throw new GoogleError('Google did not hand out offline access. Try connecting again.');
    }
    this.d.config.setSecret(REFRESH_TOKEN, t.refreshToken);
    this.d.config.setState(ACCOUNT, t.email ? { email: t.email } : undefined);
    this.access = { token: t.accessToken, expiresAt: t.expiresAt };
    this.lastError = null;
    this.d.log.info('google calendar connected');
    await this.refresh();
    return { email: t.email ?? null };
  }

  async disconnect(): Promise<CalendarStatus> {
    const token = this.d.config.getSecret(REFRESH_TOKEN);
    this.d.config.setSecret(REFRESH_TOKEN, null);
    this.d.config.setState(ACCOUNT, undefined);
    this.access = undefined;
    this.meetings = [];
    this.lastSyncAt = null;
    this.lastError = null;
    clearTimeout(this.startTimer);
    if (token) await revoke(this.d.http, token);
    this.changed();
    return this.status();
  }

  private prunePending(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (t - v.at > OAUTH_TTL_MS) this.pending.delete(k);
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > this.now()) return this.access.token;
    const refreshToken = this.d.config.getSecret(REFRESH_TOKEN);
    const clientSecret = this.d.config.getSecret(CLIENT_SECRET);
    const { clientId } = this.getConfig();
    if (!refreshToken || !clientSecret || !clientId) throw new GoogleError('Not connected.');
    try {
      const t = await refreshAccess(
        this.d.http,
        { clientId, clientSecret, refreshToken },
        this.now(),
      );
      this.access = { token: t.accessToken, expiresAt: t.expiresAt };
      return t.accessToken;
    } catch (e) {
      // Revoked at Google (or the client was deleted there): forget the token so the card says "Connect".
      if (e instanceof GoogleError && e.revoked) {
        this.d.config.setSecret(REFRESH_TOKEN, null);
        this.d.config.setState(ACCOUNT, undefined);
      }
      throw e;
    }
  }

  // ───────────────────────────── meetings ─────────────────────────────

  /** Re-reads the calendar(s) now. One read at a time; a second call waits for the one in flight. */
  refresh(): Promise<void> {
    this.inFlight ??= this.read().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async read(): Promise<void> {
    if (!this.enabled() || !this.connected()) {
      if (this.meetings.length > 0) {
        this.meetings = [];
        this.changed();
      }
      return;
    }
    const t = this.now();
    try {
      const token = await this.accessToken();
      const cfg = this.getConfig();
      const lists = await Promise.all(
        cfg.calendarIds.map((calendarId) =>
          listMeetings(this.d.http, {
            accessToken: token,
            calendarId,
            from: t - LOOK_BACK_MS,
            to: t + LOOK_AHEAD_MS,
          }),
        ),
      );
      const next = lists.flat().sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      const moved = JSON.stringify(next) !== JSON.stringify(this.meetings);
      const hadError = this.lastError !== null;
      this.meetings = next;
      this.lastSyncAt = t;
      this.lastError = null;
      if (moved || hadError) this.changed();
    } catch (e) {
      // An expired access token is retried once with a fresh one on the next tick.
      if (e instanceof GoogleError && e.message === 'Google sign-in expired.')
        this.access = undefined;
      const msg = e instanceof GoogleError ? e.message : 'Google Calendar could not be reached.';
      if (msg !== this.lastError) {
        this.lastError = msg;
        this.changed();
      }
      this.d.log.warn({ err: (e as Error).name }, 'calendar read failed');
    }
    this.notifyStarted();
    this.scheduleNextStart();
  }

  private dismissedMap(): Record<string, number> {
    return this.d.config.getState<Record<string, number>>(DISMISSED) ?? {};
  }

  list(): MeetingList {
    const t = this.now();
    const dismissed = this.dismissedMap();
    const on = this.enabled() && this.connected();
    return {
      meetings: on
        ? this.meetings
            .filter((m) => m.end > t)
            .map((m) => ({ ...m, dismissed: dismissed[m.id] !== undefined }))
        : [],
      connected: this.connected(),
      leadSeconds: this.getConfig().leadSeconds,
      now: t,
    };
  }

  /** Hides a meeting from the alert (Join counts as dismissing it). Kept until the meeting is over. */
  dismiss(id: string, dismissed = true): MeetingList {
    const t = this.now();
    const m = this.meetings.find((x) => x.id === id);
    const map = Object.fromEntries(
      Object.entries(this.dismissedMap()).filter(([, end]) => end > t),
    );
    if (dismissed && m) map[id] = m.end;
    if (!dismissed) delete map[id];
    this.d.config.setState(DISMISSED, map);
    this.changed();
    return this.list();
  }

  // ───────────────────────────── start notifications ─────────────────────────────

  private notifyStarted(): void {
    if (!this.d.notifier || !this.enabled()) return;
    const t = this.now();
    const dismissed = this.dismissedMap();
    for (const m of this.meetings) {
      if (m.start > t || m.end <= t || t - m.start > NOTIFY_GRACE_MS) continue;
      const key = `meeting:${m.id}:${m.start}`;
      if (dismissed[m.id] !== undefined || this.notified.has(key)) continue;
      this.notified.add(key);
      this.d.notifier.notifyCockpit({
        event: 'meetingStarted',
        key,
        ttlMs: Math.max(60_000, m.end - t),
        title: `Meeting now: ${m.title}`,
        body: m.joinUrl
          ? 'It has started. Open Relay to join from the alert.'
          : 'It has started. Open Relay to see it.',
        url: '/',
        tag: `meeting-${m.start}`,
        repoId: null,
        subject: null,
      });
    }
    if (this.notified.size > 500) this.notified.clear();
  }

  /** The poll runs once a minute; a timer at the next start makes the push (and the alert) arrive on the second. */
  private scheduleNextStart(): void {
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
    if (this.stopped) return;
    const t = this.now();
    const next = this.meetings.find((m) => m.start > t);
    if (!next || next.start - t > CALENDAR_POLL_MS * 2) return;
    this.startTimer = setTimeout(
      () => {
        this.startTimer = undefined;
        this.notifyStarted();
        this.changed();
        this.scheduleNextStart();
      },
      next.start - t + 250,
    );
  }

  private changed(): void {
    this.d.bus.emit({ type: 'calendar.changed' });
  }
}
