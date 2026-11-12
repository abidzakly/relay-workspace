import { constants, existsSync } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../util/logger';
import { HttpError } from './errors';

const MEDIA_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  // The generated crystals (apps/web/scripts/gen-crystals.mjs): without it the 3D scenes 404 in the built app.
  glb: 'model/gltf-binary',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  woff: 'font/woff',
  woff2: 'font/woff2',
};
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP']);
/** Reserved prefixes: a miss here stays a JSON 404 and never turns into the app's HTML. */
const NEVER_UI = new Set(['api', 'apks']);

/**
 * The decoded URL path -> a file relative to the UI folder, or null for "no such file". A path with no extension is a
 * client-side route and gets `index.html`. A missing asset is a real 404, so a stale chunk fails visibly.
 */
export function uiFileFor(rest: string): string[] | null {
  const trimmed = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  const parts = trimmed === '' ? [] : trimmed.split('/');
  if (NEVER_UI.has(parts[0] ?? '')) return null;
  // Covers `.`, `..` and hidden files. A decoded `%2F` is a separator by now, so it cannot hide a segment.
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => p === '' || p.startsWith('.') || /[\\\u0000-\u001f\u007f]/.test(p))) {
    return null;
  }
  const ext = extname(parts.at(-1) ?? '').slice(1);
  if (ext === '') return ['index.html'];
  return Object.hasOwn(MEDIA_TYPES, ext) ? parts : null;
}

/**
 * The built UI, on the private listener only, so its pages carry the CSP and the Host check from
 * `installSecurity`. No `@fastify/static`: one dependency fewer. As in `/apks`, a symlink cannot lead out: the
 * folder must be its own real path and the file is opened with `O_NOFOLLOW`. Without a build the server still runs, as
 * an API only.
 */
export function registerStaticUi(
  app: FastifyInstance,
  deps: { uiDir: string; log: Logger },
): boolean {
  if (!existsSync(join(deps.uiDir, 'index.html'))) {
    deps.log.warn({ uiDir: deps.uiDir }, 'no UI build found: run `pnpm build` to serve it here');
    return false;
  }

  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    const notFound = new HttpError(404, 'not_found');
    const parts = uiFileFor((req.params as { '*'?: string })['*'] ?? '');
    if (!parts) throw notFound;

    const root = await realpath(deps.uiDir).catch(() => null);
    if (!root) throw notFound;
    const folder = join(root, ...parts.slice(0, -1));
    if ((await realpath(folder).catch(() => null)) !== folder) throw notFound;

    let handle: FileHandle;
    try {
      handle = await open(join(root, ...parts), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (e) {
      if (NOT_FOUND_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw notFound;
      throw e;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw notFound;
      void reply
        .header('content-type', MEDIA_TYPES[extname(parts.at(-1) ?? '').slice(1)])
        .header('content-length', info.size)
        // Only `assets/` has content hashes in its names; index.html, sw.js and theme-init.js must revalidate.
        .header(
          'cache-control',
          parts[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
    } catch (e) {
      await handle.close();
      throw e;
    }
    return reply.send(handle.createReadStream());
  };

  app.get('/', serve);
  app.get('/*', serve);
  return true;
}
