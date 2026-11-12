import type { FastifyInstance } from 'fastify';
import type { AiService } from '../../services/ai/aiService';
import { AiError } from '../../services/ai/provider';
import { CockpitHostError, type CockpitHost } from '../../services/cockpit/host';
import {
  DeckExplainRequestSchema,
  DeckGradeRequestSchema,
  DeckOpenRequestSchema,
  DeckRequestChangeRequestSchema,
  DeckStateSaveRequestSchema,
  BranchNameSchema,
  DISCUSSION_ID_RE,
  MrChatRequestSchema,
  MrCreateRequestSchema,
  WorkspaceCreateSchema,
  WorkspaceIdSchema,
  WsFileWriteSchema,
  SessionInputSchema,
  SessionResizeSchema,
  SessionStartSchema,
  RepoIdSchema,
} from '@relay/shared';
import { z } from 'zod';
import type { ReviewDeckService } from '../../services/deck/reviewDeck';
import type { MrCreateService } from '../../services/mrCreate';
import type { ReadyForMrService } from '../../services/readyForMr';
import type { WorkspaceService } from '../../services/cockpit/workspaces';
import type { CockpitSessionService } from '../../services/cockpit/sessionService';
import type { CockpitWorkflowService } from '../../services/cockpit/workflow';
import { ActionError } from '../../services/actionError';
import type { CleanupService } from '../../services/cleanup/cleanupService';
import { registerCockpitStream } from '../cockpitStream';
import type { TestBenchService } from '../../services/testBench/testBench';
import type { TestBenchFlow } from '../../services/testBench/flow';
import { registerTestBenchRoutes } from './testBench';
import type { DeviceHost } from '../../services/device/deviceHost';
import type { FigmaService } from '../../services/figma/figmaService';
import type { AiRunService } from '../../services/testBench/aiRun';
import { registerBenchRunRoutes } from './benchRun';
import { registerDeviceRoutes } from './devices';
import { HttpError, parseWith, wrapAction } from '../errors';

/**
 * Mobile Dev Cockpit routes. PRIVATE dashboard listener only (127.0.0.1 / Tailscale with
 * `Tailscale-User-Login` checked by `installSecurity`): never registered on the webhook/ngrok app. Grows per phase.
 */

export interface CockpitDeps {
  host: CockpitHost;
  ai: AiService;
  decks: ReviewDeckService;
  ready: ReadyForMrService;
  mrCreate: MrCreateService;
  workspaces: WorkspaceService;
  sessions: CockpitSessionService;
  workflow: CockpitWorkflowService;
  /** Storage cleanup (no AI). */
  cleanup?: CleanupService;
  testBench?: TestBenchService;
  testBenchFlow?: TestBenchFlow;
  devices?: DeviceHost;
  figma?: FigmaService;
  aiRun?: AiRunService;
  evidenceDir?: string;
}

