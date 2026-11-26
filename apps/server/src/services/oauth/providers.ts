import type { GoogleFeature, OAuthProvider } from '@relay/shared';
import type { HttpClient } from '../httpClient';

/**
 * The three sign-in providers as plain REST (authorization code flow, PKCE where the provider has it). Endpoints are
 * fixed here, except GitLab's, which is the GitLab host from Settings: nothing from a response chooses where a token
 * or secret is sent.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const NOTION_REVOKE_URL = 'https://api.notion.com/v1/oauth/revoke';

/** Read-only calendar; Drive only sees the files and folders Relay itself creates (`drive.file`, no Google review). */
export const GOOGLE_FEATURE_SCOPES: Record<GoogleFeature, string> = {
  calendar: 'https://www.googleapis.com/auth/calendar.events.readonly',
  drive: 'https://www.googleapis.com/auth/drive.file',
};
/** Lists the calendars (names and ids only), so they are picked instead of typed. */
export const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const GOOGLE_BASE_SCOPES = ['openid', 'email'];
/** Merge requests, comments, approvals, webhooks and git over HTTPS all need `api`. */
const GITLAB_SCOPES = 'api';

/** A sign-in error worded for a person. Never carries a token or a response body. */
export class OAuthError extends Error {
  constructor(
    message: string,
    /** The refresh token is no longer valid: the user must connect again. */
    readonly revoked = false,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface OAuthClient {
  clientId: string;
  /** Absent for a GitLab application registered as non-confidential. */
  clientSecret?: string;
}

/** What a provider needs to know about the moment: the GitLab host, the redirect address. */
export interface ProviderContext {
  client: OAuthClient;
  redirectUri: string;
  gitlabHost: string | undefined;
}

export interface TokenResult {
  accessToken: string;
  /** Null: the token does not expire (Notion, without refresh). */
  expiresAt: number | null;
  refreshToken?: string;
  /** Granted scopes, when the provider says. */
  scopes?: string[];
  account?: string;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const PROVIDER_NAMES: Record<OAuthProvider, string> = {
  google: 'Google',
  gitlab: 'GitLab',
  notion: 'Notion',
};
export const providerName = (p: OAuthProvider) => PROVIDER_NAMES[p];

/** The e-mail claim of Google's id_token. It came straight from the token endpoint over TLS, so it is not re-verified. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    return str(rec(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).email);
  } catch {
    return undefined;
  }
}

function gitlabBase(ctx: ProviderContext): string {
  if (!ctx.gitlabHost) throw new OAuthError('Set the GitLab host in Settings first.');
  return ctx.gitlabHost.replace(/\/+$/, '');
}

export function authorizeUrl(
  provider: OAuthProvider,
  ctx: ProviderContext,
  o: { state: string; challenge: string; scopes: string[] },
): string {
  const common = {
    client_id: ctx.client.clientId,
    redirect_uri: ctx.redirectUri,
    response_type: 'code',
    state: o.state,
  };
  if (provider === 'google') {
    const q = new URLSearchParams({
      ...common,
      scope: [...GOOGLE_BASE_SCOPES, ...o.scopes].join(' '),
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
      // A refresh token every time: Relay keeps working after the browser tab is gone.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return `${GOOGLE_AUTH_URL}?${q.toString()}`;
  }
  if (provider === 'gitlab') {
    const q = new URLSearchParams({
      ...common,
      scope: GITLAB_SCOPES,
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
    });
    return `${gitlabBase(ctx)}/oauth/authorize?${q.toString()}`;
  }
  const q = new URLSearchParams({ ...common, owner: 'user' });
  return `${NOTION_AUTH_URL}?${q.toString()}`;
}

function basicAuth(client: OAuthClient): string {
  return `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret ?? ''}`).toString('base64')}`;
}

async function tokenCall(
  http: HttpClient,
  provider: OAuthProvider,
  ctx: ProviderContext,
  grant: Record<string, string>,
  now: number,
): Promise<TokenResult> {
  const name = providerName(provider);
  const { client } = ctx;
  let res;
  if (provider === 'notion') {
    res = await http.send({
      method: 'POST',
      url: NOTION_TOKEN_URL,
      headers: { authorization: basicAuth(client), 'content-type': 'application/json' },
      body: grant,
      maxRetries: 0,
    });
  } else {
    const form: Record<string, string> = { ...grant, client_id: client.clientId };
    if (client.clientSecret) form.client_secret = client.clientSecret;
    res = await http.send({
      method: 'POST',
      url: provider === 'google' ? GOOGLE_TOKEN_URL : `${gitlabBase(ctx)}/oauth/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      maxRetries: 0,
    });
  }
  const j = rec(res.json);
  const accessToken = str(j.access_token);
  if (res.status === 200 && accessToken) {
    const secs = typeof j.expires_in === 'number' ? j.expires_in : null;
    const refreshToken = str(j.refresh_token);
    const scope = str(j.scope);
    let account: string | undefined;
    if (provider === 'google') account = emailFromIdToken(str(j.id_token));
    if (provider === 'notion') {
      const user = rec(rec(j.owner).user);
      const who = str(rec(user.person).email) ?? str(user.name);
      const ws = str(j.workspace_name);
      account = who && ws ? `${who} · ${ws}` : (who ?? ws);
    }
    return {
      accessToken,
      // A minute early: a token that expires in flight would fail the call.
      expiresAt: secs === null ? null : now + Math.max(60, secs - 60) * 1000,
      ...(refreshToken ? { refreshToken } : {}),
      ...(scope ? { scopes: scope.split(/[\s,]+/).filter(Boolean) } : {}),
      ...(account ? { account } : {}),
    };
  }
  const err = str(j.error);
  if (err === 'invalid_grant')
    throw new OAuthError(`${name} no longer accepts this sign-in. Connect again.`, true);
  if (err === 'invalid_client' || err === 'unauthorized_client')
    throw new OAuthError(`${name} rejected Relay's OAuth client. Check the client values in .env.`);
  throw new OAuthError(`${name} sign-in failed (${err ?? `HTTP ${res.status}`}).`);
}

export function exchangeCode(
  http: HttpClient,
  provider: OAuthProvider,
  ctx: ProviderContext,
  o: { code: string; verifier: string },
  now: number,
): Promise<TokenResult> {
  const grant: Record<string, string> = {
    grant_type: 'authorization_code',
    code: o.code,
    redirect_uri: ctx.redirectUri,
  };
  if (provider !== 'notion') grant.code_verifier = o.verifier;
  return tokenCall(http, provider, ctx, grant, now);
}

export function refreshToken(
  http: HttpClient,
  provider: OAuthProvider,
  ctx: ProviderContext,
  o: { refreshToken: string; verifier?: string },
  now: number,
): Promise<TokenResult> {
  const grant: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
  };
  if (provider === 'gitlab') {
    // GitLab's PKCE refresh repeats the redirect and the verifier of the first exchange.
    grant.redirect_uri = ctx.redirectUri;
    if (o.verifier) grant.code_verifier = o.verifier;
  }
  return tokenCall(http, provider, ctx, grant, now);
}

/** The GitLab username behind a token. */
export async function gitlabUsername(
  http: HttpClient,
  ctx: ProviderContext,
  accessToken: string,
): Promise<string | undefined> {
  try {
    const res = await http.send({
      url: `${gitlabBase(ctx)}/api/v4/user`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return res.status === 200 ? str(rec(res.json).username) : undefined;
  } catch {
    return undefined;
  }
}

/** Best effort: disconnecting must work even when the provider cannot be reached. */
export async function revokeToken(
  http: HttpClient,
  provider: OAuthProvider,
  ctx: ProviderContext,
  token: string,
): Promise<void> {
  try {
    if (provider === 'google') {
      await http.send({
        method: 'POST',
        url: GOOGLE_REVOKE_URL,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        maxRetries: 0,
      });
    } else if (provider === 'gitlab') {
      const form: Record<string, string> = { token, client_id: ctx.client.clientId };
      if (ctx.client.clientSecret) form.client_secret = ctx.client.clientSecret;
      await http.send({
        method: 'POST',
        url: `${gitlabBase(ctx)}/oauth/revoke`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        maxRetries: 0,
      });
    } else {
      await http.send({
        method: 'POST',
        url: NOTION_REVOKE_URL,
        headers: { authorization: basicAuth(ctx.client), 'content-type': 'application/json' },
        body: { token },
        maxRetries: 0,
      });
    }
  } catch {
    /* offline, or no host any more: the token stays valid there until it expires or is removed there */
  }
}
