import { FlavorSchema, FlutterRunModeSchema, TestRunProfileSchema } from '@relay/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CockpitHostError } from '../services/cockpit/host';
import type { LocalCockpitHost } from '../services/cockpit/localHost';

/**
 * The host agent's cockpit routes. Same bearer token as every agent route (checked in the
 * agent's `onRequest`); the agent binds to 127.0.0.1 only. Each route is a thin shell over `LocalCockpitHost`.
 */

const AiSchema = z.object({
  prompt: z.string().min(1).max(2_000_000),
  model: z.string().regex(/^[a-z0-9.-]{1,64}$/),
  engine: z.enum(['claude', 'cursor']).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(10 * 60_000),
});

const RefSchema = z.object({
  path: z.string().min(1).max(1024),
  wsId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
});
const RelSchema = z.string().min(1).max(1024);
const WsSchemas = {
  validate: z.object({ ref: RefSchema }),
  'agent-rules': z.object({ ref: RefSchema }),
  status: z.object({ ref: RefSchema }),
  tree: z.object({ ref: RefSchema }),
  checkpoint: z.object({ ref: RefSchema }),
  diff: z.object({
    ref: RefSchema,
    mode: z.enum(['working', 'branch', 'turn']),
    base: z.string().max(200).optional(),
  }),
  read: z.object({ ref: RefSchema, rel: RelSchema }),
  write: z.object({
    ref: RefSchema,
    rel: RelSchema,
    content: z.string().max(1024 * 1024),
    expectedHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  }),
  devices: z.object({ ref: RefSchema }),
  'run-targets': z.object({ ref: RefSchema }),
  integrity: z.object({ ref: RefSchema }),
  'start-branch': z.object({
    ref: RefSchema,
    branch: z.string().min(1).max(255),
    base: z.string().min(1).max(255),
    replace: z.boolean().optional(),
    existing: z.enum(['replace', 'reuse']).optional(),
  }),
  'checkout-branch': z.object({ ref: RefSchema, branch: z.string().min(1).max(255) }),
  'clean-tree': z.object({ ref: RefSchema, clean: z.enum(['stash', 'discard']) }),
  'add-worktree': z.object({
    ref: RefSchema,
    branch: z.string().min(1).max(255),
    base: z.string().min(1).max(255),
    existing: z.enum(['replace', 'reuse']).optional(),
  }),
  'remove-worktree': z.object({ ref: RefSchema, path: z.string().min(1).max(1024) }),
  log: z.object({ ref: RefSchema, base: z.string().min(1).max(262) }),
  'squash-for-mr': z.object({
    ref: RefSchema,
    branch: z.string().min(1).max(255),
    base: z.string().min(1).max(262),
  }),
  'cleanup-facts': z.object({ ref: RefSchema, base: z.string().min(1).max(200) }),
  'cleanup-apply': z.object({
    ref: RefSchema,
    base: z.string().min(1).max(200),
    items: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('attachment'), group: z.string().min(1).max(120) }),
          z.object({
            kind: z.literal('ref'),
            name: z.string().min(1).max(400),
            sha: z.string().regex(/^[0-9a-f]{40,64}$/),
          }),
          z.object({
            kind: z.literal('branch'),
            name: z.string().min(1).max(255),
            tip: z.string().regex(/^[0-9a-f]{40,64}$/),
            force: z.boolean(),
          }),
          z.object({ kind: z.literal('prune') }),
        ]),
      )
      .max(2_000),
  }),
  'save-attachment': z.object({
    ref: RefSchema,
    group: z.string().regex(/^[0-9a-f]{8,64}$/i),
    name: z.string().min(1).max(255),
    // 5 MB file (the HTTP client's cap) as base64.
    dataBase64: z
      .string()
      .min(1)
      .max(7 * 1024 * 1024),
  }),
  'launch-emulator': z.object({
    ref: RefSchema,
    emulatorId: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  }),
};

