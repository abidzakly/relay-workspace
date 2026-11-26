import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConfigStore } from '../../config/store';
import {
  DRIVE_FILES_URL,
  FOLDER_MIME,
  GOOGLE_TOKEN_URL,
  KEY_MESSAGES,
  loadServiceAccountKey,
  resolveKeyPath,
  signAssertion,
} from '../../services/drive';
import type { HttpClient } from '../../services/httpClient';
import { HttpError, parseWith } from '../errors';

export interface DriveSetupDeps {
  store: ConfigStore;
  http: HttpClient;
  rootDir: string;
  now?: () => number;
}

/** A service-account key is a few KB; anything much larger is not one. */
const KeyBody = z.object({
  json: z
    .string()
    .min(2)
    .max(64 * 1024),
});
const FolderBody = z.object({ search: z.string().max(100).optional() });

export interface DriveFolderOption {
  id: string;
  name: string;
  /** The Shared Drive it is in; null = someone's My Drive. */
  driveId: string | null;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Drive setup without typing paths or folder ids (private listener, CSRF applies):
 *  POST /api/drive/key      { json } the service-account key file's content, written to the configured key path
 *                           (mode 600). Answers with the account's email, to share folders with. Never echoes the key.
 *  POST /api/drive/folders  { search? } folders the service account can see (Advanced mode only: the Google sign-in
 *                           only sees what Relay made).
 */
export function registerDriveSetupRoutes(app: FastifyInstance, deps: DriveSetupDeps): void {
  const now = deps.now ?? Date.now;
  const keyFile = () =>
    resolveKeyPath(deps.store.getGlobal().drive.serviceAccountKeyPath, deps.rootDir);

  app.post('/api/drive/key', async (req) => {
    const { json } = parseWith(KeyBody, req.body);
    let o: Record<string, unknown>;
    try {
      o = rec(JSON.parse(json));
    } catch {
      throw new HttpError(
        400,
        'key_invalid_json',
        'That file is not JSON. Pick the downloaded .json key.',
      );
    }
    if (o.type !== 'service_account') {
      throw new HttpError(
        400,
        'key_not_service_account',
        'That is not a service-account key (an OAuth client file looks similar). Make a key under the service account’s Keys tab.',
      );
    }
    if (!str(o.client_email)?.includes('@') || !str(o.private_key)?.includes('PRIVATE KEY')) {
      throw new HttpError(
        400,
        'key_missing_fields',
        'The key file is missing its email or private key.',
      );
    }
    const file = keyFile();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, json, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      throw new HttpError(
        500,
        'key_not_written',
        'Relay could not write the key file. Check the key path.',
      );
    }
    const loaded = loadServiceAccountKey(file);
    if (!loaded.ok) {
      const [message] = KEY_MESSAGES[loaded.reason];
      throw new HttpError(500, 'key_unreadable', message);
    }
    return { ok: true as const, clientEmail: loaded.key.clientEmail };
  });

  app.post('/api/drive/folders', async (req): Promise<DriveFolderOption[]> => {
    const { search } = parseWith(FolderBody, req.body ?? {});
    if (deps.store.getGlobal().google.authMode !== 'token') {
      throw new HttpError(
        409,
        'drive_connect_mode',
        'With the Google sign-in Relay only sees the folders it made. Paste a folder link instead.',
      );
    }
    const loaded = loadServiceAccountKey(keyFile());
    if (!loaded.ok) {
      const [message] = KEY_MESSAGES[loaded.reason];
      throw new HttpError(422, 'drive_key_missing', message);
    }
    let assertion: string;
    try {
      assertion = signAssertion(loaded.key, now());
    } catch {
      throw new HttpError(
        422,
        'drive_key_unusable',
        'The key’s private key cannot sign. Make a new key.',
      );
    }
    const tok = await deps.http.send({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      maxRetries: 0,
    });
    const accessToken = str(rec(tok.json).access_token);
    if (tok.status !== 200 || !accessToken) {
      throw new HttpError(
        502,
        'drive_auth_failed',
        'Google refused the service account. Check the key.',
      );
    }
    const safe = search?.replace(/['\\]/g, '');
    const q = [
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
      ...(safe ? [`name contains '${safe}'`] : []),
    ];
    const params = new URLSearchParams({
      q: q.join(' and '),
      fields: 'files(id,name,driveId)',
      pageSize: '50',
      orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: 'allDrives',
    });
    const res = await deps.http.send({
      url: `${DRIVE_FILES_URL}?${params.toString()}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 200) {
      throw new HttpError(502, 'drive_list_failed', `Drive answered HTTP ${res.status}.`);
    }
    const files = rec(res.json).files;
    return (Array.isArray(files) ? files : []).flatMap((f): DriveFolderOption[] => {
      const o = rec(f);
      const id = str(o.id);
      return id ? [{ id, name: str(o.name) ?? id, driveId: str(o.driveId) ?? null }] : [];
    });
  });
}
