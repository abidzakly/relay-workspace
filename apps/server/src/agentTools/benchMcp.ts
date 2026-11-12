/**
 * `bench` MCP server: the AI device tester's tools. A stdio process started by the Claude session
 * of one AI run (see `writeTestRunMcpConfig` in services/cockpit/sessions.ts). Every tool is a call to the dashboard's
 * `/api/bench-run/<run>/…` routes with the run's token; this process holds no state and no other credentials.
 *
 * Env: BENCH_URL (http://127.0.0.1:<port>), BENCH_TOKEN, BENCH_RUN.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, FINDING_SEVERITIES } from '@relay/shared';
import { z } from 'zod';

const url = process.env.BENCH_URL ?? '';
const token = process.env.BENCH_TOKEN ?? '';
const run = process.env.BENCH_RUN ?? '';
if (
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) ||
  !token ||
  !/^[0-9a-f-]{36}$/.test(run)
) {
  process.stderr.write('bench MCP: BENCH_URL, BENCH_TOKEN and BENCH_RUN are required\n');
  process.exit(1);
}

const base = `${url}/api/bench-run/${run}`;
const headers = { 'x-bench-token': token, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // ask_human waits for the user: up to 10 minutes on the server.
    signal: AbortSignal.timeout(path === '/human' ? 11 * 60_000 : 60_000),
  });
}

async function json(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await call(method, path, body);
  const t = await res.text();
  if (!res.ok) {
    let msg = t;
    try {
      msg = (JSON.parse(t) as { message?: string; error?: string }).message ?? msg;
    } catch {
      /* not JSON */
    }
    return fail(`Refused (${res.status}): ${msg.slice(0, 500)}`);
  }
  return text(t);
}

/** `{ text, png }` answers (observe, actions): the text first, the screen image when there is one. */
async function screen(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await call(method, path, body);
  const t = await res.text();
  if (!res.ok) {
    let msg = t;
    try {
      msg = (JSON.parse(t) as { message?: string }).message ?? msg;
    } catch {
      /* not JSON */
    }
    return fail(`Refused (${res.status}): ${msg.slice(0, 500)}`);
  }
  const r = JSON.parse(t) as { text: string; png: string | null };
  const content: Content[] = [{ type: 'text', text: r.text }];
  if (r.png) content.push({ type: 'image', data: r.png, mimeType: 'image/png' });
  return { content };
}

const act = (body: Record<string, unknown>) => screen('POST', '/act', body);

