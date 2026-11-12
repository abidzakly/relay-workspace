import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RepoIdSchema } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { buildPendingReleases } from '../../services/releaseCheck';
import { HttpError, parseWith } from '../errors';

export interface ReleaseRouteDeps {
  store: ConfigStore;
  /** Local cache DB. */
  cache: AppDb;
  now?: () => number;
}

const ParamsSchema = z.object({ repo: RepoIdSchema });

/**
 * `GET /api/release/:repo` — pending-release detection. Read-only: it answers from the cache and the
 * last release check, which every GitLab sync re-runs. The version preview needs a live read: `routes/releaseJobs.ts`.
 */
export function registerReleaseRoutes(app: FastifyInstance, deps: ReleaseRouteDeps): void {
  const now = deps.now ?? Date.now;
  app.get('/api/release/:repo', async (req) => {
    const { repo: repoId } = parseWith(ParamsSchema, req.params);
    const repo = deps.store.listReposFull().find((r) => r.id === repoId);
    if (!repo) throw new HttpError(404, 'repo_not_found', 'Unknown repository');
    const [release] = buildPendingReleases(deps.cache, [repo], deps.store.getGlobal(), now());
    return release;
  });
}
