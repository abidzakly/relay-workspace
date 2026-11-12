/**
 * `postrack` MCP server for a Claude session: the Postrack tools, proxied through Relay. A stdio process started by
 * the session (see `writePostrackMcpConfig` in services/cockpit/sessions.ts). Every request goes to Relay's
 * `/api/agent-tools/postrack/…` routes with the session's token; Relay holds the Postrack credential and decides which
 * tools this session may use. This process holds no state and no other credentials.
 *
 * Env: POSTRACK_RELAY_URL (http://127.0.0.1:<port>), POSTRACK_SESSION_TOKEN.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, POSTRACK_SESSION_TOKEN_HEADER } from '@relay/shared';

const url = process.env.POSTRACK_RELAY_URL ?? '';
const token = process.env.POSTRACK_SESSION_TOKEN ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) || !token) {
  process.stderr.write(
    'postrack MCP: POSTRACK_RELAY_URL and POSTRACK_SESSION_TOKEN are required\n',
  );
  process.exit(1);
}

const base = `${url}/api/agent-tools/postrack`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [POSTRACK_SESSION_TOKEN_HEADER]: token,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
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
  "Postrack is the team's API workspace: workspaces → projects → collections → folders → endpoints (saved requests with headers, params, body, auth and example responses). Environments belong to projects and hold the {{variables}} the URLs use.",
  'Look an endpoint up here before you guess its URL, payload or response shape: list_endpoints (search by name or URL) or get_workspace_tree, then get_endpoint for the full detail. Map types from the example responses.',
  'Secret variable values come back masked; never ask for them.',
].join('\n');

const server = new Server(
  { name: 'postrack', version: '1.0.0' },
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
