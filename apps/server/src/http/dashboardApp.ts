import type { ScriptConfigService } from '../services/scriptConfig';
import { registerScriptRoutes } from './routes/scripts';
import { registerSystemRoutes } from './routes/system';
import { NO_PRESETS, type LoadedPresets } from '../config/presets';
import type { ReviewDeskService } from '../services/reviewDesk';
import { registerReviewsRoutes } from './routes/reviews';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AuditWriter } from '../audit/auditLog';
import type { SyncStatus } from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { Logger } from '../util/logger';
import { installErrorHandling } from './errors';
import { findRepoRoot } from '../config/env';
import type { BuildQueue } from '../services/buildQueue';
import { CardActions } from '../services/cardActions';
import type { GamificationService } from '../services/gamificationService';
import type { KpiService } from '../services/kpiService';
import { HttpClient } from '../services/httpClient';
import { MrActions } from '../services/mrActions';
import { NotionService } from '../services/notionService';
import type { NotificationCenter } from '../services/notificationCenter';
import type { Notifier } from '../services/notifier';
import type { PushService } from '../services/pushService';
import type { ReleaseEngine } from '../services/releaseEngine';
import type { ShareService } from '../services/share';
import type { SigningFiles } from '../services/signingFiles';
import { UndoEngine } from '../services/undoEngine';
import { WebhookRegistry } from '../services/webhookRegistry';
import type { EventBus } from '../sync/eventBus';
import { registerBackupRoutes } from './routes/backup';
import { registerBuildRoutes } from './routes/builds';
import { registerSyncRefreshRoute } from './routes/syncRefresh';
import { registerConnectionTestRoutes } from './routes/connectionTests';
import { registerCardActionRoutes } from './routes/cardActions';
import { registerGamificationRoutes } from './routes/gamification';
import { registerKpiRoutes } from './routes/kpi';
import { registerMrActionRoutes } from './routes/mrActions';
import { registerCockpitRoutes, type CockpitDeps } from './routes/cockpit';
import { registerMrRoutes } from './routes/mrs';
import { registerNotificationRoutes } from './routes/notifications';
import { registerPushRoutes } from './routes/push';
import { registerReleaseRoutes } from './routes/release';
import { registerReleaseJobRoutes } from './routes/releaseJobs';
import { registerRepoRoutes } from './routes/repos';
import type { TokenIdentity } from '../services/tokenIdentity';
import { registerReviewRoutes } from './routes/review';
import { registerSettingsRoutes } from './routes/settings';
import { registerShareRoutes } from './routes/share';
import { registerSigningRoutes } from './routes/signing';
import { registerStateRoutes } from './routes/state';
import { registerSprintRoutes } from './routes/sprints';
import { registerSyncHealthRoutes } from './routes/syncHealth';
import { registerUndoRoutes } from './routes/undo';
import { registerWebhookHealthRoutes } from './routes/webhookHealth';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerApkDownloads } from './apks';
import { registerBuildLogStream } from './buildLogStream';
import { installSecurity } from './security';
import { registerPtyStream } from './ptyStream';
import { registerStaticUi } from './staticUi';
import { registerEventStream } from './sse';

