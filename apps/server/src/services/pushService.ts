import { asc, count, eq } from 'drizzle-orm';
import type {
  ChannelResult,
  PushPayload,
  PushProblem,
  PushStatus,
  PushSubscribeBody,
} from '@relay/shared';
import type { AppDb } from '../db';
import { pushSubs } from '../db/schema';
import type { Logger } from '../util/logger';
import type { NotificationChannel } from './notificationChannel';
import { sendNotification } from './webPushLib';

/**
 * Web Push. VAPID keys come from `.env` (never from the API, never logged); subscriptions live in
 * `push_subs`. Sending is fire-and-count: a failing subscription never throws into the caller.
 *  - 404 / 410 from the push service = the subscription is gone for good -> the row is deleted.
 *  - any other failure (5xx, network, 429...) keeps the row; the next event tries again.
 * The endpoint URL is a capability, so it is never returned by the API and only its HOST is ever logged.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type VapidResolution =
  { ok: true; vapid: VapidConfig } | { ok: false; problem: PushProblem };

const b64urlBytes = (s: string): Buffer | null =>
  /^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url') : null;

/** Pure: is the env's VAPID triple usable? (`mailto:`/https subject, 65-byte uncompressed P-256 public key, 32-byte private key.) */
export function resolveVapid(env: {
  VAPID_PUBLIC_KEY?: string | undefined;
  VAPID_PRIVATE_KEY?: string | undefined;
  VAPID_SUBJECT?: string | undefined;
}): VapidResolution {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = env;
  if (!pub || !priv || !subject) return { ok: false, problem: 'vapid_missing' };
  const pubBytes = b64urlBytes(pub);
  const privBytes = b64urlBytes(priv);
  const subjectOk = /^mailto:[^\s@]+@[^\s@]+$/.test(subject) || /^https:\/\/\S+$/.test(subject);
  if (
    !pubBytes ||
    pubBytes.length !== 65 ||
    pubBytes[0] !== 0x04 ||
    !privBytes ||
    privBytes.length !== 32 ||
    !subjectOk
  ) {
    return { ok: false, problem: 'vapid_invalid' };
  }
  return { ok: true, vapid: { publicKey: pub, privateKey: priv, subject } };
}

/** What one send needs from the web-push library (injectable so the transport can be swapped). */
export type WebPushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  vapid: VapidConfig,
) => Promise<{ statusCode: number }>;

/** How long a push service may hold a message for an offline browser ("arrive on next launch"). */
const PUSH_TTL_SECONDS = 24 * 3600;
const SEND_TIMEOUT_MS = 10_000;
/** Hard cap on stored subscriptions (one person, a few browsers); the oldest are dropped beyond it. */
export const MAX_SUBSCRIPTIONS = 10;

const defaultSend: WebPushSend = async (sub, body, vapid) => {
  const res = await sendNotification(sub, body, {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    TTL: PUSH_TTL_SECONDS,
    urgency: 'normal',
    timeout: SEND_TIMEOUT_MS,
  });
  return { statusCode: res.statusCode };
};

export interface PushServiceDeps {
  store: AppDb;
  log: Logger;
  vapid: VapidResolution;
  /** Names of the other channels, for the status endpoint only. */
  otherChannels?: () => { name: string; configured: boolean }[];
  send?: WebPushSend;
  now?: () => number;
}

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
};

export class PushService implements NotificationChannel {
  readonly name = 'webpush';
  private readonly send: WebPushSend;
  private readonly now: () => number;

  constructor(private readonly d: PushServiceDeps) {
    this.send = d.send ?? defaultSend;
    this.now = d.now ?? Date.now;
    if (!d.vapid.ok) {
      d.log.warn(
        { problem: d.vapid.problem },
        'web push disabled: set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (pnpm push:keys)',
      );
    }
  }

  isConfigured(): boolean {
    return this.d.vapid.ok;
  }

