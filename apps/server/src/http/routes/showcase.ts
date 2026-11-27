import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConfigStore } from '../../config/store';
import { parseWith } from '../errors';

/** `state.showcase.seen`: the feature tour after the first-start question was shown (or skipped) once. */
const SEEN_STATE = 'showcase.seen';

const BodySchema = z.object({ seen: z.boolean() });

/**
 * `GET /api/showcase` and `PUT /api/showcase`: whether the feature tour still opens by itself. A UI flag, so it is
 * not audited; reopening the tour from Settings or the command palette does not need it.
 */
export function registerShowcaseRoutes(app: FastifyInstance, deps: { store: ConfigStore }): void {
  app.get('/api/showcase', async () => ({
    seen: deps.store.getState<boolean>(SEEN_STATE) === true,
  }));
  app.put('/api/showcase', async (req) => {
    const { seen } = parseWith(BodySchema, req.body);
    deps.store.setState(SEEN_STATE, seen ? true : undefined);
    return { seen };
  });
}
