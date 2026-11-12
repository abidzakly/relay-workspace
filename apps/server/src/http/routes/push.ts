import type { FastifyInstance } from 'fastify';
import {
  PushSubscribeBodySchema,
  PushUnsubscribeBodySchema,
  type PushStatus,
  type PushTestResult,
} from '@relay/shared';
import type { Notifier } from '../../services/notifier';
import type { PushService } from '../../services/pushService';
import { HttpError, parseWith } from '../errors';

export interface PushRouteDeps {
  push: PushService;
  notifier: Pick<Notifier, 'sendTest'>;
}

/**
 * Web Push endpoints (`POST /api/push/subscribe | /test`). All of them sit behind the dashboard's
 * Host allowlist and CSRF header. A subscription is a browser-held capability: it is stored, never returned,
 * never logged beyond its host. Not external writes to GitLab/Notion, so dry-run does not apply; a test
 * push really is sent.
 */
export function registerPushRoutes(app: FastifyInstance, { push, notifier }: PushRouteDeps): void {
  app.get('/api/push/status', async (): Promise<PushStatus> => push.status());

  app.post('/api/push/subscribe', async (req) => {
    if (!push.isConfigured()) {
      throw new HttpError(409, 'push_not_configured', 'VAPID keys are not set (pnpm push:keys)');
    }
    const sub = parseWith(PushSubscribeBodySchema, req.body);
    const ua = req.headers['user-agent'];
    const { created } = push.subscribe(sub, typeof ua === 'string' ? ua : null);
    return { ok: true, created, subscriptions: push.subscriptionCount() };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = parseWith(PushUnsubscribeBodySchema, req.body);
    const removed = push.unsubscribe(endpoint);
    return { ok: true, removed, subscriptions: push.subscriptionCount() };
  });

  app.post('/api/push/test', async (): Promise<PushTestResult> => {
    if (!push.isConfigured()) {
      throw new HttpError(409, 'push_not_configured', 'VAPID keys are not set (pnpm push:keys)');
    }
    if (push.subscriptionCount() === 0) {
      throw new HttpError(409, 'no_subscriptions', 'No browser is subscribed yet');
    }
    return { channels: await notifier.sendTest() };
  });
}
