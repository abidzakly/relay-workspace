import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AssignedAtOverrideBodySchema,
  KpiExportQuerySchema,
  KpiFocusQuerySchema,
  KpiQuerySchema,
  NotionIdSchema,
} from '@relay/shared';
import type { KpiService } from '../../services/kpiService';
import { parseWith, wrapAction as wrap } from '../errors';

const CardParamsSchema = z.object({ id: NotionIdSchema });

/**
 * KPI. Private listener only, and read from the local cache, apart from the audited local override.
 *  - GET /api/kpi?month=YYYY-MM          scorecard + history; default = the current month
 *  - GET /api/kpi/cards?month=YYYY-MM    SLA table
 *  - GET /api/kpi/focus?limit=           Today's focus
 *  - GET /api/kpi/export?month=&format=  md | csv, as a download
 *  - PUT /api/cards/:id/assigned-at      { assignedAt: epochMs | null }
 */
export function registerKpiRoutes(app: FastifyInstance, deps: { kpi: KpiService }): void {
  const { kpi } = deps;

  app.get('/api/kpi', async (req) => {
    const { month } = parseWith(KpiQuerySchema, req.query);
    return wrap(async () => kpi.report(month));
  });

  app.get('/api/kpi/cards', async (req) => {
    const { month } = parseWith(KpiQuerySchema, req.query);
    return wrap(async () => kpi.cardsTable(month));
  });

  app.get('/api/kpi/focus', async (req) => {
    const { limit } = parseWith(KpiFocusQuerySchema, req.query);
    return kpi.focus(limit);
  });

  app.get('/api/kpi/export', async (req, reply) => {
    const { month, format } = parseWith(KpiExportQuerySchema, req.query);
    const file = await wrap(async () => kpi.export(month, format));
    // The name is built from a month that passed its regex.
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(file.body);
  });

  app.put('/api/cards/:id/assigned-at', async (req) => {
    const { id } = parseWith(CardParamsSchema, req.params);
    const body = parseWith(AssignedAtOverrideBodySchema, req.body);
    return wrap(async () => kpi.setAssignedAt(id, body.assignedAt));
  });
}
