import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuditWriter } from './audit/auditLog';
import { SecretBox } from './config/crypto';
import {
  findRepoRoot,
  loadEnv,
  parseBuildPassEnv,
  parseTlsHosts,
  parseTlsUsers,
  resolveDataDir,
} from './config/env';
import { ConfigStore } from './config/store';
import { openDatabase, runMigrations } from './db';
import { mrs } from './db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { buildDashboardApp } from './http/dashboardApp';
import { loadPresets } from './config/presets';
import { moveLegacyDirs } from './config/legacyDirs';
import { listenDashboard, listenWebhook } from './http/listen';
import { buildWebhookApp } from './http/webhookApp';
import { ReviewDeskService } from './services/reviewDesk';
import { normalizeWebhook } from './services/webhookEvents';
import { BuildQueue } from './services/buildQueue';
import { CardActions } from './services/cardActions';
import { CloneManager } from './services/cloneManager';
import { SigningFiles } from './services/signingFiles';
import { DriveService } from './services/driveService';
import {
  HostAgentClient,
  RemoteGitExec,
  RemotePtyBackend,
  RemoteScriptEnvWriter,
} from './hostAgent/client';
import { LocalScriptEnvWriter, ScriptConfigService } from './services/scriptConfig';
import { AiService } from './services/ai/aiService';
import { MrCreateService } from './services/mrCreate';
import { TestBenchService } from './services/testBench/testBench';
import { TestBenchFlow } from './services/testBench/flow';
import { AiRunService } from './services/testBench/aiRun';
import { DeviceBridge } from './services/device/deviceBridge';
import { LocalDeviceHost, RemoteDeviceHost } from './services/device/deviceHost';
import { McpFigmaBridge } from './services/figma/bridgeClient';
import { RemoteFigmaBridge } from './services/figma/remoteBridge';
import { FigmaService } from './services/figma/figmaService';
import { FigmaSnapshotStore } from './services/figma/snapshotStore';
import { ReadyForMrService } from './services/readyForMr';
import { createCommitReader, createDiffReader } from './services/deck/diffSources';
import { ReviewDeckService } from './services/deck/reviewDeck';
import { LocalCockpitHost } from './services/cockpit/localHost';
import { RemoteCockpitHost } from './services/cockpit/remoteHost';
import { WorkspaceService } from './services/cockpit/workspaces';
import { CockpitSessionService } from './services/cockpit/sessionService';
import { CleanupService } from './services/cleanup/cleanupService';
import { recordAttachments } from './services/cockpit/attachmentStore';
import { CardContentService } from './services/cockpit/cardContent';
import { CockpitWorkflowService } from './services/cockpit/workflow';
import { defaultClonesRoot, GitExec } from './services/gitExec';
import { GamificationService } from './services/gamificationService';
import { HttpClient } from './services/httpClient';
import { NtfyChannel, resolveNtfy } from './services/ntfyChannel';
import { KpiService } from './services/kpiService';
import { NotionService } from './services/notionService';
import { NotificationCenter } from './services/notificationCenter';
import { TokenIdentity } from './services/tokenIdentity';
import { Notifier } from './services/notifier';
import { PushService, resolveVapid } from './services/pushService';
import { ReleaseEngine } from './services/releaseEngine';
import { createReleaseHooks } from './services/releasePipeline';
import { ShareService } from './services/share';
import { WebhookProcessor } from './services/webhookProcessor';
import { auditToBus } from './sync/auditEvents';
import { EventBus } from './sync/eventBus';
import { Poller } from './sync/poller';
import { SyncEngine } from './sync/syncEngine';
import { createLogger } from './util/logger';