const CardStartBody = z
  .object({
    cardId: z.string().min(1).max(64),
    workspaceId: WorkspaceIdSchema,
    base: z.string().min(1).max(255),
    agent: z.enum(['claude', 'cursor']).nullable(),
    replace: z.boolean().optional(),
    /** The card's branch already exists: `replace` resets it to the base, `reuse` checks it out as it is. */
    existing: z.enum(['replace', 'reuse']).optional(),
    /** Bulk start: a busy workspace gives the card a git worktree of its own. */
    worktree: z.literal('auto').optional(),
    /** The user's own instructions for the agent, on top of the card. */
    extraPrompt: z.string().max(8_000).optional(),
    /** Figma node links for the agent (space or newline separated), on top of the card's own. */
    figmaUrl: z.string().max(4_000).optional(),
    /** Files for the agent to open (images included): base64, 5 MB each once decoded. */
    attachments: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            dataBase64: z.string().min(1).max(7_000_000),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

const CardParams = z.object({ cardId: z.string().min(1).max(64) });
const CleanupApplyBody = z
  .object({ ids: z.array(z.string().min(1).max(600)).min(1).max(2_000) })
  .strict();
const CardContentQuery = z.object({ force: z.enum(['1']).optional() });

const BaseSuggestBody = z
  .object({ cardId: z.string().min(1).max(64), workspaceId: WorkspaceIdSchema })
  .strict();

const ThreadAgentBody = z
  .object({
    repoId: RepoIdSchema,
    iid: z.number().int().positive(),
    discussionId: z.string().regex(DISCUSSION_ID_RE),
    mode: z.enum(['review', 'fix']),
    /** Unset = Settings' coding agent / plan model. */
    agent: z.enum(['claude', 'cursor']).optional(),
    model: z
      .string()
      .regex(/^[a-z0-9.-]{1,64}$/i)
      .optional(),
  })
  .strict();

const ThreadExplainBody = z
  .object({
    repoId: RepoIdSchema,
    iid: z.number().int().positive(),
    discussionId: z.string().regex(DISCUSSION_ID_RE),
    /** Extra context from the user: free text, may contain links. */
    context: z.string().max(8_000).optional(),
  })
  .strict();

const SessionParams = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/) });
const EmuParams = z.object({
  id: WorkspaceIdSchema,
  emu: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
});

const WsParams = z.object({ id: WorkspaceIdSchema });
const CleanTreeBody = z.object({ mode: z.enum(['stash', 'discard']) }).strict();
const DiffQuery = z.object({
  mode: z.enum(['working', 'branch', 'turn']).default('working'),
  base: z.string().max(200).optional(),
});
const FileQuery = z.object({ path: z.string().min(1).max(1024) });

const PreviewQuery = z.object({ repo: RepoIdSchema, branch: BranchNameSchema });

const DeckParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) });

const AI_STATUS: Record<AiError['code'], number> = {
  ai_unavailable: 409,
  ai_bad_output: 502,
  ai_failed: 502,
  ai_refused: 422,
};

/** AI / host failures → uniform HTTP errors (messages are secret-free by construction). */
export async function wrapCockpit<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiError) throw new HttpError(AI_STATUS[e.code], e.code, e.message);
    if (e instanceof CockpitHostError) throw new HttpError(e.status, e.code, e.message, e.details);
    throw e;
  }
}

const run = <T>(fn: () => Promise<T> | T) => wrapAction(() => wrapCockpit(async () => fn()));

