import type { FastifyInstance } from 'fastify';
import { HealthFindingRefSchema, HealthRangeQuerySchema } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { dismissFinding, restoreFinding } from '../../services/healthDismissals';
import { buildHealthReport } from '../../services/healthReport';
import { parseWith } from '../errors';

export interface SyncHealthRouteDeps {
  store: ConfigStore;
  /** Local cache DB. */
  cache: AppDb;
  now?: () => number;
}

/**
 * `GET /api/sync/health?from=YYYY-MM-DD&to=YYYY-MM-DD` — Sync Health verdicts (Notion status and GitLab
 * state side by side), family trees, MR timing and the review-latency stat. Read-only: computed from the local
 * cache, never triggers a sync, never applies a fix (fixes are suggestions; executing one is a separate, confirmed action).
 * `from` / `to` limit the findings to a period; both optional.
 *
 * `POST /api/sync/health/false-positives` / `DELETE` (same body): mark a finding as a false positive or restore it.
 * Local only: nothing is written to Notion or GitLab.
 */
export function registerSyncHealthRoutes(app: FastifyInstance, deps: SyncHealthRouteDeps): void {
  const now = deps.now ?? Date.now;
  app.get('/api/sync/health', async (req) => {
    const range = parseWith(HealthRangeQuerySchema, req.query ?? {});
    return buildHealthReport(
      deps.cache,
      deps.store.listReposFull(),
      deps.store.getGlobal(),
      now(),
      deps.store.myUsernames(),
      range,
    );
  });
  app.post('/api/sync/health/false-positives', async (req) => {
    dismissFinding(deps.cache, parseWith(HealthFindingRefSchema, req.body), now());
    return { ok: true };
  });
  app.delete('/api/sync/health/false-positives', async (req) => {
    restoreFinding(deps.cache, parseWith(HealthFindingRefSchema, req.body));
    return { ok: true };
  });
}
