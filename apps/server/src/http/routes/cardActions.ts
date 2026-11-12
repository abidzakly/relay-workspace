import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BulkReadyPreviewRequestSchema,
  BulkReadyRequestSchema,
  CardStatusPreviewRequestSchema,
  CardStatusRequestSchema,
  NotionIdSchema,
  SyncFixPreviewRequestSchema,
  SyncFixRequestSchema,
} from '@relay/shared';
import type { CardActions } from '../../services/cardActions';
import { parseWith, wrapAction as wrap } from '../errors';

const CardParamsSchema = z.object({ id: NotionIdSchema });

/**
 * Card status changes and one-click Fixes. Private listener only; CSRF header + Host/Origin apply.
 * Every write is two calls (the confirm dialog sits in between): the `preview` call writes nothing and issues a
 * single-use `confirmToken`; the write call is refused without it (409 `confirmation_required`).
 *  - POST  /api/cards/:id/status/preview  { status }
 *  - PATCH /api/cards/:id/status          { status, confirmToken }
 *  - POST  /api/cards/bulk-ready/preview  { cardIds }
 *  - POST  /api/cards/bulk-ready          { cardIds, includeWarned?, confirmToken }
 *  - POST  /api/sync/fix/preview          { ruleId, target, fixIndex? }
 *  - POST  /api/sync/fix                  { ruleId, target, fixIndex?, confirmToken }
 */
export function registerCardActionRoutes(
  app: FastifyInstance,
  deps: { actions: CardActions },
): void {
  app.post('/api/cards/:id/status/preview', async (req) => {
    const { id } = parseWith(CardParamsSchema, req.params);
    const body = parseWith(CardStatusPreviewRequestSchema, req.body);
    return wrap(() => deps.actions.previewStatus(id, body.status));
  });

  app.patch('/api/cards/:id/status', async (req) => {
    const { id } = parseWith(CardParamsSchema, req.params);
    const body = parseWith(CardStatusRequestSchema, req.body);
    return wrap(() => deps.actions.setStatus(id, body));
  });

  app.post('/api/cards/bulk-ready/preview', async (req) => {
    const body = parseWith(BulkReadyPreviewRequestSchema, req.body);
    return wrap(() => deps.actions.previewBulkReady(body));
  });

  app.post('/api/cards/bulk-ready', async (req) => {
    const body = parseWith(BulkReadyRequestSchema, req.body);
    return wrap(() => deps.actions.bulkReady(body));
  });

  app.post('/api/sync/fix/preview', async (req) => {
    const body = parseWith(SyncFixPreviewRequestSchema, req.body);
    return wrap(() => deps.actions.previewFix(body));
  });

  app.post('/api/sync/fix', async (req) => {
    const body = parseWith(SyncFixRequestSchema, req.body);
    return wrap(() => deps.actions.applyFix(body));
  });
}