export function registerCockpitRoutes(app: FastifyInstance, deps: CockpitDeps): void {
  if (deps.testBench) registerTestBenchRoutes(app, deps.testBench, deps.figma, deps.testBenchFlow);
  if (deps.devices) registerDeviceRoutes(app, deps.devices);
  if (deps.aiRun && deps.evidenceDir) registerBenchRunRoutes(app, deps.aiRun, deps.evidenceDir);
  app.get('/api/ai/status', async () => deps.ai.status());
  // Real round trips: not read-only in cost (a few tokens), changes no configuration, so no audit row.
  app.post('/api/ai/test', async () => deps.ai.test());
  app.get('/api/cockpit/health', async () => wrapCockpit(() => deps.host.health()));

  // ── Workspaces: directories on the Mac; the host re-validates every path
  const ws = deps.workspaces;
  app.get('/api/cockpit/workspaces', async () => ({ items: ws.list() }));
  app.post('/api/cockpit/workspaces', async (req) => {
    const body = parseWith(WorkspaceCreateSchema, req.body);
    return run(() => ws.add(body));
  });
  app.delete('/api/cockpit/workspaces/:id', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => {
      ws.remove(id);
      return { ok: true };
    });
  });
  app.get('/api/cockpit/ws/:id/status', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => deps.host.wsStatus(ws.ref(id)));
  });
  app.get('/api/cockpit/ws/:id/diff', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    const q = parseWith(DiffQuery, req.query);
    return run(() => {
      const w = ws.get(id);
      return deps.host.wsDiff(
        ws.ref(id),
        q.mode,
        q.mode === 'branch' ? (q.base ?? w.defaultBase) : q.base,
      );
    });
  });
  app.get('/api/cockpit/ws/:id/tree', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => deps.host.wsTree(ws.ref(id)));
  });
  app.get('/api/cockpit/ws/:id/file', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    const { path } = parseWith(FileQuery, req.query);
    return run(async () => ({ path, ...(await deps.host.wsReadFile(ws.ref(id), path)) }));
  });
  app.put('/api/cockpit/ws/:id/file', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const { id } = parseWith(WsParams, req.params);
    const b = parseWith(WsFileWriteSchema, req.body);
    return run(() => deps.host.wsWriteFile(ws.ref(id), b.path, b.content, b.expectedHash));
  });
  app.post('/api/cockpit/ws/:id/clean-tree', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    const { mode } = parseWith(CleanTreeBody, req.body);
    return run(() => deps.workflow.cleanTree(id, mode));
  });
  app.post('/api/cockpit/ws/:id/checkpoint', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => deps.host.wsCheckpoint(ws.ref(id)));
  });

  // ── Sessions: agent / terminal / flutter run
  const ss = deps.sessions;
  app.get('/api/cockpit/sessions', async () => run(async () => ({ items: await ss.list() })));
  app.post('/api/cockpit/sessions', async (req) => {
    const b = parseWith(SessionStartSchema, req.body);
    return run(() => ss.start(b));
  });
  app.post('/api/cockpit/sessions/:id/input', async (req) => {
    const { id } = parseWith(SessionParams, req.params);
    const { data } = parseWith(SessionInputSchema, req.body);
    return run(async () => {
      await ss.input(id, data);
      return { ok: true };
    });
  });
  app.post('/api/cockpit/sessions/:id/prompt', async (req) => {
    const { id } = parseWith(SessionParams, req.params);
    const { data } = parseWith(SessionInputSchema, req.body);
    return run(() => ss.prompt(id, data));
  });
  app.post('/api/cockpit/sessions/:id/resize', async (req) => {
    const { id } = parseWith(SessionParams, req.params);
    const r = parseWith(SessionResizeSchema, req.body);
    return run(async () => {
      await ss.resize(id, r.cols, r.rows);
      return { ok: true };
    });
  });
  app.post('/api/cockpit/sessions/:id/kill', async (req) => {
    const { id } = parseWith(SessionParams, req.params);
    return run(async () => {
      await ss.kill(id);
      return { ok: true };
    });
  });
  registerCockpitStream(app, { host: deps.host });
  app.get('/api/cockpit/ws/:id/devices', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(async () => ({ items: await deps.host.flutterDevices(ws.ref(id)) }));
  });
  app.get('/api/cockpit/ws/:id/run-targets', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => deps.host.flutterRunTargets(ws.ref(id)));
  });
  app.post('/api/cockpit/ws/:id/emulators/:emu/launch', async (req) => {
    const { id, emu } = parseWith(EmuParams, req.params);
    return run(async () => {
      await deps.host.flutterLaunchEmulator(ws.ref(id), emu);
      return { ok: true };
    });
  });

  // ── attention inbox, integrity gate, card start
  app.get('/api/cockpit/attention', async () => run(() => deps.workflow.attention()));
  app.post('/api/cockpit/ws/:id/integrity', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => deps.host.wsIntegrity(ws.ref(id)));
  });
  app.get('/api/cockpit/ws/:id/bases', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    return run(() => ({ items: deps.workflow.bases(id) }));
  });
  // 10 files × 5 MB, base64 (+1/3) and JSON overhead.
  app.post('/api/cockpit/card-start', { bodyLimit: 72 * 1024 * 1024 }, async (req) => {
    const b = parseWith(CardStartBody, req.body);
    return run(() => deps.workflow.cardStart(b));
  });
  // Storage cleanup: scan writes nothing; apply re-scans and removes only ids that still match a rule.
  app.get('/api/cockpit/cleanup/last', async () =>
    run(() => ({ result: deps.cleanup?.lastResult() ?? null })),
  );
  app.post('/api/cockpit/cleanup/scan', async () =>
    run(() => {
      if (!deps.cleanup) throw new ActionError(404, 'not_available', 'Cleanup is not available.');
      return deps.cleanup.scan();
    }),
  );
  app.post('/api/cockpit/cleanup/apply', async (req) => {
    const b = parseWith(CleanupApplyBody, req.body);
    return run(() => {
      if (!deps.cleanup) throw new ActionError(404, 'not_available', 'Cleanup is not available.');
      return deps.cleanup.apply(b.ids);
    });
  });
  app.get('/api/cockpit/card-content/:cardId', async (req) => {
    const { cardId } = parseWith(CardParams, req.params);
    const q = parseWith(CardContentQuery, req.query);
    return run(() => deps.workflow.cardContentPreview(cardId, { force: q.force === '1' }));
  });
  app.post('/api/cockpit/base-suggest', async (req) => {
    const b = parseWith(BaseSuggestBody, req.body);
    return run(() => deps.workflow.suggestBase(b));
  });
  app.post('/api/cockpit/thread-agent', async (req) => {
    const b = parseWith(ThreadAgentBody, req.body);
    return run(() => deps.workflow.threadAgent(b));
  });
  app.post('/api/cockpit/thread-explain', async (req) => {
    const b = parseWith(ThreadExplainBody, req.body);
    return run(() => deps.workflow.threadExplain(b));
  });

  // ── Ready for MR + Create MR
  app.get('/api/cockpit/ready', async () => ({ items: deps.ready.list() }));
  app.post('/api/cockpit/ready/refresh', async () => {
    await deps.ready.poll();
    return { items: deps.ready.list() };
  });
  app.get('/api/mr-create/preview', async (req) => {
    const q = parseWith(PreviewQuery, req.query);
    return run(() => deps.mrCreate.preview(q.repo, q.branch));
  });
  app.post('/api/mr-create/summary', async (req) => {
    const q = parseWith(PreviewQuery, req.body);
    return run(() => deps.mrCreate.summary(q.repo, q.branch));
  });
  app.post('/api/mr-create/chat', async (req) => {
    const body = parseWith(MrChatRequestSchema, req.body);
    return run(() => deps.mrCreate.chat(body));
  });
  app.post('/api/mr-create', async (req) => {
    const body = parseWith(MrCreateRequestSchema, req.body);
    return run(() => deps.mrCreate.create(body));
  });

  // ── Review Deck
  app.post('/api/deck/open', async (req) => {
    const { source, rebuild } = parseWith(DeckOpenRequestSchema, req.body);
    return run(() => deps.decks.open(source, { rebuild }));
  });
  app.put('/api/deck/:id/state', async (req) => {
    const { id } = parseWith(DeckParams, req.params);
    const { diffSha, ...patch } = parseWith(DeckStateSaveRequestSchema, req.body);
    return run(() => deps.decks.saveState(id, patch, diffSha));
  });
  app.post('/api/deck/:id/explain', async (req) => {
    const { id } = parseWith(DeckParams, req.params);
    const b = parseWith(DeckExplainRequestSchema, req.body);
    return run(() => deps.decks.explain(id, b));
  });
  app.post('/api/deck/:id/grade', async (req) => {
    const { id } = parseWith(DeckParams, req.params);
    const b = parseWith(DeckGradeRequestSchema, req.body);
    return run(() => deps.decks.grade(id, b.cardId, b.answer));
  });
  app.post('/api/deck/:id/request-change', async (req) => {
    const { id } = parseWith(DeckParams, req.params);
    const b = parseWith(DeckRequestChangeRequestSchema, req.body);
    return run(() => deps.decks.requestChange(id, b.noteIds, b.send));
  });
  app.get('/api/deck/:id/status', async (req) => {
    const { id } = parseWith(DeckParams, req.params);
    return run(() => deps.decks.status(id));
  });
  app.post('/api/deck/:id/complete', async (req) => {
    const { id } = parseWith(DeckParams, req.params);
    return run(() => deps.decks.complete(id));
  });
}
