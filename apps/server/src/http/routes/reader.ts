import type { FastifyInstance } from 'fastify';
import { ReaderCreateSchema, ReaderIdParamSchema, ReaderUpdateSchema } from '@relay/shared';
import type { ReaderService } from '../../services/readerService';
import { parseWith, wrapAction as wrap } from '../errors';

/** A document's text plus JSON framing; the default body limit is 1 MB. */
const BODY_LIMIT = 2 * 1024 * 1024;

/**
 * Reader library:
 *  - GET    /api/reader         the documents, newest change first (no bodies)
 *  - GET    /api/reader/:id     one document
 *  - POST   /api/reader         { title, format, body }
 *  - PATCH  /api/reader/:id     { title?, format?, body?, lastPos? }
 *  - DELETE /api/reader/:id
 */
export function registerReaderRoutes(app: FastifyInstance, deps: { reader: ReaderService }): void {
  const { reader } = deps;
  const idOf = (params: unknown) => parseWith(ReaderIdParamSchema, params).id;
  app.get('/api/reader', async () => reader.list());
  app.get('/api/reader/:id', async (req) => wrap(async () => reader.get(idOf(req.params))));
  app.post('/api/reader', { bodyLimit: BODY_LIMIT }, async (req) => {
    const body = parseWith(ReaderCreateSchema, req.body);
    return reader.create(body);
  });
  app.patch('/api/reader/:id', { bodyLimit: BODY_LIMIT }, async (req) => {
    const id = idOf(req.params);
    const patch = parseWith(ReaderUpdateSchema, req.body);
    return wrap(async () => reader.update(id, patch));
  });
  app.delete('/api/reader/:id', async (req) => {
    reader.remove(idOf(req.params));
    return { ok: true };
  });
}
