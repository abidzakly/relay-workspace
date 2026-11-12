import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditListQuerySchema, type AuditList } from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { AppDb } from '../../db';
import { getCard } from '../../services/notionStore';
import { normalizeNotionId } from '../../services/notionUrl';
import type { UndoEngine } from '../../services/undoEngine';
import { parseWith, wrapAction as wrap } from '../errors';

const AuditParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * `POST /api/audit/:id/undo` (no body). The engine restores the stored BEFORE state of any
 * undoable write (`mr.resolve`, `card.status`, `card.bulkReady`; later kinds register their own handler). Refusals:
 * 404 `audit_not_found`, 409 `not_undoable` | `already_undone` | `undo_unsupported` | `undo_conflict`
 * (the target was edited elsewhere since: nothing is written).
 */
export function registerUndoRoutes(
  app: FastifyInstance,
  deps: { undo: UndoEngine; audit: AuditWriter; cache: AppDb },
): void {
  /** `GET /api/audit` (Audit view): newest first, filterable. The undo token never leaves the server. */
  app.get('/api/audit', async (req): Promise<AuditList> => {
    const query = parseWith(AuditListQuerySchema, req.query);
    const rows = deps.audit.list(query);
    return {
      entries: rows.map(({ undoToken, ...e }) => {
        const cardId = e.targetType === 'card' ? normalizeNotionId(e.targetId) : null;
        return {
          ...e,
          undoable:
            undoToken !== null && e.undoneAt === null && !e.dryRun && deps.undo.supports(e.action),
          targetLabel: cardId ? (getCard(deps.cache, cardId)?.title ?? null) : null,
        };
      }),
      nextBeforeId: rows.length === query.limit ? (rows[rows.length - 1]?.id ?? null) : null,
      facets: deps.audit.facets(),
    };
  });

  app.post('/api/audit/:id/undo', async (req) => {
    const { id } = parseWith(AuditParamsSchema, req.params);
    return wrap(() => deps.undo.undo(id));
  });
}
