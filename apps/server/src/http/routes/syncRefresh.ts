import type { FastifyInstance } from 'fastify';

export interface SyncRefreshRouteDeps {
  /** `SyncEngine.refreshNow`: its overlap guard coalesces a request that arrives during a run. */
  refresh: () => Promise<unknown>;
  now?: () => number;
}

/** Holding or tapping `r` must not turn into a stream of GitLab and Notion calls. */
const MIN_INTERVAL_MS = 5_000;

/**
 * `POST /api/sync/refresh`: starts a sync without waiting for it; results arrive over SSE. Reads GitLab and Notion
 * into the local cache, and writes nothing to either.
 */
export function registerSyncRefreshRoute(
  app: FastifyInstance,
  { refresh, now }: SyncRefreshRouteDeps,
): void {
  const clock = now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  app.post('/api/sync/refresh', async (_req, reply) => {
    const at = clock();
    if (at - last < MIN_INTERVAL_MS) return reply.code(202).send({ started: false });
    last = at;
    void refresh().catch(() => undefined);
    return reply.code(202).send({ started: true });
  });
}
