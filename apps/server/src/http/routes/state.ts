import type { FastifyInstance } from 'fastify';
import type { SyncStatus } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { buildStateSnapshot, NO_SYNC_STATUS } from '../../services/stateSnapshot';

export interface StateRouteDeps {
  store: ConfigStore;
  /** Local cache DB. */
  cache: AppDb;
  /** Live sync status (the poller); defaults to "never synced". */
  getSyncStatus?: () => SyncStatus;
  now?: () => number;
}

/** `GET /api/state` — read-only snapshot of the local cache. Never triggers a sync. */
export function registerStateRoutes(app: FastifyInstance, deps: StateRouteDeps): void {
  const now = deps.now ?? Date.now;
  app.get('/api/state', async () =>
    buildStateSnapshot(
      deps.cache,
      deps.store.listReposFull(),
      (deps.getSyncStatus ?? NO_SYNC_STATUS)(),
      now(),
      deps.store.getGlobal(),
    ),
  );
}
