import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RepoIdSchema, SigningUploadRequestSchema } from '@relay/shared';
import type { SigningFiles } from '../../services/signingFiles';
import { parseWith, wrapAction as wrap } from '../errors';

const RepoParamsSchema = z.object({ repo: RepoIdSchema });

/**
 * Android signing files of a repo's bot clone. Private listener only; CSRF header + Host/Origin checks apply to the POST.
 *  - GET  /api/builds/signing/:repo  which files the repo expects, and which are in place
 *  - POST /api/builds/signing/:repo  { fileName, contentBase64 }. One file; the name decides where it goes
 */
export function registerSigningRoutes(app: FastifyInstance, deps: { signing: SigningFiles }): void {
  const { signing } = deps;

  app.get('/api/builds/signing/:repo', async (req) => {
    const { repo } = parseWith(RepoParamsSchema, req.params);
    return wrap(() => signing.status(repo));
  });

  app.post('/api/builds/signing/:repo', async (req) => {
    const { repo } = parseWith(RepoParamsSchema, req.params);
    const body = parseWith(SigningUploadRequestSchema, req.body);
    return wrap(() => signing.upload(repo, body));
  });
}
