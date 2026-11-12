import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  PostrackTreeSchema,
  PostrackWorkspaceSchema,
  type PostrackAuthMode,
  type PostrackStatus,
  type PostrackTree,
  type PostrackWorkspace,
} from '@relay/shared';
import { z } from 'zod';
import type { ConfigStore } from '../../config/store';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import {
  clearPostrackOAuth,
  POSTRACK_CALLBACK_PATH,
  POSTRACK_OAUTH_SCOPE,
  PostrackOAuthProvider,
} from './oauth';

/** Encrypted secret: the bearer key of a Postrack server that sets `MCP_API_KEY`. */
const API_KEY_SECRET = 'postrack.apiKey';
const TREE_TTL_MS = 60_000;
const FLOW_TTL_MS = 15 * 60_000;
const CALL_TIMEOUT_MS = 30_000;

/** A Postrack call that failed for a reason the user can act on. Mapped 1:1 to the HTTP error body. */
export class PostrackError extends ActionError {
  constructor(
    code: 'postrack_not_connected' | 'postrack_unreachable' | 'postrack_refused',
    message: string,
  ) {
    super(code === 'postrack_not_connected' ? 409 : 502, code, message, { postrack: code });
    this.name = 'PostrackError';
  }
}

/**
 * Relay's connection to a Postrack MCP server (Streamable HTTP). One cached client; it is rebuilt when the settings
 * change or a call fails. OAuth tokens are refreshed by the SDK; when the refresh token stops working the next call
 * says "not connected" and the UI shows Connect again.
 */
export class PostrackService {
  private conn: { key: string; client: Client } | null = null;
  private generation = 0;
  private readonly trees = new Map<string, { at: number; tree: PostrackTree }>();
  /** Sign-ins in progress, by OAuth `state`. */
  private readonly flows = new Map<string, { url: string; redirect: string; at: number }>();

  constructor(private readonly d: { config: ConfigStore; log: Logger; now?: () => number }) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  enabled(): boolean {
    return this.d.config.getGlobalStored().features.postrack;
  }

  url(): string | null {
    return this.d.config.getGlobalStored().postrack.url ?? null;
  }

  /** API key wins when both are stored (saving one clears the other, so that only happens mid-switch). */
  mode(): PostrackAuthMode | null {
    if (this.d.config.getSecret(API_KEY_SECRET)) return 'apiKey';
    if (new PostrackOAuthProvider(this.d.config, null).hasTokens()) return 'oauth';
    return null;
  }

  /** Configured enough to try: a URL and some credential. Says nothing about whether they still work. */
  configured(): boolean {
    return this.url() !== null && this.mode() !== null;
  }

  private reset(): void {
    this.generation += 1;
    const c = this.conn;
    this.conn = null;
    this.trees.clear();
    if (c) void c.client.close().catch(() => undefined);
  }

  private transportFor(url: string, mode: PostrackAuthMode): StreamableHTTPClientTransport {
    if (mode === 'apiKey') {
      const key = this.d.config.getSecret(API_KEY_SECRET) ?? '';
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
    }
    return new StreamableHTTPClientTransport(new URL(url), {
      authProvider: new PostrackOAuthProvider(this.d.config, null),
    });
  }

  private async client(): Promise<Client> {
    const url = this.url();
    const mode = this.mode();
    if (!url || !mode) {
      throw new PostrackError('postrack_not_connected', 'Postrack is not connected yet.');
    }
    const key = `${this.generation}|${url}|${mode}`;
    if (this.conn?.key === key) return this.conn.client;
    if (this.conn) this.reset();
    const client = new Client({ name: 'relay', version: '1' });
    try {
      await client.connect(this.transportFor(url, mode), { timeout: CALL_TIMEOUT_MS });
    } catch (e) {
      throw this.explain(e);
    }
    this.conn = { key: `${this.generation}|${url}|${mode}`, client };
    return client;
  }

