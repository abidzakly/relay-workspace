import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ReviewMarkRequestSchema,
  ReviewSnoozeRequestSchema,
  ReviewTokenRequestSchema,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import { TokenCheckError, type ReviewDeskService } from '../../services/reviewDesk';
import { HttpError, parseWith } from '../errors';

const KeyParams = z.object({ key: z.string().regex(/^[1-9]\d{0,11}![1-9]\d{0,9}$/) });
const TodoParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Reviews (private listener; CSRF + Host checks apply to every write):
 *  GET  /api/reviews                      the desk
 *  POST /api/reviews/refresh              re-read GitLab now
 *  GET  /api/reviews/token                token status (never the token)
 *  PUT  /api/reviews/token   { token }    check with GitLab, then save; `null` clears
 *  POST /api/reviews/webhook-secret       the Reviews webhook secret, created on first use (to paste into GitLab)
 *  POST /api/reviews/:key/mark   { sha }  local: "reviewed up to this commit"
 *  POST /api/reviews/:key/snooze { until } local
 *  POST /api/reviews/todos/:id/done       GitLab write (dry-run + audit)
 */
export function registerReviewsRoutes(
  app: FastifyInstance,
  deps: { desk: ReviewDeskService; audit: AuditWriter },
): void {
  const { desk } = deps;

  app.get('/api/reviews', async () => desk.view());

  app.post('/api/reviews/refresh', async () => {
    await desk.refresh();
    return desk.view();
  });

  app.get('/api/reviews/token', async () => desk.tokenStatus());

  app.put('/api/reviews/token', async (req) => {
    const { token } = parseWith(ReviewTokenRequestSchema, req.body);
    try {
      const status = await desk.saveToken(token === null ? null : token.trim());
      deps.audit.write({
        actor: 'user',
        action: token === null ? 'reviews.tokenCleared' : 'reviews.tokenSaved',
        targetType: 'settings',
        targetId: 'reviews',
        before: null,
        after: { username: status.username, scopes: status.scopes },
      });
      return status;
    } catch (e) {
      if (e instanceof TokenCheckError) throw new HttpError(422, 'token_check_failed', e.message);
      throw e;
    }
  });

  app.post('/api/reviews/webhook-secret', async () => {
    const secret = desk.webhookSecret();
    deps.audit.write({
      actor: 'user',
      action: 'reviews.webhookSecretShown',
      targetType: 'settings',
      targetId: 'reviews',
      before: null,
      after: null,
    });
    return { secret, url: desk.view().webhook.url };
  });

  app.post('/api/reviews/:key/mark', async (req) => {
    const { key } = parseWith(KeyParams, req.params);
    const { sha } = parseWith(ReviewMarkRequestSchema, req.body);
    desk.mark(key, sha);
    return desk.view();
  });

  app.post('/api/reviews/:key/snooze', async (req) => {
    const { key } = parseWith(KeyParams, req.params);
    const { until } = parseWith(ReviewSnoozeRequestSchema, req.body);
    desk.snooze(key, until);
    return desk.view();
  });

  app.post('/api/reviews/todos/:id/done', async (req) => {
    const { id } = parseWith(TodoParams, req.params);
    try {
      return await desk.todoDone(id);
    } catch (e) {
      if (e instanceof Error && e.message === 'reviewer_token_missing')
        throw new HttpError(409, 'reviewer_token_missing', 'Save a personal GitLab token first.');
      throw new HttpError(502, 'gitlab_write_failed', 'GitLab did not mark the to-do as done.');
    }
  });
}
