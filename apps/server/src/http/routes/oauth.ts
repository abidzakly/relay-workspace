import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  OAuthConnectBodySchema,
  OAuthProviderSchema,
  type GitlabProjectOption,
  type NotionDataSourceOption,
  type OAuthProvider,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { ConfigStore } from '../../config/store';
import type { HttpClient } from '../../services/httpClient';
import { OAuthError, type OAuthHub } from '../../services/oauth/oauthHub';
import { providerName } from '../../services/oauth/providers';
import { HttpError, parseWith } from '../errors';

const ProviderParams = z.object({ provider: OAuthProviderSchema });
const CallbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});
const ProjectQuery = z.object({ search: z.string().max(100).optional() });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Where "Back to Relay" goes: the card the sign-in started from. */
function backTo(p: OAuthProvider, feature: string | undefined): string {
  if (p === 'google') return feature === 'drive' ? '/settings#drive' : '/settings#calendar';
  return p === 'gitlab' ? '/settings#gitlab' : '/settings#notion';
}

/** The page the provider's redirect lands on. No script (CSP): it says what happened and links back. */
function callbackPage(p: OAuthProvider, ok: boolean, message: string, back: string): string {
  const name = escapeHtml(providerName(p));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay · ${name}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3ee;color:#121212;font:15px/1.5 'Inter Tight',system-ui,sans-serif">
<main style="max-width:26rem;padding:2rem;text-align:center">
<p style="margin:0 0 .5rem;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${ok ? '#3f3aa8' : '#a8261c'}">${ok ? `${name} connected` : 'Not connected'}</p>
<h1 style="margin:0 0 .75rem;font-size:22px;letter-spacing:-.02em">${escapeHtml(message)}</h1>
<p style="margin:0 0 1.5rem;color:#5b5a55">${ok ? 'You can close this tab. Relay already shows the connection.' : 'Go back to Relay and try again.'}</p>
<a href="${back}" style="color:inherit">Back to Relay settings</a>
</main></body></html>`;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * "Connect" sign-ins (private listener; CSRF + Host checks apply to every write):
 *  GET  /api/oauth/status                       every provider: set up, connected, account (never a token)
 *  POST /api/oauth/:provider/connect            { feature? } -> { url } of the provider's sign-in page
 *  GET  /api/oauth/:provider/callback           the provider's redirect (a plain GET, checked by its one-time `state`)
 *  POST /api/oauth/:provider/disconnect         forget (and revoke) the sign-in
 *  GET  /api/oauth/notion/data-sources          what the Notion token can see, for the picker
 *  GET  /api/oauth/gitlab/projects?search=      the GitLab projects the user is a member of, for the picker
 */
export function registerOAuthRoutes(
  app: FastifyInstance,
  deps: { oauth: OAuthHub; store: ConfigStore; http: HttpClient; audit: AuditWriter },
): void {
  const { oauth } = deps;
  const audit = (action: string, provider: OAuthProvider, after: unknown = null) =>
    deps.audit.write({
      actor: 'user',
      action,
      targetType: 'settings',
      targetId: `oauth.${provider}`,
      before: null,
      after,
    });

  app.get('/api/oauth/status', async () => oauth.status());

  app.post('/api/oauth/:provider/connect', async (req) => {
    const { provider } = parseWith(ProviderParams, req.params);
    const { feature } = parseWith(OAuthConnectBodySchema, req.body ?? {});
    try {
      return { url: oauth.begin(provider, feature) };
    } catch (e) {
      if (e instanceof OAuthError) throw new HttpError(422, 'oauth_not_ready', e.message);
      throw e;
    }
  });

  app.get('/api/oauth/:provider/callback', async (req, reply) => {
    const { provider } = parseWith(ProviderParams, req.params);
    const q = parseWith(CallbackQuery, req.query);
    void reply.type('text/html; charset=utf-8');
    const name = providerName(provider);
    if (q.error || !q.code || !q.state) {
      return callbackPage(
        provider,
        false,
        q.error === 'access_denied' ? 'You declined access.' : `${name} did not sign you in.`,
        backTo(provider, undefined),
      );
    }
    try {
      const { account, feature } = await oauth.finish(provider, q.code, q.state);
      audit('oauth.connected', provider, { account, feature: feature ?? null });
      return callbackPage(
        provider,
        true,
        account ? `Signed in as ${account}` : `${name} connected`,
        backTo(provider, feature),
      );
    } catch (e) {
      void reply.code(400);
      const msg = e instanceof OAuthError ? e.message : 'Something went wrong while connecting.';
      return callbackPage(provider, false, msg, backTo(provider, undefined));
    }
  });

  app.post('/api/oauth/:provider/disconnect', async (req) => {
    const { provider } = parseWith(ProviderParams, req.params);
    await oauth.disconnect(provider);
    audit('oauth.disconnected', provider);
    return oauth.status();
  });

  app.get('/api/oauth/notion/data-sources', async (): Promise<NotionDataSourceOption[]> => {
    const g = deps.store.getGlobal();
    const token = g.notion.token;
    if (!token) throw new HttpError(422, 'notion_not_connected', 'Connect Notion first.');
    const res = await deps.http.send({
      method: 'POST',
      url: 'https://api.notion.com/v1/search',
      headers: { authorization: `Bearer ${token}`, 'notion-version': g.notion.version },
      body: { filter: { property: 'object', value: 'data_source' }, page_size: 100 },
    });
    if (res.status === 401) {
      void oauth.invalidate('notion');
      throw new HttpError(502, 'notion_denied', 'Notion refused the sign-in. Connect again.');
    }
    if (res.status !== 200)
      throw new HttpError(502, 'notion_failed', `Notion answered HTTP ${res.status}.`);
    const results = Array.isArray(rec(res.json).results)
      ? (rec(res.json).results as unknown[])
      : [];
    return results.flatMap((r) => {
      const o = rec(r);
      const id = str(o.id);
      if (!id) return [];
      const title = Array.isArray(o.title)
        ? o.title.map((t) => str(rec(t).plain_text) ?? '').join('')
        : '';
      return [{ id, title: title || '(Untitled)', url: str(o.url) ?? null }];
    });
  });

  app.get('/api/oauth/gitlab/projects', async (req): Promise<GitlabProjectOption[]> => {
    const { search } = parseWith(ProjectQuery, req.query);
    const host = deps.store.getGlobalStored().gitlab.host;
    const token = oauth.isConnected('gitlab')
      ? await oauth.accessToken('gitlab').catch(() => undefined)
      : deps.store.getReviewerToken();
    if (!host || !token) throw new HttpError(422, 'gitlab_not_connected', 'Connect GitLab first.');
    const q = new URLSearchParams({
      membership: 'true',
      simple: 'true',
      per_page: '50',
      order_by: 'last_activity_at',
      ...(search ? { search } : {}),
    });
    const res = await deps.http.send({
      url: `${host.replace(/\/+$/, '')}/api/v4/projects?${q.toString()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      void oauth.invalidate('gitlab');
      throw new HttpError(502, 'gitlab_denied', 'GitLab refused the sign-in. Connect again.');
    }
    if (res.status !== 200)
      throw new HttpError(502, 'gitlab_failed', `GitLab answered HTTP ${res.status}.`);
    const list = Array.isArray(res.json) ? (res.json as unknown[]) : [];
    return list.flatMap((r) => {
      const o = rec(r);
      const id = typeof o.id === 'number' ? o.id : undefined;
      const path = str(o.path_with_namespace);
      const url = str(o.http_url_to_repo);
      if (id === undefined || !path || !url) return [];
      return [
        {
          id,
          pathWithNamespace: path,
          name: str(o.name) ?? path,
          httpUrlToRepo: url,
          defaultBranch: str(o.default_branch) ?? null,
        },
      ];
    });
  });
}
