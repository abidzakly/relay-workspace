import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditWriter } from '../audit/auditLog';
import { SecretBox } from '../config/crypto';
import { ConfigStore } from '../config/store';
import { openDatabase, runMigrations, type AppDb } from '../db';
import { buildDashboardApp, type DashboardAppOptions } from '../http/dashboardApp';
import { buildWebhookApp, type WebhookAppOptions } from '../http/webhookApp';
import { createLogger } from '../util/logger';

export const TOKEN = 'glpat-PLAINTEXT-TOKEN-1111'; // gitleaks:allow (fake test token)
export const NOTION_TOKEN = 'ntn_PLAINTEXT-NOTION-2222';

export const repoBody = (over: Record<string, unknown> = {}) => ({
  id: 'app-a',
  name: 'App A',
  gitlab: { projectId: 123, token: TOKEN },
  cloneUrl: 'git@gitlab.example.com:team/app-a.git',
  ...over,
});

export interface TestCtx {
  dir: string;
  file: string;
  app: AppDb;
  box: SecretBox;
  store: ConfigStore;
  audit: AuditWriter;
  logLines: string[];
  log: ReturnType<typeof createLogger>;
  cleanup(): void;
}

/** Real file-backed SQLite in a temp dir (so tests can inspect the bytes on disk). */
export function makeCtx(): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'core-cfg-'));
  const file = join(dir, 'app.db');
  const app = openDatabase(file);
  runMigrations(app);
  const box = new SecretBox(randomBytes(32));
  const logLines: string[] = [];
  const log = createLogger({
    level: 'trace',
    destination: { write: (s: string) => void logLines.push(s) },
  });
  return {
    dir,
    file,
    app,
    box,
    store: new ConfigStore(app, box),
    audit: new AuditWriter(app),
    logLines,
    log,
    cleanup() {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const CSRF = { 'x-requested-with': 'relay' };
export const DASH_PORT = 3000;
export const dashHeaders = { host: `127.0.0.1:${DASH_PORT}` };

export function makeDashboard(ctx: TestCtx, over: Partial<DashboardAppOptions> = {}) {
  return buildDashboardApp({
    store: ctx.store,
    audit: ctx.audit,
    log: ctx.log,
    port: DASH_PORT,
    ...over,
  });
}

export function makeWebhook(ctx: TestCtx, over: Partial<WebhookAppOptions> = {}) {
  return buildWebhookApp({ secrets: ctx.store, log: ctx.log, ...over });
}
