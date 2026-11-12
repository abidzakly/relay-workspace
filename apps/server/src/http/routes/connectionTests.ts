import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildTestResult, type ConnectionTestResult } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import {
  KEY_MESSAGES,
  loadServiceAccountKey,
  resolveKeyPath,
  testDrive,
  type DriveFolderTarget,
} from '../../services/drive';
import { testGitlab } from '../../services/gitlab';
import type { HttpClient } from '../../services/httpClient';
import { testNotion } from '../../services/notion';
import { skippedWebhookChecks, testWebhook } from '../../services/webhookTest';
import { HttpError, parseWith } from '../errors';

export interface ConnectionTestRouteDeps {
  store: ConfigStore;
  http: HttpClient;
  /** Relative key paths (default `data/credentials/…`) resolve against this directory (repo root). */
  rootDir: string;
  now?: () => number;
}

const IdParams = z.object({ id: z.string().min(1).max(64) });
const DriveBody = z
  .object({
    folderId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{5,100}$/, 'invalid Drive folder id')
      .optional(),
  })
  .strict()
  .nullish();

/**
 * Connection tests. They change no configuration in GitLab / Notion / Google, so the
 * dry-run flag does not apply and nothing is written to `audit_log`. Results carry no secret.
 * The repo test additionally triggers one GitLab test delivery to the repo's webhook (see `testWebhook`).
 */
export function registerConnectionTestRoutes(
  app: FastifyInstance,
  { store, http, rootDir, now = Date.now }: ConnectionTestRouteDeps,
): void {
  app.post('/api/repos/:id/test', async (req): Promise<ConnectionTestResult> => {
    const { id } = parseWith(IdParams, req.params);
    const repo = store.getRepo(id);
    if (!repo) throw new HttpError(404, 'repo_not_found');
    const global = store.getGlobal();
    const t = now();
    const gitlab = await testGitlab({ global, repo, http, now: t });
    // Not read-only: asks GitLab to send one test push to our hook, so the whole path
    // (GitLab -> ngrok -> listener -> token check) is proven, not assumed.
    const webhook = gitlab.some((ch) => ch.id === 'gitlab.auth' && ch.status === 'fail')
      ? skippedWebhookChecks('Needs a working GitLab token.')
      : await testWebhook({ repoId: id, global, repo, http });
    const drive = await testDrive({
      keyPath: global.drive.serviceAccountKeyPath,
      baseDir: rootDir,
      anyoneWithLink: global.drive.anyoneWithLink,
      folders: [{ repoId: id, folderId: repo.drive.folderId }],
      http,
      now: t,
    });
    return buildTestResult([...gitlab, ...webhook, ...drive], t);
  });

  app.post('/api/settings/test-notion', async (): Promise<ConnectionTestResult> => {
    const global = store.getGlobal();
    const t = now();
    const out = await testNotion({
      notion: global.notion,
      slaTypeNames: Object.keys(global.sla.rules),
      http,
    });
    return buildTestResult(out.checks, t, out.detected ? { notion: out.detected } : {});
  });

  // Whether the Drive key file is on this machine. It is a file, so a config import never brings it. Local only:
  // reads the file, calls nothing, returns no key material.
  app.get('/api/settings/drive-key', async () => {
    const keyPath = store.getGlobal().drive.serviceAccountKeyPath;
    const loaded = loadServiceAccountKey(resolveKeyPath(keyPath, rootDir));
    if (loaded.ok) return { ok: true as const, keyPath };
    const [message, hint] = KEY_MESSAGES[loaded.reason];
    return { ok: false as const, keyPath, message, hint };
  });

  // Body `{ folderId }` tests that one folder; no body tests the folder of every repo that has one.
  app.post('/api/settings/test-drive', async (req): Promise<ConnectionTestResult> => {
    const body = parseWith(DriveBody, req.body);
    const global = store.getGlobal();
    const folders: DriveFolderTarget[] = body?.folderId
      ? [{ folderId: body.folderId }]
      : store
          .listRepos()
          .filter((r) => r.drive.folderId)
          .map((r) => ({ repoId: r.id, folderId: r.drive.folderId }));
    const t = now();
    const checks = await testDrive({
      keyPath: global.drive.serviceAccountKeyPath,
      baseDir: rootDir,
      anyoneWithLink: global.drive.anyoneWithLink,
      folders,
      http,
      now: t,
    });
    return buildTestResult(checks, t);
  });
}
