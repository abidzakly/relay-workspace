import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  BenchActSchema,
  BranchNameSchema,
  CursorTestModelSchema,
  DeviceSerialSchema,
  TestRunEngineSchema,
  FindingInputSchema,
  RepoIdSchema,
} from '@relay/shared';
import { z } from 'zod';
import type { AiRunService } from '../../services/testBench/aiRun';
import { HttpError, parseWith, wrapAction } from '../errors';

/**
 * AI device test routes.
 *  - `/api/test-bench/ai-run…`: the dashboard UI starts, watches, resumes and stops a run.
 *  - `/api/bench-run/:runId/…`: the `bench` MCP tools of that run's Claude session. Each call carries the run's token
 *    (`x-bench-token`), valid only while the run is live. Loopback only, like the rest of the dashboard.
 */
const RunParams = z.object({ runId: z.string().uuid() });
const TOKEN_HEADER = 'x-bench-token';
const token = (req: FastifyRequest) => {
  const v = req.headers[TOKEN_HEADER];
  return typeof v === 'string' ? v : undefined;
};

export function registerBenchRunRoutes(
  app: FastifyInstance,
  ai: AiRunService,
  evidenceDir: string,
): void {
  // ── UI
  app.post('/api/test-bench/ai-run', async (req) => {
    const b = parseWith(
      z
        .object({
          repo: RepoIdSchema,
          branch: BranchNameSchema,
          serial: DeviceSerialSchema,
          engine: TestRunEngineSchema.default('claude'),
          cursorModel: CursorTestModelSchema.default('auto'),
        })
        .strict(),
      req.body,
    );
    return wrapAction(() =>
      ai.start(b.repo, b.branch, b.serial, { engine: b.engine, cursorModel: b.cursorModel }),
    );
  });
  app.post('/api/test-bench/ai-run/:runId/resume', async (req) => {
    const { runId } = parseWith(RunParams, req.params);
    return wrapAction(async () => ai.resume(runId));
  });
  app.post('/api/test-bench/ai-run/:runId/stop', async (req) => {
    const { runId } = parseWith(RunParams, req.params);
    return wrapAction(() => ai.abort(runId, 'Stopped by you.'));
  });
  app.get('/api/test-bench/ai-run/:runId/session', async (req) => {
    const { runId } = parseWith(RunParams, req.params);
    return ai.sessionOf(runId) ?? { sessionId: null, workspaceId: null, flutterSessionId: null };
  });
  app.get('/api/test-bench/evidence/:runId/:file', async (req, reply) => {
    const p = parseWith(RunParams.extend({ file: z.string().regex(/^\d{3}\.png$/) }), req.params);
    return reply
      .type('image/png')
      .header('cache-control', 'private, max-age=86400')
      .send(createReadStream(join(evidenceDir, p.runId, p.file)));
  });

  // ── the agent's tools
  const live = (req: FastifyRequest) => {
    const { runId } = parseWith(RunParams, req.params);
    try {
      return ai.auth(runId, token(req));
    } catch {
      throw new HttpError(401, 'bad_run_token');
    }
  };
  app.get('/api/bench-run/:runId/context', async (req) => {
    const l = live(req);
    return wrapAction(() => ai.context(l));
  });
  app.get('/api/bench-run/:runId/screenshot', async (req, reply) => {
    const l = live(req);
    const png = await wrapAction(() => ai.screenshot(l));
    return reply.type('image/png').header('cache-control', 'no-store').send(png);
  });
  app.get('/api/bench-run/:runId/observe', async (req) => {
    const l = live(req);
    return wrapAction(() => ai.observe(l));
  });
  app.post('/api/bench-run/:runId/act', async (req) => {
    const l = live(req);
    return wrapAction(() => ai.act(l, parseWith(BenchActSchema, req.body)));
  });
  app.post('/api/bench-run/:runId/assert', async (req) => {
    const l = live(req);
    const b = parseWith(
      z.object({ text: z.string().min(1).max(200), visible: z.boolean() }).strict(),
      req.body,
    );
    return wrapAction(() => ai.assertText(l, b.text, b.visible));
  });
  app.post('/api/bench-run/:runId/next', async (req) => {
    const l = live(req);
    return wrapAction(() => ai.nextAc(l));
  });
  app.post('/api/bench-run/:runId/note', async (req) => {
    const l = live(req);
    const { note } = parseWith(z.object({ note: z.string().min(3).max(300) }).strict(), req.body);
    return wrapAction(() => ai.rememberNote(l, note));
  });
  app.get('/api/bench-run/:runId/figma/:acKey', async (req, reply) => {
    const l = live(req);
    const { acKey } = parseWith(
      RunParams.extend({ acKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }),
      req.params,
    );
    const png = await wrapAction(() => ai.figmaFrame(l, acKey));
    return reply.type('image/png').send(png);
  });
  app.post('/api/bench-run/:runId/mark', async (req) => {
    const l = live(req);
    const b = parseWith(
      z
        .object({
          target: z.string().regex(/^(ac|finding):[A-Za-z0-9_-]{1,80}$/),
          state: z.enum(['pass', 'fail', 'blocked']),
          note: z.string().min(1).max(1000),
        })
        .strict(),
      req.body,
    );
    return wrapAction(() => ai.mark(l, b.target, b.state, b.note));
  });
  app.post('/api/bench-run/:runId/finding', async (req) => {
    const l = live(req);
    return wrapAction(() => ai.finding(l, parseWith(FindingInputSchema, req.body)));
  });
  app.post('/api/bench-run/:runId/human', async (req) => {
    const l = live(req);
    const { reason } = parseWith(
      z.object({ reason: z.string().min(3).max(500) }).strict(),
      req.body,
    );
    const helped = await wrapAction(() => ai.askHuman(l, reason));
    return { helped };
  });
  app.post('/api/bench-run/:runId/finish', async (req) => {
    const l = live(req);
    const { summary, blockRest } = parseWith(
      z
        .object({
          summary: z.string().max(8000).default(''),
          blockRest: z.string().min(3).max(500).nullable().default(null),
        })
        .strict(),
      req.body,
    );
    return wrapAction(() => ai.finish(l, summary, blockRest));
  });
}