  /** The VAPID PUBLIC key (safe to give the browser), or null while push is not configured. */
  publicKey(): string | null {
    return this.d.vapid.ok ? this.d.vapid.vapid.publicKey : null;
  }

  subscriptionCount(): number {
    return this.d.store.db.select({ n: count() }).from(pushSubs).get()?.n ?? 0;
  }

  status(): PushStatus {
    return {
      configured: this.d.vapid.ok,
      problem: this.d.vapid.ok ? null : this.d.vapid.problem,
      publicKey: this.publicKey(),
      subscriptions: this.subscriptionCount(),
      channels: [
        { name: this.name, configured: this.isConfigured() },
        ...(this.d.otherChannels?.() ?? []),
      ],
    };
  }

  /** Idempotent: the same endpoint updates its keys instead of adding a row. Returns whether a row was created. */
  subscribe(sub: PushSubscribeBody, userAgent: string | null): { created: boolean } {
    const now = this.now();
    const ua = userAgent ? userAgent.slice(0, 200) : null;
    const created = this.d.store.db.transaction((tx) => {
      const existing = tx
        .select({ id: pushSubs.id })
        .from(pushSubs)
        .where(eq(pushSubs.endpoint, sub.endpoint))
        .get();
      if (existing) {
        tx.update(pushSubs)
          .set({ p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: ua })
          .where(eq(pushSubs.id, existing.id))
          .run();
        return false;
      }
      tx.insert(pushSubs)
        .values({
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          userAgent: ua,
          createdAt: now,
        })
        .run();
      const all = tx
        .select({ id: pushSubs.id })
        .from(pushSubs)
        .orderBy(asc(pushSubs.createdAt), asc(pushSubs.id))
        .all();
      for (const old of all.slice(0, Math.max(0, all.length - MAX_SUBSCRIPTIONS))) {
        tx.delete(pushSubs).where(eq(pushSubs.id, old.id)).run();
      }
      return true;
    });
    this.d.log.info({ host: hostOf(sub.endpoint), created }, 'push subscription stored');
    return { created };
  }

  unsubscribe(endpoint: string): boolean {
    const res = this.d.store.db.delete(pushSubs).where(eq(pushSubs.endpoint, endpoint)).run();
    if (res.changes > 0) this.d.log.info({ host: hostOf(endpoint) }, 'push subscription removed');
    return res.changes > 0;
  }

  /** Sends to every stored subscription. Never throws. */
  async deliver(payload: PushPayload): Promise<ChannelResult> {
    const result: ChannelResult = { attempted: 0, sent: 0, removed: 0, failed: 0 };
    const vapid = this.d.vapid;
    if (!vapid.ok) return result;
    const rows = this.d.store.db.select().from(pushSubs).all();
    if (rows.length === 0) return result;
    const body = JSON.stringify(payload);

    await Promise.all(
      rows.map(async (row) => {
        result.attempted += 1;
        try {
          await this.send(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            body,
            vapid.vapid,
          );
          result.sent += 1;
          this.d.store.db
            .update(pushSubs)
            .set({ lastUsedAt: this.now() })
            .where(eq(pushSubs.id, row.id))
            .run();
        } catch (e) {
          const status = (e as { statusCode?: unknown }).statusCode;
          if (status === 404 || status === 410) {
            // Expired / unsubscribed in the browser: it will never work again.
            this.d.store.db.delete(pushSubs).where(eq(pushSubs.id, row.id)).run();
            result.removed += 1;
            this.d.log.info(
              { host: hostOf(row.endpoint), status },
              'push subscription expired, removed',
            );
          } else {
            result.failed += 1;
            // Status / error name only: the library's message and `endpoint` field are capability URLs.
            this.d.log.warn(
              {
                host: hostOf(row.endpoint),
                ...(typeof status === 'number' ? { status } : { err: (e as Error).name }),
              },
              'push delivery failed',
            );
          }
        }
      }),
    );
    return result;
  }
}
