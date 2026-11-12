import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors';
import { WebhookError, type WebhookRegistry } from '../../services/webhookRegistry';

export interface WebhookRouteDeps {
  webhooks: WebhookRegistry;
}

const IdParams = z.object({ id: z.string().min(1).max(64) });
const HookParams = z.object({
  id: z.string().min(1).max(64),
  hookId: z.coerce.number().int().positive(),
});
/** The body is optional (the Settings button sends none). Unknown keys are rejected. */
const RegisterBody = z.strictObject({ force: z.boolean().optional() }).optional();

/** Input problems from the registry become clean 4xx; GitLab failures never reach here as throws. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WebhookError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
}

/**
 * Webhook management on the PRIVATE listener (CSRF header + Host allowlist apply to the writes).
 *  GET    /api/repos/:id/webhook              hooks on the project + verdict + last delivery (read only)
 *  POST   /api/repos/:id/webhook/register     create or fix this repo's hook (dry-run applies; audited)
 *  DELETE /api/repos/:id/webhook/:hookId      delete one of OUR hooks (dry-run applies; audited)
 *  POST   /api/webhooks/register-all          "Re-register all" after an ngrok URL change
 */
export function registerWebhookRoutes(app: FastifyInstance, { webhooks }: WebhookRouteDeps): void {
  app.get('/api/repos/:id/webhook', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return { webhook: await mapped(() => webhooks.status(id)) };
  });

  app.post('/api/repos/:id/webhook/register', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    const body = parseWith(RegisterBody, req.body) ?? {};
    const result = await mapped(() =>
      webhooks.register(id, body.force !== undefined ? { force: body.force } : {}),
    );
    return { result };
  });

  app.delete('/api/repos/:id/webhook/:hookId', async (req) => {
    const { id, hookId } = parseWith(HookParams, req.params);
    return mapped(() => webhooks.remove(id, hookId));
  });

  app.post('/api/webhooks/register-all', async (req) => {
    const body = parseWith(RegisterBody, req.body) ?? {};
    return mapped(() =>
      webhooks.registerAll(body.force !== undefined ? { force: body.force } : {}),
    );
  });
}
