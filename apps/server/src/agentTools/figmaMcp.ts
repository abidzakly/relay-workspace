/**
 * `figma_bridge` MCP server for a Claude session: the Figma MCP bridge tools, proxied through Relay. A stdio process
 * started by the session (see `writeFigmaMcpConfig` in services/cockpit/sessions.ts). Every request goes to
 * Relay's `/api/agent-tools/figma/…` routes with the session's token; Relay decides which tools this session may use
 * (edits only with "Agent may edit Figma") and forwards them to the bridge next to the Figma desktop app.
 *
 * Env: FIGMA_RELAY_URL (http://127.0.0.1:<port>), FIGMA_SESSION_TOKEN.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, FIGMA_SESSION_TOKEN_HEADER } from '@relay/shared';

const url = process.env.FIGMA_RELAY_URL ?? '';
const token = process.env.FIGMA_SESSION_TOKEN ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) || !token) {
  process.stderr.write('figma MCP: FIGMA_RELAY_URL and FIGMA_SESSION_TOKEN are required\n');
  process.exit(1);
}

const base = `${url}/api/agent-tools/figma`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [FIGMA_SESSION_TOKEN_HEADER]: token,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(`Relay refused (${res.status}): ${msg.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

const INSTRUCTIONS = [
  'Figma MCP bridge: live access to the Figma files that have the bridge plugin open in the Figma desktop app on this Mac. Start with list_files; pass its fileKey when several files are open. Node ids use the colon form (2216:24268).',
  'Read before you change: get_node or get_design_context for the target, get_screenshot to check the result after an edit.',
  'Edits act as the account signed in to Figma desktop, and work only when that account may edit the file and the plugin runs in the design editor (not Dev Mode). If an edit tool is missing, this session may only read Figma.',
].join('\n');

const server = new Server(
  { name: 'figma_bridge', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const r = await post<{ tools: Tool[] }>('/list', {});
  return { tools: r.tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  try {
    return await post<CallToolResult>('/call', {
      name: req.params.name,
      arguments: req.params.arguments ?? {},
    });
  } catch (e) {
    return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
