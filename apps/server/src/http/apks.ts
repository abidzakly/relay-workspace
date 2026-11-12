import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { REPO_ID_RE } from '@relay/shared';
import { HttpError } from './errors';

const MEDIA_TYPES = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
} as const;
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP']);

/**
 * Takes the decoded rest of the URL, so `%2F` has already become `/`. Exactly `<repo>/<file>`. The file has no separator
 * or control character, is not hidden (a copy in progress is `.<uuid>.partial`), and is an APK or AAB. Null otherwise.
 */
export function parseApkPath(
  rest: string,
): { repoId: string; fileName: string; ext: keyof typeof MEDIA_TYPES } | null {
  const parts = rest.split('/');
  const [repoId, fileName] = parts;
  if (parts.length !== 2 || repoId === undefined || fileName === undefined) return null;
  if (!REPO_ID_RE.test(repoId)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(fileName) || fileName.startsWith('.')) return null;
  const ext = /\.(apk|aab)$/.exec(fileName)?.[1] as keyof typeof MEDIA_TYPES | undefined;
  return ext ? { repoId, fileName, ext } : null;
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\w .+-]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * `GET /apks/<repo>/<file>`: local downloads from `data/apks/`. Registered on the private listener only, behind
 * its Host allowlist; the webhook listener has one route and this is not it. A wildcard route, because `maxParamLength`
 * would refuse a long file name in a named parameter.
 *
 * Besides the name check, a symlink cannot lead out: the repo folder must be its own real path, and the file is opened
 * with `O_NOFOLLOW`, then checked through that same handle, so nothing can swap in between.
 */
export function registerApkDownloads(app: FastifyInstance, deps: { apksDir: string }): void {
  app.get('/apks/*', async (req, reply) => {
    const parsed = parseApkPath((req.params as { '*': string })['*']);
    if (!parsed) throw new HttpError(400, 'invalid_path', 'Not a valid artifact path');
    const notFound = new HttpError(404, 'not_found', 'No such file');

    const root = await realpath(deps.apksDir).catch(() => null);
    const folder = root && join(root, parsed.repoId);
    if (!folder || (await realpath(folder).catch(() => null)) !== folder) throw notFound;

    let handle: FileHandle;
    try {
      // O_NOFOLLOW does not exist on Windows; the dashboard targets macOS and Linux.
      handle = await open(
        join(folder, parsed.fileName),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (e) {
      if (NOT_FOUND_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw notFound;
      throw e;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw notFound;
      void reply
        .header('content-type', MEDIA_TYPES[parsed.ext])
        .header('content-length', info.size)
        .header('content-disposition', contentDisposition(parsed.fileName))
        // Rebuilding a version replaces the file under the same name.
        .header('cache-control', 'no-store');
    } catch (e) {
      await handle.close();
      throw e;
    }
    return reply.send(handle.createReadStream());
  });
}
