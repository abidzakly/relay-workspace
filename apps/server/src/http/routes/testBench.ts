import type { FastifyInstance } from 'fastify';
import {
  BranchNameSchema,
  FindingInputSchema,
  FindingPatchSchema,
  FinishRunSchema,
  RepoIdSchema,
  SetCheckSchema,
} from '@relay/shared';
import { z } from 'zod';
import type { TestBenchService } from '../../services/testBench/testBench';
import type { FigmaService } from '../../services/figma/figmaService';
import type { TestBenchFlow } from '../../services/testBench/flow';
import { HttpError, parseWith, wrapAction } from '../errors';

/**
 * Test Bench routes. Private dashboard listener only, registered next to the cockpit routes.
 * Writes are local to this app (no Notion, no GitLab), so they need no dry-run gate.
 */

const BranchQuery = z.object({
  repo: RepoIdSchema,
  branch: BranchNameSchema,
  refresh: z.enum(['0', '1']).optional(),
});
const BranchBody = z.object({ repo: RepoIdSchema, branch: BranchNameSchema });
const IdParams = z.object({ id: z.string().uuid() });

const FigmaFile = z.object({
  file: z.string().regex(/^[A-Za-z0-9]{10,64}$/),
  refresh: z.enum(['0', '1']).optional(),
});
const FigmaNode = FigmaFile.extend({ node: z.string().regex(/^\d+:\d+$/) });

export function registerTestBenchRoutes(
  app: FastifyInstance,
  bench: TestBenchService,
  figma?: FigmaService,
  flow?: TestBenchFlow,
): void {
  app.post('/api/test-bench/fix', async (req) => {
    const b = parseWith(
      BranchBody.extend({ findingIds: z.array(z.string().uuid()).max(50).optional() }).strict(),
      req.body,
    );
    if (!flow) throw new HttpError(503, 'cockpit_unavailable');
    return wrapAction(() => flow.fixWithAi(b.repo, b.branch, b.findingIds));
  });

  app.get('/api/figma/status', async () =>
    figma ? figma.status() : { bridge: 'down', files: [], error: 'Figma is not available.' },
  );
  app.get('/api/figma/frames', async (req) => {
    const q = parseWith(FigmaFile, req.query);
    if (!figma)
      return {
        fileKey: q.file,
        fileName: q.file,
        lastModified: null,
        frames: [],
        truncated: false,
      };
    return wrapAction(() => figma.frames(q.file, { force: q.refresh === '1' }));
  });
  app.get('/api/figma/image', async (req, reply) => {
    const q = parseWith(FigmaNode, req.query);
    if (!figma) return reply.code(409).send({ error: 'figma_not_configured' });
    const png = await wrapAction(() => figma.image(q.file, q.node, { force: q.refresh === '1' }));
    return reply.type('image/png').header('cache-control', 'private, max-age=300').send(png);
  });

  app.get('/api/test-bench/open', async () => wrapAction(() => bench.openBenches()));
  app.post('/api/test-bench/open/dismiss', async (req) => {
    const b = parseWith(BranchBody.strict(), req.body);
    bench.dismissBench(b.repo, b.branch);
    return { ok: true as const };
  });

  app.get('/api/test-bench', async (req) => {
    const q = parseWith(BranchQuery, req.query);
    return wrapAction(() => bench.state(q.repo, q.branch, { refresh: q.refresh === '1' }));
  });

  app.put('/api/test-bench/check', async (req) => {
    const b = parseWith(BranchBody.extend(SetCheckSchema.shape).strict(), req.body);
    return wrapAction(() => bench.setCheck(b.repo, b.branch, b));
  });

  app.post('/api/test-bench/findings', async (req) => {
    const b = parseWith(BranchBody.extend({ finding: FindingInputSchema }).strict(), req.body);
    return wrapAction(async () => bench.addFinding(b.repo, b.branch, b.finding));
  });
  app.patch('/api/test-bench/findings/:id', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    const patch = parseWith(FindingPatchSchema.strict(), req.body);
    return wrapAction(async () => bench.updateFinding(id, patch));
  });
  app.delete('/api/test-bench/findings/:id', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return wrapAction(async () => {
      bench.deleteFinding(id);
      return { ok: true };
    });
  });

  app.put('/api/test-bench/figma', async (req) => {
    const b = parseWith(
      BranchBody.extend({ url: z.string().url().max(2000).nullable() }).strict(),
      req.body,
    );
    return wrapAction(async () => {
      bench.setFigmaOverride(b.repo, b.branch, b.url);
      return { ok: true };
    });
  });
  app.put('/api/test-bench/frame', async (req) => {
    const b = parseWith(
      BranchBody.extend({
        acKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        nodeId: z.string().max(40).nullable(),
      }).strict(),
      req.body,
    );
    return wrapAction(async () => {
      bench.setFrame(b.repo, b.branch, b.acKey, b.nodeId);
      return { ok: true };
    });
  });

  app.post('/api/test-bench/finish', async (req) => {
    const b = parseWith(BranchBody.extend(FinishRunSchema.shape).strict(), req.body);
    return wrapAction(() => bench.finish(b.repo, b.branch, b.verdict, b.summary));
  });
  app.post('/api/test-bench/runs/:id/abort', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    return wrapAction(async () => bench.abortRun(id));
  });
}
