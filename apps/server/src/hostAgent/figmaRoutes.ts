import type { FastifyInstance } from 'fastify';
import { FIGMA_SESSION_TOOLS } from '@relay/shared';
import { z } from 'zod';
import {
  BridgeToolError,
  BridgeUnavailableError,
  type FigmaBridge,
} from '../services/figma/bridgeClient';

/**
 * Host agent Figma routes. The Figma bridge runs on the Mac next to the Figma desktop app, so the dashboard in Docker
 * reaches it through here. Bearer-checked like every agent route. `/call` allows only the tools `FigmaService`
 * uses; `/tool` serves agent sessions through Relay, which already decided the session may use that tool.
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

/** An agent session's call, proxied by Relay after it checked the session may use the tool (writes included). */
const ToolBody = z.object({
  tool: z.string().refine((t) => FIGMA_SESSION_TOOLS.includes(t), 'Not a Figma session tool.'),
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

  app.get('/v1/figma/tools', async (_req, reply) => {
    if (!bridge.listTools) return reply.code(503).send({ error: 'bridge_unavailable' });
    try {
      const tools = await bridge.listTools();
      return { tools: tools.filter((t) => FIGMA_SESSION_TOOLS.includes(t.name)) };
    } catch (e) {
      return reply.code(503).send({ error: 'bridge_unavailable', message: (e as Error).message });
    }
  });

  app.post('/v1/figma/tool', async (req, reply) => {
    const parsed = ToolBody.safeParse(req.body);
    if (!parsed.success || !bridge.callTool) {
      return reply.code(422).send({ error: 'invalid_request', message: 'Invalid request.' });
    }
    try {
      return await bridge.callTool(parsed.data.tool, parsed.data.args);
    } catch (e) {
      if (e instanceof BridgeUnavailableError) {
        return reply.code(503).send({ error: 'bridge_unavailable', message: e.message });
      }
      throw e;
    }
  });
}
