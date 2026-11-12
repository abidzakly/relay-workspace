import type { FastifyInstance } from 'fastify';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { buildSprints } from '../../services/sprintModel';

export interface SprintRouteDeps {
  store: ConfigStore;
  cache: AppDb;
  now?: () => number;
}

/** `GET /api/sprints` — Sprint Harbor: my sprints (connected projects only) with MRs and sub-tasks. Read-only. */
export function registerSprintRoutes(app: FastifyInstance, deps: SprintRouteDeps): void {
  const now = deps.now ?? Date.now;
  app.get('/api/sprints', async () =>
    buildSprints(deps.cache, deps.store.listRepos(), deps.store.getGlobalStored(), now()),
  );
}
