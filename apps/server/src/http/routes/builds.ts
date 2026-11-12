import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  apkDownloadPath,
  BuildPreviewRequestSchema,
  RepoIdSchema,
  BuildStartRequestSchema,
  type BuildList,
  type BuildView,
  type Job,
} from '@relay/shared';
import { ActionError } from '../../services/actionError';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import type { BuildQueue } from '../../services/buildQueue';
import { listPreviewCandidates, resolvePreviewMrs } from '../../services/previewPlan';
import type { ShareService } from '../../services/share';
import { parseWith, wrapAction as wrap } from '../errors';

const JobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });
const EmptyBodySchema = z.object({}).strict();
const HISTORY_LIMIT = 50;

const isFile = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/**
 * Builds. Private listener only; CSRF header + Host/Origin checks apply to every POST. Progress follows on
 * the bus (`job.updated`), the log on its own stream: `http/buildLogStream.ts`.
 *  - GET  /api/builds              the running job's id, then jobs newest first
 *  - POST /api/builds              { repo, mode, flavor? }. 409 `flavor_choice_required` (details: the detection),
 *                                  `release_active`, `build_already_active`
 *  - GET  /api/builds/preview/:repo  the open MRs in merge order (QA preview)
 *  - POST /api/builds/preview      { repo, mrIids, flavor? }. Merges those MRs locally in order, bumps the staging version
 *                                  locally, builds. Nothing is pushed. 409 `mr_not_open`, `integration_conflict` (on the job)
 *  - POST /api/builds/:jobId/cancel  `cancelling: true` until the processes have stopped
 *  - POST /api/builds/:jobId/upload  a user's click. Answers once started; progress follows on the bus (`build.upload`).
 *                                    403 `prod_never_shared`, 409 `upload_in_progress`, `already_uploaded`
 */
export function registerBuildRoutes(
  app: FastifyInstance,
  deps: { builds: BuildQueue; share: ShareService; store?: ConfigStore; cache?: AppDb },
): void {
  const { builds, share } = deps;

  const view = async (job: Job): Promise<BuildView> => {
    const waiting = builds.status().queuedJobIds.indexOf(job.id);
    const artifacts = builds.result(job.id)?.artifacts ?? [];
    return {
      job,
      cancelling: builds.cancelling(job.id),
      queuePosition: waiting === -1 ? null : waiting + 1,
      artifacts: await Promise.all(
        artifacts.map(async ({ kind, fileName, sizeBytes, path }) => ({
          kind,
          fileName,
          sizeBytes,
          url: apkDownloadPath(job.repoId, fileName),
          available: await isFile(path),
        })),
      ),
      share: share.viewOf(job),
    };
  };

  app.get('/api/builds', async (): Promise<BuildList> => ({
    runningJobId: builds.status().runningJobId,
    items: await Promise.all(builds.list(HISTORY_LIMIT).map(view)),
  }));

  app.post('/api/builds', async (req) => {
    const body = parseWith(BuildStartRequestSchema, req.body);
    return wrap(async () =>
      view(
        await builds.enqueue({ repoId: body.repo, mode: body.mode, flavor: body.flavor ?? null }),
      ),
    );
  });

  if (deps.store && deps.cache) {
    const { store, cache } = deps;
    app.get('/api/builds/preview/:repo', async (req) => {
      const { repo } = parseWith(z.object({ repo: RepoIdSchema }), req.params);
      return wrap(async () => listPreviewCandidates(cache, store, repo));
    });

    app.post('/api/builds/preview', async (req) => {
      const body = parseWith(BuildPreviewRequestSchema, req.body);
      return wrap(async () =>
        view(
          await builds.enqueue({
            repoId: body.repo,
            mode: 'staging',
            flavor: body.flavor ?? null,
            integration: resolvePreviewMrs(cache, store, body.repo, body.mrIids),
          }),
        ),
      );
    });
  }

  app.post('/api/builds/:jobId/cancel', async (req) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    parseWith(EmptyBodySchema, req.body ?? {});
    return wrap(async () => {
      if (!builds.job(jobId)) throw new ActionError(404, 'job_not_found', 'Unknown build');
      return view(builds.cancel(jobId));
    });
  });

  app.post('/api/builds/:jobId/upload', async (req) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    parseWith(EmptyBodySchema, req.body ?? {});
    return wrap(async () => {
      // A refusal answers here. A later failure is kept on the job as `uploadError`, and reaches the UI through the view.
      share.beginUpload(jobId).finished.catch(() => undefined);
      const job = builds.job(jobId);
      if (!job) throw new ActionError(404, 'job_not_found', 'Unknown build');
      return view(job);
    });
  });
}
