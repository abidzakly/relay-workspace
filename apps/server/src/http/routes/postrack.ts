import type { FastifyInstance } from 'fastify';
import {
  POSTRACK_SESSION_TOKEN_HEADER,
  PostrackOAuthStartSchema,
  PostrackSaveSchema,
  SECRET_MASK,
} from '@relay/shared';
import { z } from 'zod';
import type { AuditWriter } from '../../audit/auditLog';
import type { PostrackAgentTools } from '../../services/postrack/agentTools';
import type { PostrackService } from '../../services/postrack/postrackService';
import { HttpError, parseWith, wrapAction } from '../errors';

const WsParams = z.object({ id: z.string().min(1).max(200) });
const TreeQuery = z.object({ force: z.enum(['1']).optional() });
const CallBody = z
  .object({
    name: z.string().regex(/^[a-z_]{1,64}$/),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const CallbackQuery = z.object({
  code: z.string().min(1).max(4_000).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
});

/** Where the sign-in popup lands: a page of the web app that tells the opener and closes itself. */
const DONE_PAGE = '/postrack/connected';

/**
 * Postrack (private listener; CSRF + Host checks apply to every write):
 *  GET    /api/postrack                       status (never a secret)
 *  PUT    /api/postrack  { url, apiKey? }     API-key mode: checked with Postrack, then saved
 *  DELETE /api/postrack                       forget the credentials
 *  POST   /api/postrack/oauth/start           { url, origin } -> { authorizationUrl }
 *  GET    /api/postrack/oauth/callback        Postrack sends the browser back here
 *  GET    /api/postrack/workspaces            for the endpoint picker
 *  GET    /api/postrack/workspaces/:id/tree
 *  POST   /api/agent-tools/postrack/list|call the agent's proxy process, with its session token (loopback)
 */
export function registerPostrackRoutes(
  app: FastifyInstance,
  deps: { postrack: PostrackService; tools: PostrackAgentTools; audit: AuditWriter },
): void {
  const { postrack } = deps;
  const audit = (action: string, after: unknown = null) =>
    deps.audit.write({
      actor: 'user',
      action,
      targetType: 'settings',
      targetId: 'postrack',
      before: null,
      after,
    });

  app.get('/api/postrack', async () => postrack.status());

  app.put('/api/postrack', async (req) => {
    const b = parseWith(PostrackSaveSchema, req.body);
    const key = b.apiKey === SECRET_MASK ? undefined : b.apiKey;
    const st = await wrapAction(() => postrack.saveApiKey(b.url, key));
    audit(key === null ? 'postrack.apiKeyCleared' : 'postrack.apiKeySaved', { url: b.url });
    return st;
  });

  app.delete('/api/postrack', async () => {
    postrack.disconnect();
    audit('postrack.disconnected');
    return postrack.status();
  });

  app.post('/api/postrack/oauth/start', async (req) => {
    const b = parseWith(PostrackOAuthStartSchema, req.body);
    // The callback must come back to the address the browser is on, which the Host/Origin checks already allow.
    const origin = req.headers.origin;
    if (origin && origin.toLowerCase() !== b.origin.toLowerCase()) {
      throw new HttpError(400, 'bad_origin', 'The origin does not match this page.');
    }
    return wrapAction(() => postrack.startOAuth(b.url, b.origin));
  });

  app.get('/api/postrack/oauth/callback', async (req, reply) => {
    const q = parseWith(CallbackQuery, req.query);
    const back = (error?: string) =>
      reply.redirect(
        error ? `${DONE_PAGE}?error=${encodeURIComponent(error.slice(0, 300))}` : DONE_PAGE,
      );
    if (q.error) return back(q.error_description ?? q.error);
    if (!q.code || !q.state) return back('Postrack sent no sign-in code.');
    try {
      await postrack.finishOAuth(q.code, q.state);
    } catch (e) {
      return back((e as Error).message);
    }
    audit('postrack.connected', { mode: 'oauth' });
    return back();
  });

  app.get('/api/postrack/workspaces', async () =>
    wrapAction(async () => ({ items: await postrack.workspaces() })),
  );

  app.get('/api/postrack/workspaces/:id/tree', async (req) => {
    const { id } = parseWith(WsParams, req.params);
    const { force } = parseWith(TreeQuery, req.query);
    return wrapAction(() => postrack.tree(id, force === '1'));
  });

  const sessionToken = (h: unknown) => (typeof h === 'string' ? h : undefined);
  app.post('/api/agent-tools/postrack/list', async (req) =>
    wrapAction(() => deps.tools.list(sessionToken(req.headers[POSTRACK_SESSION_TOKEN_HEADER]))),
  );
  app.post('/api/agent-tools/postrack/call', async (req) => {
    const b = parseWith(CallBody, req.body);
    return wrapAction(() =>
      deps.tools.call(
        sessionToken(req.headers[POSTRACK_SESSION_TOKEN_HEADER]),
        b.name,
        b.arguments,
      ),
    );
  });
}
