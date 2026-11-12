import type { FastifyInstance } from 'fastify';
import { ScriptsSaveRequestSchema } from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { ScriptConfigService } from '../../services/scriptConfig';
import { HttpError, parseWith } from '../errors';

/**
 * Release scripts (private listener; CSRF + Host checks apply):
 *  GET /api/scripts            fields (never a secret's value), env file, which vu runs, missing tools
 *  PUT /api/scripts { values } save typed values (`null` = back to Settings), then re-write the env file
 */
export function registerScriptRoutes(
  app: FastifyInstance,
  deps: { scripts: ScriptConfigService; audit: AuditWriter },
): void {
  app.get('/api/scripts', async () => deps.scripts.status());

  app.put('/api/scripts', async (req) => {
    const { values } = parseWith(ScriptsSaveRequestSchema, req.body);
    try {
      const status = await deps.scripts.save(values);
      // Keys only: values (some are secrets) never reach the audit log.
      deps.audit.write({
        actor: 'user',
        action: 'settings.scripts',
        targetType: 'settings',
        targetId: 'scripts',
        before: null,
        after: { keys: Object.keys(values) },
      });
      return status;
    } catch (e) {
      throw new HttpError(400, 'invalid_value', (e as Error).message);
    }
  });
}
