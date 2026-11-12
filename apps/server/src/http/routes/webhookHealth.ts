import type { FastifyInstance } from 'fastify';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import type { HttpClient } from '../../services/httpClient';
import { buildWebhookHealth, checkPublicUrl } from '../../services/webhookHealth';

export interface WebhookHealthRouteDeps {
  store: ConfigStore;
  cache: AppDb;
  http: HttpClient;
  now?: () => number;
}

/**
 * `GET /api/webhooks/health`: last delivery per repo. Local DB only, read-only.
 * `POST /api/webhooks/check-public-url`: one outbound request to the configured public URL. Only the panel's button
 * calls it; nothing on the server does, and no timer or query is attached to it.
 */
export function registerWebhookHealthRoutes(
  app: FastifyInstance,
  { store, cache, http, now }: WebhookHealthRouteDeps,
): void {
  const clock = now ?? Date.now;
  app.get('/api/webhooks/health', async () => buildWebhookHealth(store, cache, clock()));
  app.post('/api/webhooks/check-public-url', async () =>
    checkPublicUrl(store.getGlobal().publicBaseUrl, http, clock()),
  );
}
