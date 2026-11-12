import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type ReleaseEngines,
  ReleasePreviewQuerySchema,
  ReleaseResumeRequestSchema,
  ReleaseStartRequestSchema,
  RepoIdSchema,
} from '@relay/shared';
import { ActionError } from '../../services/actionError';
import type { ReleaseEngine } from '../../services/releaseEngine';
import { parseWith, wrapAction as wrap } from '../errors';

const RepoParamsSchema = z.object({ repo: RepoIdSchema });
const JobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });
const EmptyBodySchema = z.object({}).strict();

/**
 * Release jobs. Private listener only; CSRF header + Host/Origin checks apply to every POST. Each POST
 * handler IS the user's explicit action, and answers as soon as the job's state has changed, not when the run ends:
 * progress follows on the bus (`job.updated`).
 *  - GET  /api/release/:repo/preview?mode=&version=  what the version would be (live read of pubspec on GitLab)
 *  - GET  /api/release/:repo/job                     the repo's newest release job, with steps
 *  - POST /api/release/:repo/start                   { mode, version?, engine? }; 409 `release_already_active`
 *  - POST /api/release/:jobId/continue               "Merge now"; 409 `merge_blocked` when the repo requires the gate
 *  - POST /api/release/:jobId/cancel                 `cancelling: true` while the step in progress stops
 *  - POST /api/release/:jobId/resume                 { flavor? }. Re-runs the step that did not finish (not for the PTY engine)
 *  - GET  /api/release-engines                       the current engine, and whether PTY can run here
 * The PTY engine's output has its own stream: `http/ptyStream.ts`.
 */
export function registerReleaseJobRoutes(
  app: FastifyInstance,
  deps: { engine: ReleaseEngine },
): void {
  const { engine } = deps;

  app.get('/api/release-engines', async (): Promise<ReleaseEngines> => ({
    current: engine.currentEngine(),
    pty: engine.pty.availability(),
  }));

  app.get('/api/release/:repo/preview', async (req) => {
    const { repo } = parseWith(RepoParamsSchema, req.params);
    const query = parseWith(ReleasePreviewQuerySchema, req.query);
    return wrap(() => engine.preview(repo, query));
  });

  app.get('/api/release/:repo/job', async (req) => {
    const { repo } = parseWith(RepoParamsSchema, req.params);
    return wrap(async () => {
      const job = engine.jobs.latestRelease(repo);
      if (!job) throw new ActionError(404, 'job_not_found', 'This repo has no release job yet');
      return engine.view(job.id);
    });
  });

  app.post('/api/release/:repo/start', async (req) => {
    const { repo } = parseWith(RepoParamsSchema, req.params);
    const body = parseWith(ReleaseStartRequestSchema, req.body);
    return wrap(async () => engine.view(engine.start(repo, body).job.id));
  });

  app.post('/api/release/:jobId/continue', async (req) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    parseWith(EmptyBodySchema, req.body ?? {});
    return wrap(async () => {
      await engine.continueRelease(jobId);
      return engine.view(jobId);
    });
  });

  app.post('/api/release/:jobId/cancel', async (req) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    parseWith(EmptyBodySchema, req.body ?? {});
    return wrap(async () => engine.cancel(jobId));
  });

  app.post('/api/release/:jobId/resume', async (req) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    const body = parseWith(ReleaseResumeRequestSchema, req.body ?? {});
    return wrap(async () => engine.view(engine.resume(jobId, body).job.id));
  });
}