export interface DashboardAppOptions {
  store: ConfigStore;
  audit: AuditWriter;
  log: Logger;
  /** The port this app will listen on (used for the Host/Origin allowlist). */
  port: number;
  /** Vite dev-server port to allow (dev only). */
  devUiPort?: number;
  /** Hostnames a local TLS reverse proxy serves the dashboard under (`DASHBOARD_TLS_HOSTS`). */
  tlsHosts?: readonly string[];
  /** Tailscale logins allowed through `tlsHosts` (`DASHBOARD_TLS_USERS`). */
  tlsUsers?: readonly string[];
  /** The built web app (`apps/web/dist`). When given and present, it is served here with an SPA fallback. */
  uiDir?: string;
  /** Outbound HTTP for connection tests (tests inject a MockAgent-backed client). */
  http?: HttpClient;
  /** Learns each repo token's GitLab user; re-run when a token changes. */
  tokenIdentity?: TokenIdentity;
  /** Base for relative Drive key paths; default = the repo root. */
  rootDir?: string;
  now?: () => number;
  /** Local cache DB; when given, `GET /api/state` is served. */
  cache?: AppDb;
  /** Live sync status for the snapshot (the poller's `status`). */
  getSyncStatus?: () => SyncStatus;
  /** When given, `POST /api/sync/refresh` is served. */
  refreshSync?: () => Promise<unknown>;
  /** When given, `GET /api/events` (SSE) is served from it. */
  bus?: EventBus;
  /** Web Push + notifier: when both are given, `/api/push/*` is served. */
  push?: PushService;
  notifier?: Notifier;
  /** When given, `/api/notifications*` is served. */
  notifications?: NotificationCenter;
  /** Edition presets, reported by `GET /api/system`. */
  presets?: LoadedPresets;
  /** When given, the release job routes are served. */
  release?: ReleaseEngine;
  /** When given, the build routes, their log stream and `/apks/*` are served. */
  builds?: BuildQueue;
  /** Needed with `builds`: Drive upload and Share to QA. */
  share?: ShareService;
  /** When given, `/api/builds/signing/*` is served. */
  signing?: SigningFiles;
  /** The instance a release's NOTION step also writes through. Made here when not given. */
  cardActions?: CardActions;
  /** When given (with `cache`), the KPI routes are served. */
  kpi?: KpiService;
  /** When given (with `cache`), `GET /api/gamification` is served. */
  gamification?: GamificationService;
  /** Mobile Dev Cockpit (AI, review deck, workspaces, sessions). Private listener only. */
  cockpit?: CockpitDeps;
  /** Reviews desk (absent in tests = no Reviews routes). */
  reviewDesk?: ReviewDeskService;
  /** Release script settings (absent in tests = no routes). */
  scripts?: ScriptConfigService;
  /** SSE tuning (tests / ops); defaults in `http/sse.ts`. */
  sse?: { heartbeatMs?: number; maxClients?: number };
}

/**
 * PRIVATE listener (127.0.0.1:3000). Never exposed through ngrok.
 * Serves the API and, with `uiDir`, the built UI (`/api/state` needs `cache`, `/api/events` needs `bus`).
 */
