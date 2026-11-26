import { createHash, randomBytes } from 'node:crypto';
import {
  GOOGLE_FEATURES,
  OAUTH_PROVIDERS,
  type GoogleFeature,
  type OAuthConnection,
  type OAuthProvider,
  type OAuthStatus,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { Logger } from '../../util/logger';
import type { HttpClient } from '../httpClient';
import {
  authorizeUrl,
  CALENDAR_LIST_SCOPE,
  exchangeCode,
  gitlabUsername,
  GOOGLE_FEATURE_SCOPES,
  OAuthError,
  providerName,
  refreshToken,
  revokeToken,
  type OAuthClient,
  type ProviderContext,
  type TokenResult,
} from './providers';

/**
 * One place for the "Connect" sign-ins (Google, GitLab, Notion). The OAuth clients come from `.env`; the tokens of the
 * signed-in user are kept encrypted in one `settings` row per provider (`secret.oauth.<provider>`), so no migration:
 *   { accessToken, expiresAt, refreshToken, scopes, account, connectedAt, verifier }
 * Access tokens that expire (GitLab: 2 h, Google: 1 h) are refreshed ahead of time by a light timer, so the sync
 * readers that need a token *now* (`currentToken`) always find a valid one.
 */

const OAUTH_TTL_MS = 10 * 60_000;
const TICK_MS = 60_000;
/** Refresh this long before expiry, so a sync reader never sees an expired token. */
const REFRESH_AHEAD_MS = 10 * 60_000;
const secretKey = (p: OAuthProvider) => `oauth.${p}`;

export interface OAuthClients {
  google?: OAuthClient;
  gitlab?: OAuthClient;
  notion?: OAuthClient;
}

interface Stored {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string | null;
  scopes: string[];
  account: string | null;
  connectedAt: number;
  /** GitLab repeats the PKCE verifier on refresh. */
  verifier?: string;
}

interface Pending {
  provider: OAuthProvider;
  verifier: string;
  feature: GoogleFeature | undefined;
  at: number;
}

export interface OAuthHubDeps {
  config: Pick<ConfigStore, 'getGlobalStored' | 'getSecret' | 'setSecret'>;
  http: HttpClient;
  log: Logger;
  clients: OAuthClients;
  /** `http://127.0.0.1:<port>`: the callback is `<base>/api/oauth/<provider>/callback`. */
  redirectBase: string;
  /** Per-provider redirect override (Notion, when it refuses a loopback address). */
  redirectOverride?: Partial<Record<OAuthProvider, string>>;
  /** Called after a connect, disconnect or lost sign-in. */
  onChange?: (provider: OAuthProvider) => void;
  now?: () => number;
}

export class OAuthHub {
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly errors = new Map<OAuthProvider, string>();
  private readonly refreshing = new Map<OAuthProvider, Promise<string>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly d: OAuthHubDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.refreshDue().finally(() => {
        if (this.timer) this.timer = setTimeout(tick, TICK_MS);
      });
    };
    this.timer = setTimeout(tick, 1_000);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async refreshDue(): Promise<void> {
    for (const p of OAUTH_PROVIDERS) {
      const s = this.read(p);
      if (!s?.refreshToken || s.expiresAt === null) continue;
      if (s.expiresAt - this.now() > REFRESH_AHEAD_MS) continue;
      try {
        await this.refresh(p);
      } catch {
        /* kept in `errors`; the next tick tries again */
      }
    }
  }

  // ───────────────────────────── status ─────────────────────────────

  redirectUri(p: OAuthProvider): string {
    return this.d.redirectOverride?.[p] ?? `${this.d.redirectBase}/api/oauth/${p}/callback`;
  }

  private context(p: OAuthProvider): ProviderContext {
    const client = this.d.clients[p];
    if (!client) throw new OAuthError(`${providerName(p)} sign-in is not set up in .env yet.`);
    return {
      client,
      redirectUri: this.redirectUri(p),
      gitlabHost: this.d.config.getGlobalStored().gitlab.host,
    };
  }

  private unavailableReason(p: OAuthProvider): string | null {
    const env: Record<OAuthProvider, string> = {
      google: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET',
      gitlab: 'GITLAB_OAUTH_CLIENT_ID',
      notion: 'NOTION_OAUTH_CLIENT_ID and NOTION_OAUTH_CLIENT_SECRET',
    };
    if (!this.d.clients[p]) return `Not set up yet: set ${env[p]} in .env (see docs/CONNECT.md).`;
    if (p === 'gitlab' && !this.d.config.getGlobalStored().gitlab.host)
      return 'Set the GitLab host first.';
    return null;
  }

  connection(p: OAuthProvider): OAuthConnection {
    const s = this.read(p);
    const reason = this.unavailableReason(p);
    return {
      provider: p,
      available: reason === null,
      unavailableReason: reason,
      connected: !!s,
      account: s?.account ?? null,
      features: p === 'google' && s ? this.googleFeatures(s) : [],
      connectedAt: s?.connectedAt ?? null,
      lastError: this.errors.get(p) ?? null,
      redirectUri: this.redirectUri(p),
    };
  }

  status(): OAuthStatus {
    return {
      google: this.connection('google'),
      gitlab: this.connection('gitlab'),
      notion: this.connection('notion'),
    };
  }

  isConnected(p: OAuthProvider): boolean {
    return !!this.read(p);
  }

  /** Google: the grant covers this feature (Calendar, Drive). */
  hasGoogleFeature(f: GoogleFeature): boolean {
    const s = this.read('google');
    return !!s && this.googleFeatures(s).includes(f);
  }

  private googleFeatures(s: Stored): GoogleFeature[] {
    return GOOGLE_FEATURES.filter((f) => s.scopes.includes(GOOGLE_FEATURE_SCOPES[f]));
  }

  // ───────────────────────────── sign-in ─────────────────────────────

  /** The provider's sign-in page to open. Google asks for one feature; it adds to what was granted before. */
  begin(p: OAuthProvider, feature?: GoogleFeature): string {
    const reason = this.unavailableReason(p);
    if (reason) throw new OAuthError(reason);
    this.prune();
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const f = p === 'google' ? (feature ?? 'calendar') : undefined;
    this.pending.set(state, { provider: p, verifier, feature: f, at: this.now() });
    const scopes: string[] = [];
    if (p === 'google') {
      // Ask again for what is granted already, so a lost grant comes back with the new one.
      const had = this.read('google');
      for (const g of had ? this.googleFeatures(had) : []) scopes.push(GOOGLE_FEATURE_SCOPES[g]);
      if (f) scopes.push(GOOGLE_FEATURE_SCOPES[f]);
      // Calendar also lists the calendars, for the picker. Not part of "has Calendar": older grants keep working.
      if (scopes.includes(GOOGLE_FEATURE_SCOPES.calendar)) scopes.push(CALENDAR_LIST_SCOPE);
    }
    return authorizeUrl(p, this.context(p), { state, challenge, scopes: [...new Set(scopes)] });
  }

  /** The provider's redirect: checks the one-time `state`, trades the code for tokens and keeps them. */
  async finish(
    p: OAuthProvider,
    code: string,
    state: string,
  ): Promise<{ account: string | null; feature: GoogleFeature | undefined }> {
    this.prune();
    const pend = this.pending.get(state);
    this.pending.delete(state);
    if (!pend || pend.provider !== p)
      throw new OAuthError('This sign-in link expired. Start again from Settings.');
    const ctx = this.context(p);
    const t = await exchangeCode(
      this.d.http,
      p,
      ctx,
      { code, verifier: pend.verifier },
      this.now(),
    );
    if (p === 'google' && !t.refreshToken)
      throw new OAuthError('Google did not hand out offline access. Try connecting again.');
    let account = t.account ?? null;
    if (p === 'gitlab') account = (await gitlabUsername(this.d.http, ctx, t.accessToken)) ?? null;
    const before = this.read(p);
    this.write(p, {
      accessToken: t.accessToken,
      expiresAt: t.expiresAt,
      refreshToken: t.refreshToken ?? null,
      scopes: t.scopes ?? before?.scopes ?? [],
      account,
      connectedAt: this.now(),
      ...(p === 'gitlab' ? { verifier: pend.verifier } : {}),
    });
    this.errors.delete(p);
    this.d.log.info({ provider: p }, 'oauth connected');
    this.d.onChange?.(p);
    return { account, feature: pend.feature };
  }

  async disconnect(p: OAuthProvider): Promise<void> {
    const s = this.read(p);
    this.d.config.setSecret(secretKey(p), null);
    this.errors.delete(p);
    if (s && this.d.clients[p]) {
      try {
        await revokeToken(this.d.http, p, this.context(p), s.refreshToken ?? s.accessToken);
      } catch {
        /* no client or host any more: nothing to revoke against */
      }
    }
    this.d.onChange?.(p);
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (t - v.at > OAUTH_TTL_MS) this.pending.delete(k);
  }

  // ───────────────────────────── tokens ─────────────────────────────

  /** A valid access token, refreshed when needed. Throws `OAuthError` when not connected. */
  async accessToken(p: OAuthProvider): Promise<string> {
    const s = this.read(p);
    if (!s) throw new OAuthError(`${providerName(p)} is not connected.`);
    if (s.expiresAt === null || s.expiresAt > this.now()) return s.accessToken;
    return this.refresh(p);
  }

  /** For readers that cannot wait (config getters): the stored token while it is valid. The timer keeps it fresh. */
  currentToken(p: OAuthProvider): string | undefined {
    const s = this.read(p);
    if (!s) return undefined;
    if (s.expiresAt !== null && s.expiresAt <= this.now()) {
      void this.refresh(p).catch(() => undefined);
      return undefined;
    }
    return s.accessToken;
  }

  /** The provider refused the access token (401): refresh now instead of at expiry. */
  async invalidate(p: OAuthProvider): Promise<void> {
    const s = this.read(p);
    if (!s?.refreshToken) return;
    await this.refresh(p).catch(() => undefined);
  }

  /** One refresh per provider at a time (GitLab and Notion rotate the refresh token: two at once would lose it). */
  private refresh(p: OAuthProvider): Promise<string> {
    const running = this.refreshing.get(p);
    if (running) return running;
    const job = this.doRefresh(p).finally(() => this.refreshing.delete(p));
    this.refreshing.set(p, job);
    return job;
  }

  private async doRefresh(p: OAuthProvider): Promise<string> {
    const s = this.read(p);
    if (!s) throw new OAuthError(`${providerName(p)} is not connected.`);
    if (!s.refreshToken) {
      this.lost(p, `${providerName(p)} sign-in expired. Connect again.`);
      throw new OAuthError(`${providerName(p)} sign-in expired. Connect again.`, true);
    }
    let t: TokenResult;
    try {
      t = await refreshToken(
        this.d.http,
        p,
        this.context(p),
        { refreshToken: s.refreshToken, ...(s.verifier ? { verifier: s.verifier } : {}) },
        this.now(),
      );
    } catch (e) {
      const msg =
        e instanceof OAuthError ? e.message : `${providerName(p)} could not be reached to refresh.`;
      if (e instanceof OAuthError && e.revoked) this.lost(p, msg);
      else this.errors.set(p, msg);
      throw e instanceof OAuthError ? e : new OAuthError(msg);
    }
    this.write(p, {
      ...s,
      accessToken: t.accessToken,
      expiresAt: t.expiresAt,
      refreshToken: t.refreshToken ?? s.refreshToken,
      scopes: t.scopes ?? s.scopes,
    });
    this.errors.delete(p);
    return t.accessToken;
  }

  /** Revoked at the provider: forget it, so the card says "Connect" again. */
  private lost(p: OAuthProvider, message: string): void {
    this.d.config.setSecret(secretKey(p), null);
    this.errors.set(p, message);
    this.d.log.warn({ provider: p }, 'oauth sign-in lost');
    this.d.onChange?.(p);
  }

  private read(p: OAuthProvider): Stored | undefined {
    const raw = this.d.config.getSecret(secretKey(p));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Stored;
    } catch {
      return undefined;
    }
  }

  private write(p: OAuthProvider, s: Stored): void {
    this.d.config.setSecret(secretKey(p), JSON.stringify(s));
  }
}

export { OAuthError };
