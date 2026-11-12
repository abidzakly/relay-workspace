import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ShareRequestSchema, type ShareResult } from '@relay/shared';
import type { ShareService } from '../../services/share';
import { parseWith, wrapAction as wrap } from '../errors';

const JobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });

/**
 * POST /api/share/:jobId: the QA message and its wa.me link, for a staging build already on Drive. Nothing is
 * sent from here. Private listener only, and the Host header has passed its allowlist, so it can name the local link.
 */
export function registerShareRoutes(
  app: FastifyInstance,
  { share }: { share: ShareService },
): void {
  app.post('/api/share/:jobId', async (req): Promise<ShareResult> => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    const body = parseWith(ShareRequestSchema, req.body ?? {});
    return wrap(() =>
      share.share(jobId, {
        includeLocalLink: body.includeLocalLink ?? false,
        localOrigin: localOrigin(req.headers.host ?? ''),
      }),
    );
  });
}

/** The Host already passed the allowlist: loopback is plain http, anything else is a `DASHBOARD_TLS_HOSTS` name. */
function localOrigin(host: string): string {
  const loopback = host.startsWith('127.0.0.1:') || host.startsWith('localhost:');
  return `${loopback ? 'http' : 'https'}://${host.replace(/:443$/, '')}`;
}