export async function buildDashboardApp(opts: DashboardAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.log as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
    disableRequestLogging: true,
  });
  installErrorHandling(app);
  installSecurity(app, {
    port: opts.port,
    ...(opts.devUiPort ? { devUiPort: opts.devUiPort } : {}),
    ...(opts.tlsHosts?.length ? { tlsHosts: opts.tlsHosts, tlsUsers: opts.tlsUsers ?? [] } : {}),
  });
  if (opts.uiDir) registerStaticUi(app, { uiDir: opts.uiDir, log: opts.log });

  app.get('/api/health', async () => ({ ok: true }));
  if (opts.bus) {
    registerEventStream(app, {
      bus: opts.bus,
      log: opts.log,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.sse?.heartbeatMs ? { heartbeatMs: opts.sse.heartbeatMs } : {}),
      ...(opts.sse?.maxClients ? { maxClients: opts.sse.maxClients } : {}),
    });
  }
  if (opts.push && opts.notifier) {
    registerPushRoutes(app, { push: opts.push, notifier: opts.notifier });
  }
  if (opts.notifications) registerNotificationRoutes(app, { center: opts.notifications });
  if (opts.release) {
    registerReleaseJobRoutes(app, { engine: opts.release });
    registerPtyStream(app, { engine: opts.release, log: opts.log });
  }
  if (opts.builds && opts.share) {
    registerBuildRoutes(app, {
      builds: opts.builds,
      share: opts.share,
      store: opts.store,
      ...(opts.cache ? { cache: opts.cache } : {}),
    });
    registerShareRoutes(app, { share: opts.share });
    registerBuildLogStream(app, { builds: opts.builds });
    registerApkDownloads(app, { apksDir: opts.builds.apksDir });
  }
  if (opts.signing) registerSigningRoutes(app, { signing: opts.signing });
  if (opts.cockpit) registerCockpitRoutes(app, opts.cockpit);
  registerSettingsRoutes(app, opts);
  registerRepoRoutes(app, opts);
  registerConnectionTestRoutes(app, {
    store: opts.store,
    http: opts.http ?? new HttpClient({ log: opts.log }),
    rootDir: opts.rootDir ?? findRepoRoot(),
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (opts.cache) {
    registerStateRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      ...(opts.getSyncStatus ? { getSyncStatus: opts.getSyncStatus } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    registerSprintRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      ...(opts.now ? { now: opts.now } : {}),
    });
    registerSyncHealthRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      ...(opts.now ? { now: opts.now } : {}),
    });
    registerReleaseRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      ...(opts.now ? { now: opts.now } : {}),
    });
    registerMrRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      http: opts.http ?? new HttpClient({ log: opts.log }),
      log: opts.log,
      ...(opts.cockpit ? { branchHeads: (r: string) => opts.cockpit!.ready.branchHeads(r) } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    registerReviewRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      http: opts.http ?? new HttpClient({ log: opts.log }),
      log: opts.log,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const http = opts.http ?? new HttpClient({ log: opts.log });
    const mrActions = new MrActions({
      config: opts.store,
      audit: opts.audit,
      store: opts.cache,
      http,
      log: opts.log,
      ...(opts.bus ? { bus: opts.bus } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.cockpit
        ? {
            branchHeads: (repoId: string) =>
              Promise.resolve(opts.cockpit!.ready.branchHeads(repoId)),
          }
        : {}),
    });
    const cardActions =
      opts.cardActions ??
      new CardActions({
        config: opts.store,
        audit: opts.audit,
        store: opts.cache,
        notion: NotionService.fromConfig(opts.store, { http, store: opts.cache, log: opts.log }),
        log: opts.log,
        ...(opts.bus ? { bus: opts.bus } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    // One undo engine, one handler per undoable audit action.
    const undo = new UndoEngine(opts.audit, opts.now);
    undo.register(mrActions.resolveUndoHandler);
    undo.register(cardActions.statusUndoHandler);
    undo.register(cardActions.bulkUndoHandler);
    if (opts.kpi) {
      undo.register(opts.kpi.assignedAtUndoHandler);
      registerKpiRoutes(app, { kpi: opts.kpi });
    }
    if (opts.gamification) registerGamificationRoutes(app, { gamification: opts.gamification });
    registerMrActionRoutes(app, { actions: mrActions });
    if (opts.reviewDesk) registerReviewsRoutes(app, { desk: opts.reviewDesk, audit: opts.audit });
    if (opts.scripts) registerScriptRoutes(app, { scripts: opts.scripts, audit: opts.audit });
    registerSystemRoutes(app, opts.presets ?? NO_PRESETS);
    registerCardActionRoutes(app, { actions: cardActions });
    registerUndoRoutes(app, { undo, audit: opts.audit, cache: opts.cache });
    registerWebhookHealthRoutes(app, {
      store: opts.store,
      cache: opts.cache,
      http,
      ...(opts.now ? { now: opts.now } : {}),
    });
    registerBackupRoutes(app, {
      store: opts.store,
      audit: opts.audit,
      cache: opts.cache,
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (opts.refreshSync) {
      registerSyncRefreshRoute(app, {
        refresh: opts.refreshSync,
        ...(opts.now ? { now: opts.now } : {}),
      });
    }
    registerWebhookRoutes(app, {
      webhooks: new WebhookRegistry({
        config: opts.store,
        audit: opts.audit,
        store: opts.cache,
        http: opts.http ?? new HttpClient({ log: opts.log }),
        log: opts.log,
      }),
    });
  }
  return app;
}
