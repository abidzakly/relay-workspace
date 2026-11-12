import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NotificationListQuerySchema,
  NotificationSummaryQuerySchema,
  type NotificationList,
  type NotificationSummary,
  type NotificationUnread,
} from '@relay/shared';
import type { NotificationCenter } from '../../services/notificationCenter';
import { HttpError, parseWith } from '../errors';

const ParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/** The notification center: the sent notifications with their current actions, and their read state (local only). */
export function registerNotificationRoutes(
  app: FastifyInstance,
  { center }: { center: NotificationCenter },
): void {
  app.get('/api/notifications', async (req): Promise<NotificationList> =>
    center.list(parseWith(NotificationListQuerySchema, req.query)),
  );

  app.get('/api/notifications/unread-count', async (): Promise<NotificationUnread> => ({
    unread: center.unreadCount(),
    needsAction: await center.unreadNeedsAction(),
  }));

  app.get('/api/notifications/summary', async (req): Promise<NotificationSummary> =>
    center.summary(parseWith(NotificationSummaryQuerySchema, req.query).repoId),
  );

  app.post('/api/notifications/dismiss-handled', async (req) => ({
    ok: true,
    marked: await center.dismissHandled(
      parseWith(NotificationSummaryQuerySchema, req.body ?? {}).repoId,
    ),
  }));

  app.post('/api/notifications/read-all', async () => ({ ok: true, marked: center.markAllRead() }));

  app.post('/api/notifications/:id/read', async (req) => {
    const { id } = parseWith(ParamsSchema, req.params);
    if (!center.markRead(id)) throw new HttpError(404, 'not_found', 'Unknown notification');
    return { ok: true };
  });
}
