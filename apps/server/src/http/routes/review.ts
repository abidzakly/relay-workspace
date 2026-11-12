import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BranchQuerySchema,
  CompareQuerySchema,
  RepoIdSchema,
  ReviewRepoIdSchema,
  extProjectId,
  type BranchList,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { GitlabApiError, GitlabService } from '../../services/gitlabService';
import type { HttpClient } from '../../services/httpClient';
import { filesReason } from '../../services/mrDetail';
import {
  buildCompareReview,
  buildExtMrReview,
  buildMrReview,
  type ReviewReader,
} from '../../services/review';
import { extRepoConfig, reviewerIdentity } from '../../services/reviewTarget';
import type { Logger } from '../../util/logger';
import { HttpError, parseWith } from '../errors';

export interface ReviewRouteDeps {
  store: ConfigStore;
  cache: AppDb;
  http: HttpClient;
  log: Logger;
  now?: () => number;
}

const MrParams = z.object({ repo: ReviewRepoIdSchema, iid: z.coerce.number().int().positive() });
const RepoParams = z.object({ repo: RepoIdSchema });
/** Compare also serves Reviews' "since you last looked" (`~<projectId>`, from/to = SHAs). */
const CompareParams = z.object({ repo: ReviewRepoIdSchema });

/** GitLab errors become a 502 with a plain reason (never token, headers or bodies). */
function upstream(e: unknown): never {
  if (e instanceof GitlabApiError) {
    const status = e.kind === 'not_found' ? 404 : e.kind === 'rate_limited' ? 429 : 502;
    throw new HttpError(status, `gitlab_${e.kind}`, filesReason(e));
  }
  throw e;
}

/**
 * Code Reviewer, READ-ONLY. GETs to GitLab only; nothing is cached or written.
 *  - GET /api/repos/:repo/branches?search=
 *  - GET /api/review/:repo/mr/:iid
 *  - GET /api/review/:repo/compare?from=&to=
 * The line-comment write lives with the other MR writes (`POST /api/mrs/:repo/:iid/comment`).
 */
export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const now = deps.now ?? Date.now;

  /** `~<projectId>` without a saved reviewer token: nothing can read it. */
  const known = (repoId: string) => {
    if (deps.store.getRepo(repoId)) return;
    if (extProjectId(repoId) === null)
      throw new HttpError(404, 'repo_not_found', 'Unknown repository');
    if (!extRepoConfig(deps.store, repoId))
      throw new HttpError(
        409,
        'reviewer_token_missing',
        'Save a personal GitLab token in Settings > Connections > Reviewer access first.',
      );
  };

  const reader = (repoId: string): ReturnType<typeof GitlabService.forRepo> => {
    known(repoId);
    try {
      return GitlabService.forRepo(deps.store, repoId, {
        http: deps.http,
        store: deps.cache,
        log: deps.log,
      });
    } catch {
      throw new HttpError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
  };

  app.get('/api/repos/:repo/branches', async (req): Promise<BranchList> => {
    const { repo } = parseWith(RepoParams, req.params);
    const { search } = parseWith(BranchQuerySchema, req.query);
    const live = reader(repo);
    try {
      return await live.listBranches(search?.trim() || undefined);
    } catch (e) {
      return upstream(e);
    }
  });

  app.get('/api/review/:repo/mr/:iid', async (req) => {
    const { repo: repoId, iid } = parseWith(MrParams, req.params);
    if (extProjectId(repoId) !== null) {
      const live = reader(repoId);
      try {
        return await buildExtMrReview({
          live,
          repoId,
          repoName: extRepoConfig(deps.store, repoId)!.name,
          iid,
          global: deps.store.getGlobal(),
          me: reviewerIdentity(deps.store)?.username ?? null,
          now: now(),
        });
      } catch (e) {
        return upstream(e);
      }
    }
    if (!deps.store.getRepo(repoId))
      throw new HttpError(404, 'repo_not_found', 'Unknown repository');
    let live: ReviewReader | null = null;
    let liveError: string | null = null;
    try {
      live = reader(repoId);
    } catch {
      liveError = 'GitLab host is not configured: the diff cannot be read.';
    }
    const review = await buildMrReview({
      app: deps.cache,
      repos: deps.store.listReposFull(),
      global: deps.store.getGlobal(),
      repoId,
      iid,
      live,
      liveError,
      now: now(),
    });
    if (!review)
      throw new HttpError(
        404,
        'mr_not_found',
        'This MR is not in the local cache (not synced yet)',
      );
    return review;
  });

  app.get('/api/review/:repo/compare', async (req) => {
    const { repo: repoId } = parseWith(CompareParams, req.params);
    const { from, to } = parseWith(CompareQuerySchema, req.query);
    // Comparing a branch with itself is always empty: a malformed request, not a GitLab call.
    if (from === to)
      throw new HttpError(400, 'same_branch', 'Pick two different branches to compare');
    const live = reader(repoId);
    const repo = deps.store.getRepo(repoId) ?? extRepoConfig(deps.store, repoId)!;
    try {
      return await buildCompareReview({
        live,
        repoId,
        repoName: repo.name,
        from,
        to,
        now: now(),
      });
    } catch (e) {
      return upstream(e);
    }
  });
}
