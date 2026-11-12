import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { BuildArtifact, BuildResult, BuildUpload, Job } from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { clip } from './checks';
import {
  DRIVE_SCOPE,
  KEY_MESSAGES,
  loadServiceAccountKey,
  resolveKeyPath,
  type ServiceAccountKey,
} from './drive';
import { assertStagingOnly } from './shareRule';

/**
 * Drive upload, over Google's documented resumable protocol (UNVERIFIED live):
 *
 *   POST ...?uploadType=resumable  -> a session URL in `Location`
 *   PUT  chunks with Content-Range -> 308 and a `Range` header, then 200/201 and the file
 *   PUT  `bytes *\/<total>`        -> how much arrived, after a lost connection
 *
 * The `googleapis` client only does multipart uploads, where a dropped connection starts the whole APK over. So it provides
 * the JWT client and `permissions.create`, and the session is driven here. Chunks are read by position from one file handle,
 * because a stream cannot rewind to what Drive did not receive.
 *
 * Errors carry fixed text plus Drive's reason code. Raw error text is neither shown nor logged, since a client's error can
 * hold its request headers.
 */

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const APK_MIME = 'application/vnd.android.package-archive';
/** Drive requires a multiple of 256 KiB, except for the last chunk. */
const CHUNK_BYTES = 16 * 256 * 1024;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
/** In a row without any progress. */
const MAX_FAILURES = 5;
const BACKOFF_BASE_MS = 1_000;

export class DriveError extends ActionError {
  constructor(code: string, message: string, status = 502) {
    super(status, code, message);
    this.name = 'DriveError';
  }
}

export interface DriveServiceDeps {
  config: Pick<ConfigStore, 'getGlobalStored'>;
  /** Base for a relative key path. */
  baseDir: string;
  log: Logger;
}

export interface DriveUploadInput {
  job: Pick<Job, 'mode'>;
  result: BuildResult;
  artifact: BuildArtifact;
  folderId: string;
  signal: AbortSignal;
  onProgress: (sentBytes: number, totalBytes: number) => void;
  now: number;
}

/** What is used of a client's response. */
interface DriveResponse {
  status: number;
  header: (name: string) => string | null;
  text: string;
}

type Send = (options: {
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  data?: string | Buffer;
}) => Promise<DriveResponse>;

const parseObject = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function reasonOf(text: string): string {
  const error = parseObject(text).error;
  if (typeof error !== 'object' || error === null || !('errors' in error)) return '';
  const first: unknown = Array.isArray(error.errors) ? error.errors[0] : undefined;
  if (typeof first !== 'object' || first === null || !('reason' in first)) return '';
  return typeof first.reason === 'string' ? first.reason : '';
}

function refusal(res: DriveResponse): DriveError {
  const reason = reasonOf(res.text);
  if (reason === 'storageQuotaExceeded') {
    return new DriveError(
      'drive_quota',
      'Drive has no storage for this service account. Use a folder in a Shared Drive.',
    );
  }
  if (res.status === 404) {
    return new DriveError(
      'drive_folder_not_found',
      'The Drive folder was not found. Check its id, and that the service account is in the Shared Drive.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new DriveError(
      'drive_denied',
      `Drive denied the upload (HTTP ${res.status}${reason ? `, ${clip(reason, 40)}` : ''}). Make the service account a Content manager of the Shared Drive.`,
    );
  }
  return new DriveError('drive_failed', `Drive answered HTTP ${res.status}.`);
}

const isTransient = (status: number) => status === 429 || status >= 500;

/** `bytes=0-524287` -> 524288. No header: Drive has nothing yet. */
function receivedBytes(res: DriveResponse): number {
  const match = /^bytes=0-(\d+)$/.exec(res.header('range') ?? '');
  return match?.[1] ? Number(match[1]) + 1 : 0;
}

function stoppable(signal: AbortSignal): void {
  if (signal.aborted) throw new DriveError('upload_stopped', 'The upload was stopped.', 409);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The bearer token goes to this URL, so it must be Google's. */
function sessionUrl(res: DriveResponse): string {
  try {
    const url = new URL(res.header('location') ?? '');
    if (url.protocol === 'https:' && url.hostname.endsWith('.googleapis.com')) return url.href;
  } catch {
    /* reported below */
  }
  throw new DriveError('drive_bad_response', 'Drive did not give a usable upload session.');
}

async function openArtifact(artifact: BuildArtifact): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DriveError(
      'artifact_missing',
      `${artifact.fileName} is no longer on disk. Build it again.`,
      409,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size !== artifact.sizeBytes) {
      throw new DriveError(
        'artifact_changed',
        `${artifact.fileName} is not the file this build made: a later build may have replaced it. Upload from the newest build.`,
        409,
      );
    }
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}

async function readChunk(handle: FileHandle, buffer: Buffer, position: number): Promise<Buffer> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      throw new DriveError('artifact_changed', 'The file changed during the upload.', 409);
    }
    filled += bytesRead;
  }
  return buffer;
}

export class DriveService {
  constructor(private readonly d: DriveServiceDeps) {}

  /** Refuses a key that cannot work before anything starts. Reads the file: call on a user's click, not per render. */
  assertKeyUsable(): ServiceAccountKey {
    const { serviceAccountKeyPath } = this.d.config.getGlobalStored().drive;
    const loaded = loadServiceAccountKey(resolveKeyPath(serviceAccountKeyPath, this.d.baseDir));
    if (!loaded.ok) {
      const [message, hint] = KEY_MESSAGES[loaded.reason];
      throw new DriveError('drive_key_unusable', `${message} ${hint}`, 422);
    }
    return loaded.key;
  }

