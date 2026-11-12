import { z } from 'zod';
import { EpochMsSchema, RepoIdSchema } from './common';
import { WebhookEventStatusSchema } from './events';

/**
 * `GET /api/events` wire protocol.
 *
 *  - AppEvents (see `events.ts`) are sent as the DEFAULT `message` event: `id: <bootId>.<seq>` + JSON `data`.
 *  - Control frames use named events and carry NO `id` (they never move Last-Event-ID):
 *      `hello`   first frame of every connection
 *      `ping`    heartbeat (`{type:'ping', at}`), so the browser can detect a dead connection
 *      `resync`  the server could not replay what the client missed: refetch everything
 *  - Resume: the browser's automatic reconnect sends `Last-Event-ID`; a manual reconnect may pass
 *    `?lastEventId=` instead (EventSource cannot set headers).
 */

export const SSE_EVENTS_PATH = '/api/events';
export const SSE_HEARTBEAT_MS = 15_000;
/** The client treats the connection as dead after this long without ANY frame (3 missed heartbeats). */
export const SSE_STALE_AFTER_MS = 45_000;

export const SSE_FRAME_HELLO = 'hello';
export const SSE_FRAME_PING = 'ping';
export const SSE_FRAME_RESYNC = 'resync';

export const SseHelloSchema = z.object({
  /** Random per server process; ids from another boot can never be replayed. */
  bootId: z.string().min(1),
  at: EpochMsSchema,
  heartbeatMs: z.number().int().positive(),
  /** The client sent a Last-Event-ID from THIS boot and replay was possible. */
  resumed: z.boolean(),
  /** How many buffered events were replayed right after this frame. */
  replayed: z.number().int().nonnegative(),
});
export type SseHello = z.infer<typeof SseHelloSchema>;

export const SSE_RESYNC_REASONS = ['gap', 'restart'] as const;
export const SseResyncSchema = z.object({
  reason: z.enum(SSE_RESYNC_REASONS),
  at: EpochMsSchema,
});
export type SseResync = z.infer<typeof SseResyncSchema>;

/** Webhook health panel (last received per repo). `GET /api/webhooks/health`. */
export const WebhookHealthRepoSchema = z.object({
  repoId: RepoIdSchema,
  name: z.string(),
  /** Newest stored delivery for this repo (any status). */
  lastEvent: z
    .object({
      receivedAt: EpochMsSchema,
      objectKind: z.string().nullable(),
      action: z.string().nullable(),
      status: WebhookEventStatusSchema,
      /** Short, payload-free failure reason (`failed` deliveries only). */
      error: z.string().nullable(),
    })
    .nullable(),
  /** Newest delivery that was processed successfully. */
  lastProcessedAt: EpochMsSchema.nullable(),
  /** Newest delivery that failed. */
  lastFailedAt: EpochMsSchema.nullable(),
  /** Deliveries stored in the last 24 h, by status. */
  last24h: z.object({
    total: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type WebhookHealthRepo = z.infer<typeof WebhookHealthRepoSchema>;

export const WebhookHealthSchema = z.object({
  generatedAt: EpochMsSchema,
  /** `<publicBaseUrl>` is usable for registering hooks (https). `null` = ok. */
  publicUrlProblem: z.enum(['public_url_missing', 'public_url_not_https']).nullable(),
  /** ngrok reachability is NOT probed by the server (nothing outbound to ngrok); always `false`. */
  reachabilityChecked: z.literal(false),
  repos: z.array(WebhookHealthRepoSchema),
});
export type WebhookHealth = z.infer<typeof WebhookHealthSchema>;
