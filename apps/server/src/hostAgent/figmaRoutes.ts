import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BridgeToolError,
  BridgeUnavailableError,
  type FigmaBridge,
} from '../services/figma/bridgeClient';

/**
 * Host agent Figma routes. The Figma bridge runs on the Mac next to the Figma desktop app, so the dashboard in Docker
 * reaches it through here. Bearer-checked like every agent route. Only the tools `FigmaService` uses are allowed.
 */
export const FIGMA_AGENT_TOOLS = [
  'get_metadata',
  'get_node',
  'get_screenshot',
  'get_styles',
  'get_variable_defs',
] as const;

const CallBody = z.object({
  tool: z.enum(FIGMA_AGENT_TOOLS),
  args: z.record(z.string(), z.unknown()),
});

export function registerFigmaAgentRoutes(app: FastifyInstance, bridge: FigmaBridge): void {
  app.get('/v1/figma/files', async (_req, reply) => {
    try {
      return await bridge.files();
    } catch (e) {
      return reply.code(503).send({ error: 'bridge_unavailable', message: (e as Error).message });
    }
  });

  app.post('/v1/figma/call', async (req, reply) => {
    const parsed = CallBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: 'invalid_request', message: 'Invalid request.' });
    }
    try {
      return await bridge.call(parsed.data.tool, parsed.data.args);
    } catch (e) {
      if (e instanceof BridgeToolError) {
        return reply.code(422).send({ error: 'tool_error', message: e.message });
      }
      if (e instanceof BridgeUnavailableError) {
        return reply.code(503).send({ error: 'bridge_unavailable', message: e.message });
      }
      throw e;
    }
  });
}