  /** Uploads one staging APK. A real write: reach it only through `guardedWrite`. */
  async upload(input: DriveUploadInput): Promise<BuildUpload> {
    assertStagingOnly(input.job, input.result);
    const { artifact, signal } = input;
    if (artifact.kind !== 'apk') {
      throw new ActionError(403, 'prod_never_shared', 'Only an APK can be uploaded.');
    }
    const key = this.assertKeyUsable();
    const handle = await openArtifact(artifact);
    try {
      // Loaded here because the package is large, and most boots never upload.
      const { google } = await import('googleapis');
      const auth = new google.auth.JWT({
        email: key.clientEmail,
        key: key.privateKey,
        scopes: [DRIVE_SCOPE],
      });
      try {
        await auth.authorize();
      } catch (e) {
        this.d.log.warn({ err: (e as Error).name }, 'Google sign-in failed');
        throw new DriveError(
          'drive_auth_failed',
          'Google sign-in failed. Run the Drive connection test in Settings.',
        );
      }
      const send: Send = async (options) => {
        const res = await auth.request<string>({
          ...options,
          signal,
          timeout: REQUEST_TIMEOUT_MS,
          retry: false,
          responseType: 'text',
          validateStatus: () => true,
        });
        return {
          status: res.status,
          header: (name) => res.headers.get(name),
          text: typeof res.data === 'string' ? res.data : '',
        };
      };
      const file = await this.sendFile(send, handle, input);

      let linkAccess: BuildUpload['linkAccess'] = 'restricted';
      if (this.d.config.getGlobalStored().drive.anyoneWithLink) {
        try {
          await google.drive({ version: 'v3', auth }).permissions.create({
            fileId: file.id,
            supportsAllDrives: true,
            requestBody: { role: 'reader', type: 'anyone' },
          });
          linkAccess = 'anyone';
        } catch (e) {
          // The file is on Drive. Failing here would hide that, and a retry would upload it twice.
          this.d.log.warn({ err: (e as Error).name }, 'could not set anyone-with-the-link');
          linkAccess = 'failed';
        }
      }
      return {
        dryRun: false,
        fileId: file.id,
        webViewLink: file.webViewLink,
        fileName: artifact.fileName,
        sizeBytes: artifact.sizeBytes,
        linkAccess,
        at: input.now,
      };
    } finally {
      await handle.close();
    }
  }

  private async sendFile(
    send: Send,
    handle: FileHandle,
    input: DriveUploadInput,
  ): Promise<{ id: string; webViewLink: string }> {
    const { artifact, folderId, signal, onProgress } = input;
    const total = artifact.sizeBytes;
    const query = new URLSearchParams({
      uploadType: 'resumable',
      supportsAllDrives: 'true',
      fields: 'id,webViewLink',
    });

    let failures = 0;
    /** One attempt. Null: worth trying again, after a pause. */
    const attempt = async (options: Parameters<Send>[0]): Promise<DriveResponse | null> => {
      stoppable(signal);
      let res: DriveResponse | null = null;
      try {
        res = await send(options);
      } catch (e) {
        stoppable(signal);
        this.d.log.warn({ err: (e as Error).name, failures }, 'Drive request failed');
      }
      if (res && !isTransient(res.status)) return res;
      failures += 1;
      if (failures >= MAX_FAILURES) {
        throw new DriveError(
          'drive_unreachable',
          res
            ? `Drive kept answering HTTP ${res.status}. Try the upload again later.`
            : 'Could not reach Google Drive. Check your network and try the upload again.',
        );
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (failures - 1), signal);
      return null;
    };

    let started: DriveResponse | null = null;
    while (!started) {
      started = await attempt({
        url: `${UPLOAD_URL}?${query.toString()}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': APK_MIME,
          'x-upload-content-length': String(total),
        },
        data: JSON.stringify({
          name: artifact.fileName,
          parents: [folderId],
          mimeType: APK_MIME,
        }),
      });
    }
    if (started.status !== 200) throw refusal(started);
    const url = sessionUrl(started);
    failures = 0;

    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let sent = 0;
    let lost = false;
    onProgress(0, total);
    for (;;) {
      let res: DriveResponse | null;
      const asking = lost;
      if (asking) {
        res = await attempt({
          url,
          method: 'PUT',
          headers: { 'content-range': `bytes */${total}` },
        });
      } else {
        const size = Math.min(CHUNK_BYTES, total - sent);
        const chunk = await readChunk(handle, buffer.subarray(0, size), sent);
        res = await attempt({
          url,
          method: 'PUT',
          headers: {
            'content-type': APK_MIME,
            'content-range': `bytes ${sent}-${sent + size - 1}/${total}`,
          },
          data: chunk,
        });
      }
      lost = res === null;
      if (!res) continue;

      if (res.status === 200 || res.status === 201) {
        const file = parseObject(res.text);
        if (
          typeof file.id !== 'string' ||
          typeof file.webViewLink !== 'string' ||
          !file.webViewLink.startsWith('https://')
        ) {
          throw new DriveError(
            'drive_bad_response',
            'Drive stored the file, but its answer had no usable link.',
          );
        }
        onProgress(total, total);
        return { id: file.id, webViewLink: file.webViewLink };
      }
      if (res.status === 404 || res.status === 410) {
        throw new DriveError(
          'upload_session_expired',
          'The Drive upload session expired. Start the upload again.',
        );
      }
      if (res.status !== 308) throw refusal(res);

      const received = receivedBytes(res);
      if (received > sent) {
        failures = 0;
      } else if (!asking) {
        // A chunk went out and Drive kept none of it. Without this count, that could repeat forever.
        failures += 1;
        if (failures >= MAX_FAILURES) {
          throw new DriveError(
            'drive_failed',
            'Drive is not keeping the uploaded data. Try again.',
          );
        }
      }
      sent = received;
      onProgress(sent, total);
    }
  }
}
