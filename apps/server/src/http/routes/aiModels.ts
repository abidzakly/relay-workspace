import {
  builtinCursorModels,
  claudeModelsFor,
  groupCursorModels,
  type AgentModelCatalog,
} from '@relay/shared';
import type { FastifyInstance } from 'fastify';
import type { CockpitHost } from '../../services/cockpit/host';

/**
 * `GET /api/ai/models`: the models the Settings pickers offer, limited to what the local logins may use. Cursor's
 * list comes live from its CLI (account-scoped), Claude's from the catalog filtered by the `claude auth status` tier.
 * Any failure (no host, older host agent, CLI missing or logged out) answers with the full built-in catalog.
 * `?refresh=1` re-reads the CLIs (they are cached for 10 minutes on the host).
 */
export function registerAiModelRoutes(app: FastifyInstance, host: CockpitHost | null): void {
  app.get('/api/ai/models', async (req): Promise<AgentModelCatalog> => {
    const refresh = (req.query as { refresh?: string } | undefined)?.refresh === '1';
    const live = await (host?.agentModels?.(refresh) ?? Promise.resolve(null)).catch(() => null);
    const accounts = live?.accounts ?? { claude: null, cursor: null };
    return {
      claude: claudeModelsFor(accounts),
      cursor: live?.cursor ? groupCursorModels(live.cursor) : builtinCursorModels(),
      source: live?.cursor ? 'live' : 'builtin',
      accounts,
    };
  });
}
