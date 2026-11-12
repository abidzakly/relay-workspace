import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Check } from '@relay/shared';
import { clip, makeCheck } from './checks';
import { HttpNetworkError, type HttpClient } from './httpClient';

/**
 * Google Drive connection test: service-account JWT -> access token -> read the Shared Drive folder.
 * Plain REST via the shared HTTP client. The upload itself is in `driveService.ts`.
 * Response shapes follow Google's documented OAuth2 JWT-bearer flow and Drive v3 `files.get` (UNVERIFIED live).
 */

/** Fixed on purpose: the `token_uri` inside the key file is NOT trusted (it would receive our signed assertion). */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
/** `drive.file` cannot read a pre-existing folder; full `drive` is needed to verify (and later to upload into) it. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_KEY_BYTES = 64 * 1024;

type Maker = ReturnType<typeof makeCheck>;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

export type KeyLoad =
  | { ok: true; key: ServiceAccountKey; looseMode: boolean }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'unreadable'
        | 'too_large'
        | 'invalid_json'
        | 'not_service_account'
        | 'missing_fields';
    };

/** Relative paths resolve against `baseDir` (the repo root, like `data/`). */
export function resolveKeyPath(keyPath: string, baseDir: string): string {
  return isAbsolute(keyPath) ? keyPath : resolve(baseDir, keyPath);
}

export function loadServiceAccountKey(file: string): KeyLoad {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!st.isFile()) return { ok: false, reason: 'missing' };
  if (st.size > MAX_KEY_BYTES) return { ok: false, reason: 'too_large' };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  if (o.type !== 'service_account') return { ok: false, reason: 'not_service_account' };
  if (
    typeof o.client_email !== 'string' ||
    !o.client_email.includes('@') ||
    typeof o.private_key !== 'string' ||
    !o.private_key.includes('PRIVATE KEY')
  ) {
    return { ok: false, reason: 'missing_fields' };
  }
  // group/other readable key file (POSIX only; Windows reports 0o666-ish modes, so ignore there)
  const looseMode = process.platform !== 'win32' && (st.mode & 0o077) !== 0;
  return { ok: true, key: { clientEmail: o.client_email, privateKey: o.private_key }, looseMode };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT assertion for the OAuth2 JWT-bearer grant. Throws if the private key is unusable. */
export function signAssertion(key: ServiceAccountKey, nowMs: number, scope = DRIVE_SCOPE): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(
    JSON.stringify({ iss: key.clientEmail, scope, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600 }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.privateKey);
  return `${head}.${claims}.${b64u(sig)}`;
}

export interface DriveFolderTarget {
  /** Repo id the folder belongs to (for labels), or `undefined` for an ad-hoc folder id. */
  repoId?: string;
  folderId: string | undefined;
}

export interface DriveTestInput {
  keyPath: string;
  baseDir: string;
  anyoneWithLink: boolean;
  folders: DriveFolderTarget[];
  http: HttpClient;
  now: number;
}

export const KEY_MESSAGES: Record<Exclude<KeyLoad, { ok: true }>['reason'], [string, string]> = {
  missing: [
    'Service-account key file not found.',
    'Put the JSON key at the configured path (default data/credentials/drive-service-account.json).',
  ],
  unreadable: ['Service-account key file cannot be read.', 'Check the file permissions.'],
  too_large: [
    'Key file is unexpectedly large.',
    'Use the JSON key downloaded from Google Cloud (a few KB).',
  ],
  invalid_json: [
    'Key file is not valid JSON.',
    'Download the key again from Google Cloud → IAM → Service accounts → Keys (JSON).',
  ],
  not_service_account: [
    'Key file is not a service-account key (type ≠ service_account).',
    'Create a service-account key; OAuth client files do not work here.',
  ],
  missing_fields: [
    'Key file lacks client_email or private_key.',
    'Download a fresh JSON key from Google Cloud.',
  ],
};

