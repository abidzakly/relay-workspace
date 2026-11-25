import type { FastifyInstance } from 'fastify';
import { RunBranchBodySchema } from '@relay/shared';
import type { CockpitWorkflowService } from '../../services/cockpit/workflow';
import { parseWith, wrapAction } from '../errors';
import { wrapCockpit } from './cockpit';

/**
 * "Run this branch": puts the repo's workspace on the Mac on a branch (fetching it when it is not local) before the
 * app runs on a test device. Private dashboard listener only, registered with the cockpit routes.
 */
export function registerBenchBranchRoutes(
  app: FastifyInstance,
  workflow: CockpitWorkflowService,
): void {
  app.post('/api/test-bench/branch', async (req) => {
    const { repo, branch } = parseWith(RunBranchBodySchema, req.body);
    return wrapAction(() => wrapCockpit(() => workflow.prepareRunBranch(repo, branch)));
  });
}
