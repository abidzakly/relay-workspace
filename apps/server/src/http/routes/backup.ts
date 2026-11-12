import type { FastifyInstance } from 'fastify';
import {
  ConfigExportBodySchema,
  ConfigImportApplyBodySchema,
  ConfigImportPreviewBodySchema,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import {
  applyImport,
  buildConfigExport,
  openSecrets,
  parseConfigFile,
  previewImport,
} from '../../services/configBackup';
import { createDbBackup, sweepBackupLeftovers } from '../../services/dbBackup';
import { HttpError, parseWith, wrapAction } from '../errors';

export interface BackupRouteDeps {
  store: ConfigStore;
  audit: AuditWriter;
  cache: AppDb;
  now?: () => number;
}

const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/**
 * Backups, on the PRIVATE listener only: `buildWebhookApp` has no route but `POST /webhook/:repoId`.
 * All are POST, so the CSRF header applies. A passphrase belongs in a body, never a URL, and a hostile page must not be
 * able to start a DB download with a plain link.
 *  POST /api/backup/config/export          the file as JSON (secrets only when asked, sealed)
 *  POST /api/backup/config/import/preview  validates, reports what would change, writes nothing
 *  POST /api/backup/config/import          the same, then writes. Needs `confirm: true`; audited
 *  POST /api/backup/db                     a consistent SQLite copy; audited
 */
export function registerBackupRoutes(
  app: FastifyInstance,
  { store, audit, cache, now }: BackupRouteDeps,
): void {
  const clock = now ?? Date.now;
  sweepBackupLeftovers(cache.sqlite);
  let dbBackupRunning = false;

  app.post('/api/backup/config/export', async (req) => {
    const body = parseWith(ConfigExportBodySchema, req.body);
    const file = await wrapAction(() =>
      buildConfigExport(store, body.includeSecrets ? body.passphrase : undefined, clock()),
    );
    audit.write({
      actor: 'user',
      action: 'backup.configExport',
      targetType: 'settings',
      targetId: 'global',
      before: null,
      after: { includeSecrets: body.includeSecrets, repos: file.repos.length },
    });
    return file;
  });

  app.post('/api/backup/config/import/preview', async (req) => {
    const body = parseWith(ConfigImportPreviewBodySchema, req.body);
    return wrapAction(async () => {
      const parsed = parseConfigFile(body.file);
      return { preview: previewImport(store, parsed, await openSecrets(parsed, body.passphrase)) };
    });
  });

  // `settings.*` also tells open pages to re-read (sync/auditEvents.ts).
  app.post('/api/backup/config/import', async (req) => {
    const body = parseWith(ConfigImportApplyBodySchema, req.body);
    return wrapAction(async () => {
      const parsed = parseConfigFile(body.file);
      const secrets = await openSecrets(parsed, body.passphrase);
      const preview = previewImport(store, parsed, secrets);
      const before = { settings: store.getGlobalPublic(), repos: store.listRepos() };
      applyImport(store, parsed, secrets);
      audit.write({
        actor: 'user',
        action: 'settings.import',
        targetType: 'settings',
        targetId: 'global',
        before,
        after: {
          settings: store.getGlobalPublic(),
          repos: store.listRepos(),
          restoredCredentials: preview.secretCount,
        },
      });
      return { preview };
    });
  });

  app.post('/api/backup/db', async (_req, reply) => {
    if (dbBackupRunning) throw new HttpError(409, 'backup_running', 'A backup is already running.');
    dbBackupRunning = true;
    let backup: Awaited<ReturnType<typeof createDbBackup>>;
    try {
      backup = await createDbBackup(cache.sqlite);
    } finally {
      dbBackupRunning = false;
    }
    const at = clock();
    try {
      audit.write({
        actor: 'user',
        action: 'backup.db',
        targetType: 'settings',
        targetId: 'global',
        before: null,
        after: { bytes: backup.size },
      });
    } catch (e) {
      await backup.handle.close();
      throw e;
    }
    void reply
      .header('content-type', 'application/vnd.sqlite3')
      .header('content-length', backup.size)
      .header('content-disposition', `attachment; filename="relay-${stamp(at)}.db"`);
    return reply.send(backup.handle.createReadStream());
  });
}