/** Checklist: key file -> token exchange -> one check per folder. Never reveals the key or tokens. */
export async function testDrive(input: DriveTestInput): Promise<Check[]> {
  const c = makeCheck('drive');
  const out: Check[] = [];
  const skipFolders = (why: string) => {
    for (const f of folderTargets(input.folders))
      out.push(c.skip(folderId(f), folderLabel(f), why));
  };

  const file = resolveKeyPath(input.keyPath, input.baseDir);
  const loaded = loadServiceAccountKey(file);
  if (!loaded.ok) {
    const [msg, hint] = KEY_MESSAGES[loaded.reason];
    out.push(c.fail('drive.key', 'Service-account key', msg, hint));
    out.push(c.skip('drive.auth', 'Google sign-in', 'Needs the key file.'));
    skipFolders('Needs the key file.');
    return out;
  }
  if (loaded.looseMode) {
    out.push(
      c.warn(
        'drive.key',
        'Service-account key',
        `Key for ${clip(loaded.key.clientEmail, 120)} is readable by other users on this machine.`,
        'Run chmod 600 on the key file.',
      ),
    );
  } else {
    out.push(
      c.pass('drive.key', 'Service-account key', `Key for ${clip(loaded.key.clientEmail, 120)}.`),
    );
  }

  // token
  let accessToken: string | undefined;
  try {
    const assertion = signAssertion(loaded.key, input.now);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();
    const res = await input.http.send({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<
      string,
      unknown
    >;
    if (res.status === 200 && typeof j.access_token === 'string' && j.access_token) {
      accessToken = j.access_token;
      out.push(c.pass('drive.auth', 'Google sign-in', 'Access token obtained.'));
    } else {
      const err = typeof j.error === 'string' ? clip(j.error, 40) : `HTTP ${res.status}`;
      const desc =
        typeof j.error_description === 'string' ? ` ${clip(j.error_description, 120)}` : '';
      out.push(
        c.fail(
          'drive.auth',
          'Google sign-in',
          `Google rejected the key: ${err}.${desc}`,
          j.error === 'invalid_grant'
            ? "The key may be deleted/disabled, or this computer's clock is off. Create a new key and check the system time."
            : 'Create a new JSON key for the service account.',
        ),
      );
    }
  } catch (e) {
    if (e instanceof HttpNetworkError) {
      out.push(
        c.fail(
          'drive.auth',
          'Google sign-in',
          e.kind === 'timeout'
            ? 'Timed out reaching oauth2.googleapis.com.'
            : `Could not reach oauth2.googleapis.com (${e.kind}).`,
          'Check your network / proxy and try again.',
        ),
      );
    } else {
      // createSign threw: the PEM could not be parsed. Do not echo the error text.
      out.push(
        c.fail(
          'drive.auth',
          'Google sign-in',
          'The private key in the key file could not be used to sign.',
          'Download a fresh JSON key from Google Cloud.',
        ),
      );
    }
  }
  if (!accessToken) {
    skipFolders('Needs a Google access token.');
    return out;
  }

  const targets = folderTargets(input.folders);
  if (targets.length === 0) {
    out.push(
      c.warn(
        'drive.folder',
        'Shared Drive folder',
        'No repo has a Drive folder configured, so no folder was checked.',
        'Set the Drive folder id on the repo (Settings → repo → Drive), then test again.',
      ),
    );
  }
  for (const t of targets) {
    out.push(await checkFolder(c, t, accessToken, input, loaded.key.clientEmail));
  }
  return out;
}

/** A target without a folder id is reported (warn) by `checkFolder`; ad-hoc targets always have one. */
function folderTargets(folders: DriveFolderTarget[]): DriveFolderTarget[] {
  return folders.filter(
    (f) => f.repoId === undefined || f.folderId !== undefined || folders.length === 1,
  );
}
const folderId = (t: DriveFolderTarget) => (t.repoId ? `drive.folder.${t.repoId}` : 'drive.folder');
const folderLabel = (t: DriveFolderTarget) =>
  t.repoId ? `Shared Drive folder (${t.repoId})` : 'Shared Drive folder';

async function checkFolder(
  c: Maker,
  t: DriveFolderTarget,
  accessToken: string,
  input: DriveTestInput,
  saEmail: string,
): Promise<Check> {
  const id = folderId(t);
  const label = folderLabel(t);
  if (!t.folderId) {
    return c.warn(
      id,
      label,
      'No Drive folder configured for this repo.',
      'Staging uploads to Drive stay disabled until you set the folder id.',
    );
  }
  const fields = 'id,name,mimeType,driveId,capabilities(canAddChildren,canShare)';
  let res;
  try {
    res = await input.http.send({
      url: `${DRIVE_FILES_URL}/${encodeURIComponent(t.folderId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    const kind = e instanceof HttpNetworkError ? e.kind : 'network';
    return c.fail(
      id,
      label,
      kind === 'timeout'
        ? 'Timed out reaching Google Drive.'
        : `Could not reach Google Drive (${kind}).`,
      'Check your network and try again.',
    );
  }
  const body = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as Record<
    string,
    unknown
  >;
  if (res.status === 404) {
    return c.fail(
      id,
      label,
      'Folder not found for this service account.',
      `Check the folder id, and add ${saEmail} to the Shared Drive as Content manager.`,
    );
  }
  if (res.status === 403 || res.status === 401) {
    const e = (typeof body.error === 'object' && body.error !== null ? body.error : {}) as Record<
      string,
      unknown
    >;
    const first = Array.isArray(e.errors)
      ? (e.errors[0] as Record<string, unknown> | undefined)
      : undefined;
    const reason = typeof first?.reason === 'string' ? first.reason : '';
    const apiOff =
      reason === 'accessNotConfigured' ||
      (e.status === 'PERMISSION_DENIED' &&
        /has not been used|disabled/i.test(String(e.message ?? '')));
    return c.fail(
      id,
      label,
      apiOff
        ? "The Google Drive API is not enabled for this service account's project."
        : `Drive denied access (HTTP ${res.status}${reason ? `, ${clip(reason, 40)}` : ''}).`,
      apiOff
        ? 'Enable "Google Drive API" in the Google Cloud project that owns the service account.'
        : `Add ${saEmail} to the Shared Drive as Content manager.`,
    );
  }
  if (res.status !== 200) {
    return c.fail(id, label, `Drive answered HTTP ${res.status}.`, 'Try again in a moment.');
  }
  if (body.mimeType !== FOLDER_MIME) {
    return c.fail(
      id,
      label,
      'That id is not a folder.',
      'Copy the folder id from the Drive URL (…/folders/<id>).',
    );
  }
  const caps = (
    typeof body.capabilities === 'object' && body.capabilities !== null ? body.capabilities : {}
  ) as Record<string, unknown>;
  const name = clip(body.name, 80);
  if (caps.canAddChildren === false) {
    return c.fail(
      id,
      label,
      `Folder "${name}" is readable but the service account cannot add files.`,
      `Make ${saEmail} a Content manager (not Viewer/Commenter) of the Shared Drive.`,
    );
  }
  if (typeof body.driveId !== 'string' || !body.driveId) {
    return c.warn(
      id,
      label,
      `Folder "${name}" is in a regular (My Drive) folder, not a Shared Drive.`,
      'Service accounts have no storage quota; uploads usually fail with storageQuotaExceeded. Use a Shared Drive folder.',
    );
  }
  if (input.anyoneWithLink && caps.canShare === false) {
    return c.warn(
      id,
      label,
      `Folder "${name}" is a Shared Drive folder the service account can write to, but it cannot change sharing.`,
      'Uploads work, but "anyone with the link" will fail. Make it Content manager or turn off drive.anyoneWithLink.',
    );
  }
  return c.pass(
    id,
    label,
    `Folder "${name}" in a Shared Drive; the service account can add files.`,
  );
}
