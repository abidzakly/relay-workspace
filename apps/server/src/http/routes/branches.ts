import type { FastifyInstance } from 'fastify';
import {
  BranchDeleteBodySchema,
  BranchFetchBodySchema,
  BranchRepoQuerySchema,
  CardLinkBodySchema,
  CardUnlinkBodySchema,
} from '@relay/shared';
import type { BranchesService } from '../../services/branches/branchesService';
import { parseWith, wrapAction } from '../errors';
import { wrapCockpit } from './cockpit';

/**
 * Branches page: every branch of a repo with its MR and card, a fetch to refresh origin refs, and branch → card links
 * made in Relay. Private dashboard listener only, registered with the cockpit routes.
 */
export function registerBranchesRoutes(app: FastifyInstance, branches: BranchesService): void {
  const run = <T>(fn: () => Promise<T> | T) => wrapAction(() => wrapCockpit(async () => fn()));
  app.get('/api/branches', async (req) => {
    const { repo } = parseWith(BranchRepoQuerySchema, req.query);
    return run(() => branches.list(repo));
  });
  app.post('/api/branches/fetch', async (req) => {
    const { repo } = parseWith(BranchFetchBodySchema, req.body);
    return run(() => branches.fetch(repo));
  });
  app.post('/api/branches/delete', async (req) => {
    const body = parseWith(BranchDeleteBodySchema, req.body);
    return run(() => branches.delete(body));
  });
  app.put('/api/branches/card-link', async (req) => {
    const { repo, branch, cardId } = parseWith(CardLinkBodySchema, req.body);
    return run(() => branches.linkCard(repo, branch, cardId));
  });
  app.delete('/api/branches/card-link', async (req) => {
    const { repo, branch } = parseWith(CardUnlinkBodySchema, req.body);
    return run(() => branches.unlinkCard(repo, branch));
  });
}