  /** A failure as the user should read it. Never includes a credential. */
  private explain(e: unknown): PostrackError {
    if (e instanceof PostrackError) return e;
    const msg = (e as Error)?.message ?? String(e);
    if (e instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed|invalid_token/i.test(msg)) {
      return new PostrackError(
        'postrack_not_connected',
        this.mode() === 'apiKey'
          ? 'Postrack refused the API key. Check it, or connect with your Postrack account instead.'
          : 'The Postrack sign-in expired. Connect again.',
      );
    }
    if (/\b403\b/.test(msg)) {
      return new PostrackError(
        'postrack_refused',
        `Postrack refused the call: ${msg.slice(0, 300)}`,
      );
    }
    return new PostrackError(
      'postrack_unreachable',
      `Postrack could not be reached: ${msg.slice(0, 300)}`,
    );
  }

  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.client();
    try {
      return await fn(c);
    } catch (e) {
      // The next call starts a fresh connection (an expired session, a restarted server).
      this.reset();
      throw this.explain(e);
    }
  }

  async listTools(): Promise<Tool[]> {
    return this.withClient(
      async (c) => (await c.listTools(undefined, { timeout: CALL_TIMEOUT_MS })).tools,
    );
  }

  /** Calls a Postrack tool as is. A tool's own refusal comes back as `isError`, not as a throw. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.withClient(
      async (c) =>
        (await c.callTool({ name, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
        })) as CallToolResult,
    );
  }

  /** A tool's JSON payload; a tool error becomes a `PostrackError`. */
  async callJson(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = await this.callTool(name, args);
    const text = r.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text */
    }
    if (r.isError) {
      const why =
        typeof data === 'object' && data && 'error' in data
          ? String((data as { error: unknown }).error)
          : text;
      throw new PostrackError('postrack_refused', `Postrack: ${why.slice(0, 300)}`);
    }
    return data;
  }

  async workspaces(): Promise<PostrackWorkspace[]> {
    return z.array(PostrackWorkspaceSchema).parse(await this.callJson('list_workspaces', {}));
  }

  async tree(workspaceId: string, force = false): Promise<PostrackTree> {
    const hit = this.trees.get(workspaceId);
    if (!force && hit && this.now() - hit.at < TREE_TTL_MS) return hit.tree;
    const raw = (await this.callJson('get_workspace_tree', { workspaceId })) as {
      workspace?: { id?: string };
      projects?: unknown;
    };
    const tree = PostrackTreeSchema.parse({ workspaceId, projects: raw.projects ?? [] });
    this.trees.set(workspaceId, { at: this.now(), tree });
    return tree;
  }

  endpoint(id: string): Promise<unknown> {
    return this.callJson('get_endpoint', { id });
  }

  environments(projectId: string): Promise<unknown> {
    return this.callJson('list_environments', { projectId });
  }

  async status(): Promise<PostrackStatus> {
    const url = this.url();
    const authMode = this.mode();
    const base = { url, authMode, connected: false, workspaces: null, error: null };
    if (!url || !authMode) return base;
    try {
      const ws = await this.workspaces();
      return { ...base, connected: true, workspaces: ws.length };
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }

  private saveUrl(url: string): void {
    const stored = this.d.config.getGlobalStored();
    if (stored.postrack.url === url) return;
    this.d.config.saveGlobal({ ...stored, postrack: { ...stored.postrack, url } }, undefined);
  }

  /**
   * API-key mode. The key is checked with `list_workspaces` before anything is saved; a refused key changes nothing.
   * `apiKey` undefined keeps the stored key (URL change only), null drops it.
   */
  async saveApiKey(url: string, apiKey: string | null | undefined): Promise<PostrackStatus> {
    const before = { url: this.url(), key: this.d.config.getSecret(API_KEY_SECRET) ?? null };
    if (apiKey === null) {
      this.d.config.setSecret(API_KEY_SECRET, null);
      this.saveUrl(url);
      this.reset();
      return this.status();
    }
    const key = apiKey ?? before.key;
    if (!key) {
      this.saveUrl(url);
      this.reset();
      return this.status();
    }
    // Try first, with the new values in place; put the old ones back if Postrack says no.
    this.d.config.setSecret(API_KEY_SECRET, key);
    this.saveUrl(url);
    this.reset();
    const st = await this.status();
    if (!st.connected) {
      this.d.config.setSecret(API_KEY_SECRET, before.key);
      if (before.url) this.saveUrl(before.url);
      this.reset();
      throw new ActionError(422, 'token_check_failed', st.error ?? 'Postrack refused the API key.');
    }
    clearPostrackOAuth(this.d.config);
    return st;
  }

  /** Step 1 of the OAuth sign-in: the URL to open in a popup, or null when the stored sign-in still works. */
  async startOAuth(url: string, origin: string): Promise<{ authorizationUrl: string | null }> {
    const redirect = `${origin.replace(/\/+$/, '')}${POSTRACK_CALLBACK_PATH}`;
    const provider = new PostrackOAuthProvider(this.d.config, redirect);
    for (const [k, f] of this.flows) if (this.now() - f.at > FLOW_TTL_MS) this.flows.delete(k);
    let result: 'AUTHORIZED' | 'REDIRECT';
    try {
      result = await auth(provider, { serverUrl: url, scope: POSTRACK_OAUTH_SCOPE });
    } catch (e) {
      throw new PostrackError(
        'postrack_unreachable',
        `Postrack sign-in could not start: ${((e as Error).message ?? '').slice(0, 300)}`,
      );
    }
    if (result === 'AUTHORIZED') {
      this.d.config.setSecret(API_KEY_SECRET, null);
      this.saveUrl(url);
      this.reset();
      return { authorizationUrl: null };
    }
    if (!provider.authorizationUrl) {
      throw new PostrackError('postrack_unreachable', 'Postrack did not offer a sign-in page.');
    }
    this.flows.set(provider.state(), { url, redirect, at: this.now() });
    return { authorizationUrl: provider.authorizationUrl.toString() };
  }

  /** Step 2: Postrack sent the browser back with a code. */
  async finishOAuth(code: string, state: string): Promise<void> {
    const flow = this.flows.get(state);
    if (!flow || this.now() - flow.at > FLOW_TTL_MS) {
      throw new ActionError(
        400,
        'postrack_oauth_state',
        'This sign-in expired. Start Connect again.',
      );
    }
    this.flows.delete(state);
    const provider = new PostrackOAuthProvider(this.d.config, flow.redirect);
    try {
      await auth(provider, { serverUrl: flow.url, authorizationCode: code });
    } catch (e) {
      throw new PostrackError(
        'postrack_refused',
        `Postrack refused the sign-in: ${((e as Error).message ?? '').slice(0, 300)}`,
      );
    }
    provider.clearVerifier();
    this.d.config.setSecret(API_KEY_SECRET, null);
    this.saveUrl(flow.url);
    this.reset();
    this.d.log.info('postrack connected (oauth)');
  }

  /** Forgets every credential. The URL stays, so Connect is one click. */
  disconnect(): void {
    this.d.config.setSecret(API_KEY_SECRET, null);
    clearPostrackOAuth(this.d.config);
    this.reset();
  }

  async close(): Promise<void> {
    this.reset();
  }
}
