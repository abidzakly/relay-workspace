import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MrListQuerySchema,
  RepoIdSchema,
  ReviewRepoIdSchema,
  UPLOAD_FILENAME_RE,
  UPLOAD_SECRET_RE,
} from '@relay/shared';
import { sniffImage } from '../../services/imageSniff';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { GitlabService } from '../../services/gitlabService';
import type { HttpClient } from '../../services/httpClient';
import { buildMrDetail, type MrLiveReader } from '../../services/mrDetail';
import { buildMrInbox } from '../../services/mrInbox';
import type { Logger } from '../../util/logger';
import { repoOrExt } from '../../services/reviewTarget';
import { HttpError, parseWith } from '../errors';

export interface MrRouteDeps {
  store: ConfigStore;
  /** Local cache DB. */
  cache: AppDb;
  http: HttpClient;
  log: Logger;
  now?: () => number;
  /** Pushed heads without MR (stack parents). */
  branchHeads?: (repoId: string) => { branch: string; sha: string }[];
}

const ParamsSchema = z.object({ repo: RepoIdSchema, iid: z.coerce.number().int().positive() });
const UploadParamsSchema = z.object({
  // Reviews projects (`~<projectId>`) show comment images too.
  repo: ReviewRepoIdSchema,
  secret: z.string().regex(UPLOAD_SECRET_RE),
  filename: z.string().regex(UPLOAD_FILENAME_RE),
});
const AvatarQuerySchema = z.object({
  path: z
    .string()
    .max(500)
    .regex(/^\/uploads\/[\w./-]+$/)
    .refine((p) => !p.includes('..'), 'invalid path'),
});

/** Image bytes as a same-origin response: sniffed type, no sniffing by the browser, no script, cached a day. */
function sendImage(reply: FastifyReply, bytes: Buffer) {
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(415, 'not_an_image', 'This file is not an image');
  return reply
    .header('content-type', type)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'private, max-age=86400')
    .send(bytes);
}

/**
 * MR Inbox + MR Detail, READ-ONLY:
 *  - `GET /api/mrs?repo=&state=&reviewer=`: cached MRs of every repo, sorted by "needs your action". Cache only.
 *  - `GET /api/mrs/:repo/:iid`: the cached MR + a GET-only live read of GitLab (description, discussions,
 *    approvals, changed files), falling back to the cache per section. Writes nothing, not even read state.
 * Reply / resolve / merge (POSTs) are later parts. Markdown is returned RAW; the client sanitizes.
 */
export function registerMrRoutes(app: FastifyInstance, deps: MrRouteDeps): void {
  const now = deps.now ?? Date.now;

  app.get('/api/mrs', async (req) =>
    buildMrInbox(
      deps.cache,
      deps.store.listReposFull(),
      deps.store.getGlobal(),
      parseWith(MrListQuerySchema, req.query),
      now(),
      deps.store.myUsernames(),
    ),
  );

  /**
   * A comment's image, proxied so the page's `img-src 'self'` CSP holds and the token never reaches the browser.
   * Only real PNG/JPEG/GIF/WebP bytes are served (sniffed, never trusted from GitLab's content type).
   */
  app.get('/api/mrs/:repo/uploads/:secret/:filename', async (req, reply) => {
    const { repo: repoId, secret, filename } = parseWith(UploadParamsSchema, req.params);
    if (!repoOrExt(deps.store, repoId))
      throw new HttpError(404, 'repo_not_found', 'Unknown repository');
    let svc: GitlabService;
    try {
      svc = GitlabService.forRepo(deps.store, repoId, {
        http: deps.http,
        store: deps.cache,
        log: deps.log,
      });
    } catch {
      throw new HttpError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
    const bytes = await svc.downloadUpload(secret, filename).catch(() => {
      throw new HttpError(404, 'upload_not_found', 'GitLab did not return this file');
    });
    return sendImage(reply, bytes);
  });

  /** A user's avatar from the GitLab host (no token: avatars are public there). Paths come from `avatarPath`. */
  app.get('/api/gitlab/avatar', async (req, reply) => {
    const { path } = parseWith(AvatarQuerySchema, req.query);
    const host = deps.store.getGlobal().gitlab.host;
    if (!host) throw new HttpError(404, 'gitlab_not_configured', 'GitLab host is not configured');
    const url = new URL(path, host);
    if (url.origin !== new URL(host).origin) throw new HttpError(400, 'bad_path', 'Invalid path');
    const res = await deps.http
      .send({ url: url.href, binary: true, timeoutMs: 10_000, maxRetries: 0 })
      .catch(() => null);
    if (!res || res.status !== 200 || !res.bytes) {
      throw new HttpError(404, 'avatar_not_found', 'No avatar');
    }
    return sendImage(reply, res.bytes);
  });

  app.get('/api/mrs/:repo/:iid', async (req) => {
    const { repo: repoId, iid } = parseWith(ParamsSchema, req.params);
    const repo = deps.store.getRepo(repoId);
    if (!repo) throw new HttpError(404, 'repo_not_found', 'Unknown repository');

    let live: MrLiveReader | null = null;
    let liveError: string | null = null;
    try {
      live = GitlabService.forRepo(deps.store, repoId, {
        http: deps.http,
        store: deps.cache,
        log: deps.log,
      });
    } catch {
      // forRepo only fails for a missing host; never echo anything else.
      liveError = 'GitLab host is not configured: showing cached data only';
    }

    const detail = await buildMrDetail({
      app: deps.cache,
      repos: deps.store.listReposFull(),
      global: deps.store.getGlobal(),
      repoId,
      iid,
      approvalMode: repo.approvalMode,
      live,
      liveError,
      now: now(),
      ...(deps.branchHeads
        ? { branchHeads: () => Promise.resolve(deps.branchHeads!(repoId)) }
        : {}),
    });
    if (!detail)
      throw new HttpError(
        404,
        'mr_not_found',
        'This MR is not in the local cache (not synced yet)',
      );
    return detail;
  });
}
