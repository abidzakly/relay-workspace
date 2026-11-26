import type { FastifyInstance } from 'fastify';
import { FIGMA_SESSION_TOKEN_HEADER } from '@relay/shared';
import { z } from 'zod';
import type { FigmaAgentTools } from '../../services/figma/agentTools';
import { parseWith, wrapAction } from '../errors';

const CallBody = z
  .object({
    name: z.string().regex(/^[a-z_]{1,64}$/),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * The agents' Figma bridge tools (private listener; CSRF + Host checks apply):
 *  POST /api/agent-tools/figma/list|call   the agent's proxy process, with its session token (loopback)
 */
export function registerFigmaAgentToolRoutes(app: FastifyInstance, tools: FigmaAgentTools): void {
  const sessionToken = (h: unknown) => (typeof h === 'string' ? h : undefined);
  app.post('/api/agent-tools/figma/list', async (req) =>
    wrapAction(() => tools.list(sessionToken(req.headers[FIGMA_SESSION_TOKEN_HEADER]))),
  );
  app.post('/api/agent-tools/figma/call', async (req) => {
    const b = parseWith(CallBody, req.body);
    return wrapAction(() =>
      tools.call(sessionToken(req.headers[FIGMA_SESSION_TOKEN_HEADER]), b.name, b.arguments),
    );
  });
}