/**
 * Boots: DB + migrations -> config store (needs MASTER_KEY) -> private dashboard (127.0.0.1:3000)
 * and public webhook listener (:3001, POST /webhook/:repoId only).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV !== 'production' && process.stdout.isTTY,
  });
  moveLegacyDirs(log);

  let box: SecretBox;
  try {
    box = SecretBox.fromEnv(env.MASTER_KEY);
  } catch (e) {
    log.fatal(
      { reason: (e as Error).message },
      "invalid MASTER_KEY. Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" and put it in .env",
    );
    process.exit(1);
  }

  const dbFile = join(resolveDataDir(env), 'app.db');
  const app = openDatabase(dbFile);
  runMigrations(app);
  const presets = loadPresets(findRepoRoot(), log);
  const store = new ConfigStore(app, box, Date.now, presets.global);
  // One in-process bus: engine + webhooks + audit emit into it, `GET /api/events` (SSE) forwards it.
  const bus = new EventBus(log);
  const audit = new AuditWriter(app, auditToBus(bus));

  // One outbound client, one engine + poller.
  const http = new HttpClient({ log });
  // Which GitLab user each repo token posts as: those notes count as mine.
  const tokenIdentity = new TokenIdentity({ config: store, http, log });
  const engine = new SyncEngine({ config: store, store: app, http, log, bus });
  const poller = new Poller({ engine, log });
  // Notifications: Web Push (VAPID from .env) + optional ntfy fallback behind one channel interface.
  const ntfy = new NtfyChannel(resolveNtfy(env), http, log);
  const push = new PushService({
    store: app,
    log,
    vapid: resolveVapid(env),
    otherChannels: () => [{ name: ntfy.name, configured: ntfy.isConfigured() }],
  });
  const notifier = new Notifier({ config: store, store: app, bus, channels: [push, ntfy], log });
  notifier.watchHealth();
  // Webhook intake: dedupe + async cache updates + debounced engine.refreshNow.
  // "Ready for MR": pushes from the webhook, a branch poll as fallback.
  const ready = new ReadyForMrService({ config: store, store: app, http, log, notifier, bus });
  // Reviews (the reviewer's desk): webhook first, a light to-do poll only for projects no webhook reaches.
  const reviewDesk = new ReviewDeskService({ config: store, http, log, audit, bus, notifier });
  const webhooks = new WebhookProcessor({
    config: store,
    store: app,
    engine,
    bus,
    log,
    notifier,
    onPush: (repoId, ev) => ready.onPush(repoId, ev),
    onEvent: (projectId, ev) => reviewDesk.onWebhook(projectId, ev),
  });
  const interrupted = webhooks.recoverInterrupted();
  if (interrupted > 0) log.warn({ interrupted }, 'webhook deliveries cut off by the last shutdown');
  // Release runs: a crash is recorded as failed, for the user to resume. Paused jobs simply stay paused.
  // One GitExec + CloneManager: its per-repo queue must see the release engine and the build queue alike.
  // In Docker, git/flutter/vu run on the Mac through the host agent; the clones are on the Mac's disk, mounted here.
  const agent = env.HOST_AGENT_URL
    ? new HostAgentClient({ url: env.HOST_AGENT_URL, token: env.HOST_AGENT_TOKEN ?? '', log })
    : null;
  const gitDeps = {
    log,
    clonesRoot: env.CLONES_DIR
      ? resolve(
          env.CLONES_DIR.startsWith('~/')
            ? join(homedir(), env.CLONES_DIR.slice(2))
            : env.CLONES_DIR,
        )
      : defaultClonesRoot(),
    auth: (repoId: string) => {
      const repo = store.getRepo(repoId);
      return repo ? { cloneUrl: repo.cloneUrl, token: repo.gitlab.token ?? null } : null;
    },
  };
  const git = agent ? new RemoteGitExec({ ...gitDeps, client: agent }) : new GitExec(gitDeps);
  if (agent)
    log.info(
      { url: agent.url, clonesRoot: gitDeps.clonesRoot },
      'git, flutter and vu run through the host agent',
    );
  const clones = new CloneManager(git);
  // Release scripts (tools/bin): settings from the dashboard, written where the scripts run.
  const scripts = new ScriptConfigService({
    config: store,
    log,
    bus,
    writer: agent ? new RemoteScriptEnvWriter(agent) : new LocalScriptEnvWriter(),
  });
  scripts.watch();
  void scripts.writeFile();
  const release = new ReleaseEngine({
    scripts,
    config: store,
    store: app,
    audit,
    http,
    log,
    bus,
    git,
    clones,
    ...(agent
      ? { ptyBackend: new RemotePtyBackend(agent, (id) => store.getRepo(id)?.cloneUrl ?? null) }
      : {}),
  });
  const cutOff = release.recoverInterrupted();
  if (cutOff > 0) log.warn({ cutOff }, 'release jobs cut off by the last shutdown');
  // Builds.
  const builds = new BuildQueue({
    config: store,
    jobs: release.jobs,
    git,
    clones,
    log,
    bus,
    apksDir: join(resolveDataDir(env), 'apks'),
    timeoutMs: env.BUILD_TIMEOUT_MIN * 60 * 1000,
    // `loadEnv` has refused a list this would reject.
    passEnv: parseBuildPassEnv(env.BUILD_PASS_ENV) ?? [],
  });
  const buildsCutOff = builds.recoverInterrupted();
  if (buildsCutOff > 0) log.warn({ buildsCutOff }, 'build jobs cut off by the last shutdown');
  // Drive upload + Share to QA.
  const share = new ShareService({
    config: store,
    builds,
    jobs: release.jobs,
    drive: new DriveService({ config: store, baseDir: findRepoRoot(), log }),
    audit,
    store: app,
    notifier,
    bus,
    log,
  });
  // Card writes, shared by the routes and a release's NOTION step so both respect one write lock per card.
  const cardActions = new CardActions({
    config: store,
    audit,
    store: app,
    notion: NotionService.fromConfig(store, { http, store: app, log }),
    log,
    bus,
  });
  // A release's BUILD .. DONE. Nothing can run yet: no request is accepted before this line.
  release.useHooks(
    createReleaseHooks({
      config: store,
      jobs: release.jobs,
      builds,
      share,
      cards: cardActions,
      bus,
    }),
  );

  // KPI: scorecards, month-end freeze, SLA and research pushes.
  const kpi = new KpiService({
    config: store,
    store: app,
    audit,
    notifier,
    bus,
    syncStatus: () => poller.status(),
    log,
  });

  // XP, streaks and badges, reconciled from the cache after each sync.
  const gamification = new GamificationService({
    config: store,
    store: app,
    kpi,
    bus,
    syncStatus: () => poller.status(),
    log,
  });
  gamification.start();

  // Mobile Dev Cockpit: local host, or the Mac through the agent in Docker. AI = Claude CLI, API key as fallback.
  const cockpitHost = agent ? new RemoteCockpitHost(agent) : new LocalCockpitHost({ log });
  const ai = new AiService({
    store: app,
    log,
    host: cockpitHost,
    apiKey: env.ANTHROPIC_API_KEY,
    models: () => store.getGlobalStored().aiModels,
    prompts: () => store.getGlobalStored().aiPrompts,
  });
  const workspaces = new WorkspaceService({ store: app, config: store, host: cockpitHost, bus });
  const sessions = new CockpitSessionService({
    host: cockpitHost,
    workspaces,
    log,
    bus,
    notifier,
    ai,
    preferredAgent: () => store.getGlobalStored().agentPreference,
    agentModels: () => store.getGlobalStored().agentModels,
  });
  // In Docker the bridge runs on the Mac, inside `pnpm agent`; the dashboard asks the agent for it.
  const figmaBridge = agent
    ? new RemoteFigmaBridge(agent)
    : new McpFigmaBridge({ command: env.FIGMA_BRIDGE_CMD, log });
  const figmaSnapshots = new FigmaSnapshotStore(resolveDataDir(env));
  const figma = new FigmaService({
    bridge: figmaBridge,
    cacheDir: join(resolveDataDir(env), 'figma'),
    snapshots: figmaSnapshots,
  });
  const workflow = new CockpitWorkflowService({
    store: app,
    host: cockpitHost,
    workspaces,
    sessions,
    ready,
    config: store,
    http,
    log,
    ai,
    cardContent: new CardContentService({
      notion: NotionService.fromConfig(store, { http, store: app, log }),
      store: app,
      http,
      log,
    }),
    figma,
    figmaSnapshots,
    onAttachments: (a) => recordAttachments(app, a),
  });
  const decks = new ReviewDeckService({
    store: app,
    log,
    ai,
    readDiff: createDiffReader({
      config: store,
      cache: app,
      http,
      log,
      localDiff: (source) => workspaces.localDiff(source),
      workspaceForRepo: (repoId) => workspaces.forRepo(repoId),
      branchHeads: (repoId) => ready.branchHeads(repoId),
    }),
    readCommits: createCommitReader({ config: store, cache: app, http, log }),
    award: (deckId, diffSha, issues) => gamification.awardReviewDeck(deckId, diffSha, issues),
    sendToAgent: (workspaceId, prompt) => sessions.sendToAgent(workspaceId, prompt),
    prepareAgentBranch: (source) => workflow.prepareDeckBranch(source),
    localBranch: async (workspaceId) => {
      const w = workspaces.get(workspaceId);
      if (!w.repoId) return null;
      const st = await cockpitHost.wsStatus({ path: w.absPath, wsId: w.id });
      if (!st.branch || st.branch === w.defaultBase) return null;
      return { repoId: w.repoId, branch: st.branch, head: st.head };
    },
    repoOfWorkspace: (workspaceId) => {
      try {
        return workspaces.get(workspaceId).repoId ?? null;
      } catch {
        return null;
      }
    },
    onLocalReviewed: (workspaceId, base) => sessions.markTurnReviewed(workspaceId, base),
    openMrOf: (repoId, branch) =>
      app.db
        .select({ iid: mrs.iid })
        .from(mrs)
        .where(
          and(
            eq(mrs.repoId, repoId),
            eq(mrs.sourceBranch, branch),
            inArray(mrs.state, ['opened', 'locked']),
          ),
        )
        .get()?.iid ?? null,
  });
  // HEAD of a branch: a workspace that has it checked out, else the last pushed sha.
  const headOf = async (repoId: string, branch: string): Promise<string | null> => {
    for (const w of workspaces.list().filter((x) => x.repoId === repoId)) {
      const st = await cockpitHost.wsStatus({ path: w.absPath, wsId: w.id }).catch(() => null);
      if (st?.branch === branch && st.head) return st.head;
    }
    return ready.branchHeads(repoId).find((h) => h.branch === branch)?.sha ?? null;
  };
  // The flow needs the bench and the bench reads commits through the flow: bound late.
  let benchFlow: TestBenchFlow | null = null;
  const testBench = new TestBenchService({
    store: app,
    config: store,
    notion: NotionService.fromConfig(store, { http, store: app, log }),
    headOf,
    localCommits: (repoId, branch) =>
      benchFlow?.localCommits(repoId, branch) ?? Promise.resolve(null),
    bus,
  });
  benchFlow = new TestBenchFlow({
    bench: testBench,
    config: store,
    host: cockpitHost,
    workspaces,
    prepareBranch: (repoId, branch, base) =>
      workflow.prepareDeckBranch({ kind: 'compare', repoId, from: base, to: branch }),
    sendToAgent: (workspaceId, prompt, opts) => sessions.sendToAgent(workspaceId, prompt, opts),
    hasOpenMr: (repoId, branch) => ready.hasOpenMr(repoId, branch),
    evidenceDir: join(resolveDataDir(env), 'testbench'),
    onAttachment: (a) =>
      recordAttachments(app, {
        group: a.group,
        workspaceId: a.workspaceId,
        kind: 'finding',
        refId: a.findingId,
      }),
  });
  // The phone is plugged into the Mac: through the agent in Docker, in-process otherwise.
  const devices = agent
    ? new RemoteDeviceHost(agent)
    : new LocalDeviceHost(
        new DeviceBridge({ log, scrcpyDir: join(resolveDataDir(env), 'scrcpy') }),
      );
  const evidenceDir = join(resolveDataDir(env), 'testbench');
  const cleanup = new CleanupService({
    store: app,
    config: store,
    host: cockpitHost,
    workspaces,
    sessions,
    audit,
    log,
    dataDir: resolveDataDir(env),
    clonesRoot: gitDeps.clonesRoot,
  });
  const aiRun = new AiRunService({
    bench: testBench,
    config: store,
    host: cockpitHost,
    workspaces,
    sessions,
    devices,
    figma,
    notifier,
    prepareBranch: (repoId, branch, base) =>
      workflow.prepareDeckBranch({ kind: 'compare', repoId, from: base, to: branch }),
    // The agent's Claude session runs on the Mac, where the dashboard is published on loopback.
    benchUrl: `http://127.0.0.1:${env.DASHBOARD_PORT}`,
    evidenceDir,
    log,
  });
  const dashboard = await buildDashboardApp({
    reviewDesk,
    scripts,
    cockpit: {
      testBench,
      testBenchFlow: benchFlow,
      devices,
      figma,
      aiRun,
      evidenceDir,
      host: cockpitHost,
      ai,
      decks,
      ready,
      workspaces,
      sessions,
      workflow,
      cleanup,
      mrCreate: new MrCreateService({
        config: store,
        store: app,
        audit,
        http,
        log,
        bus,
        branchHeads: (repoId) => ready.branchHeads(repoId),
        ai,
        deckReview: (source, diff) => decks.branchReview(source, diff),
        testGate: (repoId, branch) => testBench.gate(repoId, branch),
        squash: (repoId, branch, parent) => benchFlow!.squashForMr(repoId, branch, parent),
        markCompleted: (cardId) => cardActions.markCompleted(cardId),
      }),
    },
    store,
    audit,
    log,
    http,
    tokenIdentity,
    cache: app,
    bus,
    push,
    notifier,
    notifications: new NotificationCenter({
      config: store,
      store: app,
      bus,
      log,
      kpi,
      ready,
      sessions,
    }),
    release,
    builds,
    share,
    signing: new SigningFiles({ config: store, git, jobs: release.jobs, audit, log }),
    cardActions,
    kpi,
    gamification,
    getSyncStatus: () => poller.status(),
    refreshSync: () => engine.refreshNow(),
    port: env.DASHBOARD_PORT,
    uiDir: join(findRepoRoot(), 'apps', 'web', 'dist'),
    presets,
    ...(env.NODE_ENV === 'production' ? {} : { devUiPort: 5173 }),
    tlsHosts: parseTlsHosts(env.DASHBOARD_TLS_HOSTS) ?? [],
    tlsUsers: parseTlsUsers(env.DASHBOARD_TLS_USERS),
  });
  const webhook = await buildWebhookApp({
    secrets: store,
    log,
    intake: webhooks,
    reviews: {
      secret: () => store.getReviewsWebhookSecret(false),
      onDelivery: (headers, payload) => {
        const h = headers['x-gitlab-event'];
        const norm = normalizeWebhook(typeof h === 'string' ? h : undefined, payload);
        if (norm.ok) reviewDesk.onWebhook(norm.event.projectId, norm.event, true);
      },
    },
  });

  const dashUrl = await listenDashboard(dashboard, {
    host: env.DASHBOARD_HOST,
    port: env.DASHBOARD_PORT,
  });
  const hookUrl = await listenWebhook(webhook, { host: env.WEBHOOK_HOST, port: env.WEBHOOK_PORT });
  log.info({ dashboard: dashUrl, webhook: hookUrl, dbFile }, 'listening');

  // Startup catch-up sync + schedule; deliberately not awaited (the UI serves the cache meanwhile).
  void poller.start();
  void tokenIdentity.start();
  kpi.start();
  ready.start();
  cleanup.start();
  reviewDesk.start();

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    // Stop taking deliveries first, let the one in progress finish, then the poller/engine, then the DB.
    void Promise.allSettled([dashboard.close(), webhook.close()])
      .then(() => gamification.close())
      .then(() => kpi.close())
      .then(() => ready.close())
      .then(() => cleanup.stop())
      .then(() => reviewDesk.stop())
      .then(() => sessions.close())
      .then(() => figmaBridge.close())
      .then(() => webhooks.close())
      .then(() => notifier.close())
      .then(() => share.close())
      .then(() => builds.close())
      .then(() => release.close())
      .then(() => agent?.close())
      .then(() => poller.stop())
      .finally(() => {
        app.close();
        process.exit(0);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal:', (err as Error).message);
  process.exit(1);
});
