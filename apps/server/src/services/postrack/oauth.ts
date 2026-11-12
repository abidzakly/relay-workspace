import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ConfigStore } from '../../config/store';

/** Encrypted secret holding the OAuth state: client registration, tokens and the pending PKCE verifier. */
export const POSTRACK_OAUTH_SECRET = 'postrack.oauth';

/** Relay's callback route; the origin in front of it is the address the user's browser uses. */
export const POSTRACK_CALLBACK_PATH = '/api/postrack/oauth/callback';

const SCOPE = 'mcp:read mcp:write';

interface Stored {
  /** The redirect URI the client was registered with. A different Relay address needs a new registration. */
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/**
 * The SDK's OAuth client for Postrack, persisted in one encrypted secret. Relay is a public client (no secret) that
 * registers itself (dynamic client registration) and signs in with PKCE.
 *
 * Postrack keeps registered clients in memory, so a Postrack restart forgets Relay: the SDK then calls
 * `invalidateCredentials('client')` and registers again. Objects the SDK hands over are stored unchanged (they carry the
 * `issuer` it checks).
 */
export class PostrackOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK wants the user to sign in (first connect, or the refresh token stopped working). */
  authorizationUrl: URL | null = null;
  private readonly pendingState = randomBytes(24).toString('base64url');

  constructor(
    private readonly config: ConfigStore,
    /** Null outside a connect flow: the provider can then only use and refresh the stored tokens. */
    private readonly redirect: string | null,
  ) {
    if (redirect) {
      const s = this.read();
      // Registered for another Relay address: that registration's redirect URI would be refused.
      if (s.redirectUrl && s.redirectUrl !== redirect) {
        this.write({ tokens: s.tokens });
      }
    }
  }

  private read(): Stored {
    const raw = this.config.getSecret(POSTRACK_OAUTH_SECRET);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Stored;
    } catch {
      return {};
    }
  }

  private write(s: Stored): void {
    const empty = !s.clientInformation && !s.tokens && !s.codeVerifier;
    this.config.setSecret(POSTRACK_OAUTH_SECRET, empty ? null : JSON.stringify(s));
  }

  private patch(p: Partial<Stored>): void {
    this.write({ ...this.read(), ...p });
  }

  get redirectUrl(): string | undefined {
    return this.redirect ?? this.read().redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const uri = this.redirectUrl;
    return {
      client_name: 'Relay',
      redirect_uris: uri ? [uri] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    };
  }

  /** The `state` this flow sends; the callback must bring it back. */
  state(): string {
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.patch({
      clientInformation: info,
      ...(this.redirect ? { redirectUrl: this.redirect } : {}),
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patch({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.patch({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error('No sign-in is in progress. Start Connect again.');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const s = this.read();
    if (scope === 'all') return this.write({});
    if (scope === 'client') return this.write({ ...s, clientInformation: undefined });
    if (scope === 'tokens') return this.write({ ...s, tokens: undefined });
    if (scope === 'verifier') return this.write({ ...s, codeVerifier: undefined });
  }

  /** After a successful sign-in the verifier is spent. */
  clearVerifier(): void {
    this.invalidateCredentials('verifier');
  }

  hasTokens(): boolean {
    return !!this.read().tokens;
  }
}

/** Drops every stored OAuth value (Disconnect, or switching to an API key). */
export function clearPostrackOAuth(config: ConfigStore): void {
  config.setSecret(POSTRACK_OAUTH_SECRET, null);
}

export const POSTRACK_OAUTH_SCOPE = SCOPE;
