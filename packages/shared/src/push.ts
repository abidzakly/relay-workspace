import { z } from 'zod';
import { EpochMsSchema, RepoIdSchema } from './common';
import { NotificationEventSchema } from './config';

/**
 * Web Push + notification channels. Shapes the dashboard API and the service worker
 * (`apps/web/public/sw.js`, plain JS, no imports) agree on. Nothing here carries a secret: the VAPID
 * PRIVATE key never leaves the server, the subscription endpoint/keys are only ever accepted, never returned.
 */

/** Bump when the payload shape changes incompatibly. */
export const PUSH_PAYLOAD_VERSION = 1;

/** A path inside the dashboard (`/mrs/app-a/12`). The service worker only ever navigates to these. */
export function isSafeAppPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (!p.startsWith('/') || p.startsWith('//')) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c) return false;
  }
  return true;
}

export const PushPayloadSchema = z.object({
  v: z.literal(PUSH_PAYLOAD_VERSION),
  /** `test` is the manual "Send test notification" (never produced by a rule). */
  event: z.union([NotificationEventSchema, z.literal('test')]),
  title: z.string().min(1).max(120),
  body: z.string().max(240),
  /** Notifications with the same tag replace each other in the OS tray. */
  tag: z.string().min(1).max(100),
  /** Where a click goes (a dashboard path). */
  url: z.string().refine(isSafeAppPath, 'url must be a dashboard path'),
  at: EpochMsSchema,
  repoId: RepoIdSchema.nullable(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Hosts a push endpoint may never point at (the server POSTs to it). Real push services use public DNS names. */
function isForbiddenEndpointHost(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return true;
  }
  if (h.startsWith('[')) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4 literal
  return !h.includes('.');
}

export const PushEndpointSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((u) => {
    try {
      return !isForbiddenEndpointHost(new URL(u).hostname);
    } catch {
      return false;
    }
  }, 'endpoint host is not allowed');

/** `PushSubscription.toJSON()` as the browser produces it (`expirationTime` is accepted and ignored). */
export const PushSubscribeBodySchema = z.object({
  endpoint: PushEndpointSchema,
  keys: z.object({
    p256dh: z.string().regex(B64URL).min(80).max(100),
    auth: z.string().regex(B64URL).min(16).max(32),
  }),
  expirationTime: z.number().nullable().optional(),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBodySchema>;

export const PushUnsubscribeBodySchema = z.object({ endpoint: PushEndpointSchema });
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBodySchema>;

export const PUSH_PROBLEMS = ['vapid_missing', 'vapid_invalid'] as const;
export const PushProblemSchema = z.enum(PUSH_PROBLEMS);
export type PushProblem = z.infer<typeof PushProblemSchema>;

/** `GET /api/push/status`. `publicKey` is the VAPID PUBLIC key (the browser needs it to subscribe). */
export const PushStatusSchema = z.object({
  /** Web Push can send: a valid VAPID key pair + subject are set in `.env`. */
  configured: z.boolean(),
  problem: PushProblemSchema.nullable(),
  publicKey: z.string().nullable(),
  /** Stored browser subscriptions (endpoints are never returned). */
  subscriptions: z.number().int().nonnegative(),
  /** Every delivery channel the server knows (web push, optional ntfy fallback). */
  channels: z.array(z.object({ name: z.string(), configured: z.boolean() })),
});
export type PushStatus = z.infer<typeof PushStatusSchema>;

export const ChannelResultSchema = z.object({
  attempted: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  /** Subscriptions the push service reported gone (404/410) and we deleted. */
  removed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type ChannelResult = z.infer<typeof ChannelResultSchema>;

/** `POST /api/push/test`. */
export const PushTestResultSchema = z.object({
  channels: z.array(ChannelResultSchema.extend({ name: z.string() })),
});
export type PushTestResult = z.infer<typeof PushTestResultSchema>;