const SessionStart = z.object({
  testRun: TestRunProfileSchema.optional(),
  ref: RefSchema,
  kind: z.enum(['claude', 'cursor', 'shell', 'flutter']),
  deviceId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,120}$/)
    .optional(),
  flavor: FlavorSchema.optional(),
  mode: FlutterRunModeSchema.default('debug'),
  ios: z.boolean().default(false),
  model: z
    .string()
    .regex(/^[a-z0-9.-]{1,64}$/i)
    .optional(),
  execModel: z
    .string()
    .regex(/^[a-z0-9.-]{1,64}$/i)
    .optional(),
  execEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  execSwitch: z.enum(['ask', 'auto']).optional(),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
const SessionId = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/) });
const Input = z.object({
  data: z
    .string()
    .min(1)
    .max(64 * 1024),
});
const Resize = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

export async function sendHostError(reply: FastifyReply, e: unknown): Promise<FastifyReply> {
  if (e instanceof CockpitHostError) {
    return reply.code(e.status).send({
      error: e.message,
      code: e.code,
      ...(e.details !== undefined ? { details: e.details } : {}),
    });
  }
  return reply.code(500).send({ error: (e as Error).message ?? 'error', code: 'internal' });
}

export function registerCockpitAgentRoutes(app: FastifyInstance, host: LocalCockpitHost): void {
  app.get('/v1/cockpit/health', async (req) =>
    host.health((req.query as { refresh?: string } | undefined)?.refresh === '1'),
  );

  // Workspaces: every call re-validates the path against the agent's roots.
  app.post<{ Params: { op: string } }>(
    '/v1/cockpit/ws/:op',
    { bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      const op = req.params.op as keyof typeof WsSchemas;
      const schema = WsSchemas[op];
      if (!schema) return reply.code(404).send({ error: 'unknown op', code: 'not_found' });
      const p = schema.safeParse(req.body);
      if (!p.success) return reply.code(422).send({ error: 'invalid request', code: 'validation' });
      const b = p.data as z.infer<(typeof WsSchemas)['write']> &
        z.infer<(typeof WsSchemas)['diff']> &
        z.infer<(typeof WsSchemas)['launch-emulator']> &
        z.infer<(typeof WsSchemas)['start-branch']> &
        z.infer<(typeof WsSchemas)['add-worktree']> &
        z.infer<(typeof WsSchemas)['clean-tree']> &
        z.infer<(typeof WsSchemas)['save-attachment']> &
        z.infer<(typeof WsSchemas)['squash-for-mr']> &
        z.infer<(typeof WsSchemas)['cleanup-apply']> &
        z.infer<(typeof WsSchemas)['remove-worktree']>;
      try {
        switch (op) {
          case 'validate':
            return await host.wsValidate(b.ref);
          case 'agent-rules':
            await host.wsEnsureAgentRules(b.ref);
            return { ok: true };
          case 'status':
            return await host.wsStatus(b.ref);
          case 'tree':
            return await host.wsTree(b.ref);
          case 'checkpoint':
            return await host.wsCheckpoint(b.ref);
          case 'diff':
            return await host.wsDiff(b.ref, b.mode, b.base);
          case 'read':
            return await host.wsReadFile(b.ref, b.rel);
          case 'write':
            return await host.wsWriteFile(b.ref, b.rel, b.content, b.expectedHash);
          case 'devices':
            return await host.flutterDevices(b.ref);
          case 'run-targets':
            return await host.flutterRunTargets(b.ref);
          case 'launch-emulator':
            await host.flutterLaunchEmulator(b.ref, b.emulatorId);
            return { ok: true };
          case 'integrity':
            return await host.wsIntegrity(b.ref);
          case 'start-branch':
            return await host.wsStartBranch(
              b.ref,
              b.branch,
              b.base,
              b.existing ?? (b.replace ? 'replace' : undefined),
            );
          case 'checkout-branch':
            return await host.wsCheckoutBranch(b.ref, b.branch);
          case 'clean-tree':
            return await host.wsCleanTree(b.ref, b.clean);
          case 'add-worktree':
            return await host.wsAddWorktree(b.ref, b.branch, b.base, b.existing);
          case 'remove-worktree':
            await host.wsRemoveWorktree(b.ref, b.path);
            return { ok: true };
          case 'log':
            return await host.wsLog(b.ref, b.base);
          case 'squash-for-mr':
            return await host.wsSquashForMr(b.ref, b.branch, b.base);
          case 'save-attachment':
            return await host.wsSaveAttachment(b.ref, b.group, b.name, b.dataBase64);
          case 'cleanup-facts':
            return await host.wsCleanupFacts(b.ref, b.base);
          case 'cleanup-apply':
            return await host.wsCleanupApply(b.ref, b.base, b.items);
        }
      } catch (e) {
        return sendHostError(reply, e);
      }
    },
  );

  // Sessions: persistent PTYs; attach = NDJSON replay from `since`, then live, with a heartbeat.
  // Storage cleanup: cockpit leftovers in the agent's temp dir (fixed name patterns only).
  app.post('/v1/cockpit/tmp-cleanup/facts', async () => host.tmpCleanupFacts());
  app.post('/v1/cockpit/tmp-cleanup/apply', async (req, reply) => {
    const p = z.object({ names: z.array(z.string().min(1).max(120)).max(500) }).safeParse(req.body);
    if (!p.success) return reply.code(422).send({ error: 'invalid request', code: 'validation' });
    return host.tmpCleanupApply(p.data.names);
  });
  app.get('/v1/cockpit/sessions', async () => host.sessions());
  app.post('/v1/cockpit/sessions', async (req, reply) => {
    const p = SessionStart.safeParse(req.body);
    if (!p.success) return reply.code(422).send({ error: 'invalid request', code: 'validation' });
    try {
      const { ref, ...opts } = p.data;
      return await host.sessionStart(ref, opts);
    } catch (e) {
      return sendHostError(reply, e);
    }
  });
  const withId = (
    op: 'input' | 'resize' | 'kill',
    fn: (id: string, body: unknown) => Promise<void>,
  ) =>
    app.post<{ Params: { id: string } }>(`/v1/cockpit/sessions/:id/${op}`, async (req, reply) => {
      const id = SessionId.safeParse(req.params);
      if (!id.success) return reply.code(422).send({ error: 'invalid id', code: 'validation' });
      try {
        await fn(id.data.id, req.body);
        return { ok: true };
      } catch (e) {
        return sendHostError(reply, e);
      }
    });
  withId('input', (id, b) => host.sessionInput(id, Input.parse(b).data));
  withId('resize', (id, b) => {
    const r = Resize.parse(b);
    return host.sessionResize(id, r.cols, r.rows);
  });
  withId('kill', (id) => host.sessionKill(id));

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/v1/cockpit/sessions/:id/attach',
    async (req, reply) => {
      const id = SessionId.safeParse(req.params);
      if (!id.success) return reply.code(422).send({ error: 'invalid id', code: 'validation' });
      const since = Math.max(0, Number.parseInt(req.query.since ?? '0', 10) || 0);
      const abort = new AbortController();
      const known = (await host.sessions()).some((x) => x.id === id.data.id);
      if (!known)
        return reply.code(404).send({ error: 'Unknown session.', code: 'session_not_found' });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const write = (e: unknown) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
      };
      const hb = setInterval(() => write({ t: 'hb' }), 15_000);
      res.on('close', () => abort.abort());
      try {
        await host.sessionAttach(id.data.id, since, write, abort.signal);
      } catch {
        /* the client sees the stream end */
      }
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    },
  );

  app.post('/v1/cockpit/ai', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const p = AiSchema.safeParse(req.body);
    if (!p.success) return reply.code(422).send({ error: 'invalid request', code: 'validation' });
    try {
      return await host.ai(p.data);
    } catch (e) {
      return sendHostError(reply, e);
    }
  });
}