async function image(path: string, label: string) {
  const res = await call('GET', path);
  if (!res.ok) return fail(`${label} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = Buffer.from(await res.arrayBuffer()).toString('base64');
  return { content: [{ type: 'image', data, mimeType: 'image/png' } as Content] };
}

const server = new McpServer({ name: 'bench', version: '2.0.0' });
const px = z.number().int().min(0).max(10_000);
const n = z
  .number()
  .int()
  .min(0)
  .max(5_000)
  .describe('Element number from the latest screen list, e.g. 4 for [4].');
const ascii = z.string().min(1).max(200).describe('Printable ASCII only.');

server.registerTool(
  'get_context',
  {
    description:
      'Start here. The card, how many items there are to test, what this branch changed (new texts, widget keys, routes, widgets: look for these on screen), notes saved by earlier runs, and the Dart VM service URI.',
  },
  async () => json('GET', '/context'),
);

server.registerTool(
  'next_ac',
  {
    description:
      'The next acceptance criterion or regression check to test, one at a time, with its action budget. It stays the current one until you mark it. Returns done:true when everything has a result.',
  },
  async () => json('POST', '/next', {}),
);

server.registerTool(
  'observe',
  {
    description:
      'Read the phone screen: a numbered list of its elements ([n] role "label" @x,y) plus a screenshot, and any new app errors. Use the numbers with tap_element and type_into.',
  },
  async () => screen('GET', '/observe'),
);

server.registerTool(
  'screenshot',
  {
    description:
      'The screen as an image only. For colours, layout, icons without labels, and design comparison. Pixel coordinates for tap and swipe come from it.',
  },
  async () => image('/screenshot', 'Screenshot'),
);

server.registerTool(
  'tap_element',
  {
    description:
      'Tap element [n] of the latest screen list. Answers with what changed on screen, new app errors and the new list (numbers change after every action).',
    inputSchema: { n },
  },
  async (a) => act({ kind: 'tap_element', ...a }),
);

server.registerTool(
  'type_into',
  {
    description:
      'Tap field [n], clear it (unless clear=false) and type text. Answers like tap_element.',
    inputSchema: { n, text: ascii, clear: z.boolean().default(true) },
  },
  async (a) => act({ kind: 'type_into', ...a }),
);

server.registerTool(
  'scroll_until',
  {
    description:
      'Scroll the main list (down = show what is below) until an element containing text is on screen, or the end is reached.',
    inputSchema: {
      text: z.string().min(1).max(200),
      direction: z.enum(['down', 'up']).default('down'),
      maxSwipes: z.number().int().min(1).max(15).default(8),
    },
  },
  async (a) => act({ kind: 'scroll_until', ...a }),
);

server.registerTool(
  'wait_for',
  {
    description:
      'Wait until an element containing text appears (or, with gone=true, disappears): for loading, network calls, animations.',
    inputSchema: {
      text: z.string().min(1).max(200),
      gone: z.boolean().default(false),
      timeoutMs: z.number().int().min(500).max(20_000).default(8_000),
    },
  },
  async (a) => act({ kind: 'wait_for', ...a }),
);

server.registerTool(
  'press_key',
  {
    description: 'Press a phone key (back also closes the keyboard). Answers like tap_element.',
    inputSchema: { key: z.enum(['back', 'home', 'app_switch', 'enter', 'delete', 'tab']) },
  },
  async ({ key }) => act({ kind: 'key', key }),
);

server.registerTool(
  'restart_app',
  {
    description:
      'Restart the app from scratch (hot restart through flutter run, else force-stop and relaunch). For a stuck or crashed app.',
  },
  async () => act({ kind: 'restart_app' }),
);

server.registerTool(
  'tap',
  {
    description:
      'Fallback only: tap pixel x,y of the latest screenshot, for something missing from the element list.',
    inputSchema: { x: px, y: px },
  },
  async (a) => act({ kind: 'tap', ...a }),
);

server.registerTool(
  'swipe',
  {
    description:
      'Fallback only: swipe from x1,y1 to x2,y2 (pixels) over ms milliseconds. Prefer scroll_until.',
    inputSchema: {
      x1: px,
      y1: px,
      x2: px,
      y2: px,
      ms: z.number().int().min(50).max(5_000).default(300),
    },
  },
  async (a) => act({ kind: 'swipe', ...a }),
);

server.registerTool(
  'type_text',
  {
    description: 'Fallback only: type into whatever field is focused. Prefer type_into.',
    inputSchema: { text: ascii },
  },
  async (a) => act({ kind: 'type_text', ...a }),
);

server.registerTool(
  'assert_visible',
  {
    description:
      'Server-side check that an element containing text is on screen now. Use it to confirm the expected result before marking pass.',
    inputSchema: { text: z.string().min(1).max(200) },
  },
  async ({ text: t }) => json('POST', '/assert', { text: t, visible: true }),
);

server.registerTool(
  'assert_gone',
  {
    description: 'Server-side check that no element containing text is on screen now.',
    inputSchema: { text: z.string().min(1).max(200) },
  },
  async ({ text: t }) => json('POST', '/assert', { text: t, visible: false }),
);

server.registerTool(
  'remember',
  {
    description:
      'Save a short navigation tip for future runs on this app (e.g. "Profile: avatar top right, then Edit"). Not for results.',
    inputSchema: { note: z.string().min(3).max(300) },
  },
  async (a) => json('POST', '/note', a),
);

server.registerTool(
  'figma_frame',
  {
    description:
      'The Figma design for one acceptance criterion, as an image. `acKey` is the part after `ac:` in its target.',
    inputSchema: { acKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) },
  },
  async ({ acKey }) => image(`/figma/${acKey}`, 'Figma frame'),
);

server.registerTool(
  'mark',
  {
    description:
      'Record the result of one acceptance criterion or regression check (`target` from get_context). pass = you saw it work; fail = it does not; blocked = you could not check it. The screen is saved as evidence.',
    inputSchema: {
      target: z.string().regex(/^(ac|finding):[A-Za-z0-9_-]{1,80}$/),
      state: z.enum(['pass', 'fail', 'blocked']),
      note: z.string().min(1).max(1000),
    },
  },
  async (a) => json('POST', '/mark', a),
);

server.registerTool(
  'report_finding',
  {
    description:
      'Log an issue found while testing; the current screen is attached. Continue testing afterwards unless the whole app is blocked.',
    inputSchema: {
      title: z.string().min(3).max(200),
      severity: z.enum(FINDING_SEVERITIES),
      acKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,80}$/)
        .nullable()
        .default(null),
      steps: z.string().max(4000).default(''),
      expected: z.string().max(2000).default(''),
      actual: z.string().max(2000).default(''),
    },
  },
  async (a) => json('POST', '/finding', a),
);

server.registerTool(
  'ask_human',
  {
    description:
      'Pause and ask the developer to do something on the phone you cannot (OTP, credentials, a system dialog). Waits up to 10 minutes; returns {"helped":true} when they did it.',
    inputSchema: { reason: z.string().min(3).max(500) },
  },
  async ({ reason }) => json('POST', '/human', { reason }),
);

server.registerTool(
  'finish',
  {
    description:
      'End the run once next_ac says done. If the whole app is blocked (crash on start, stuck at login), pass blockRest with the reason: every item without a result is marked blocked. The dashboard decides ready / not ready from the marks.',
    inputSchema: {
      summary: z.string().max(8000),
      blockRest: z.string().min(3).max(500).optional(),
    },
  },
  async ({ summary, blockRest }) =>
    json('POST', '/finish', { summary, ...(blockRest ? { blockRest } : {}) }),
);

await server.connect(new StdioServerTransport());
