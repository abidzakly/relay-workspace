import { randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import {
  myUsernames,
  GlobalConfigStoredSchema,
  RepoConfigStoredSchema,
  SECRET_MASK,
  toPublicGlobalConfig,
  toPublicRepoConfig,
  type GlobalConfig,
  type GlobalConfigPublic,
  type GlobalConfigStored,
  type RepoConfig,
  type RepoConfigPublic,
  type RepoConfigStored,
} from '@relay/shared';
import type { AppDb } from '../db';
import { schema } from '../db';
import type { SecretBox } from './crypto';

const GLOBAL_KEY = 'global';
const NOTION_TOKEN_KEY = 'secret.notion.token';
const REVIEWER_TOKEN_KEY = 'secret.gitlab.reviewerToken';
const REVIEWS_HOOK_SECRET_KEY = 'secret.reviews.webhookSecret';
const ctxSetting = (key: string) => `setting:${key}`;
const ctxRepo = (id: string) => `repo:${id}:secrets`;
const TOKEN_USER_PREFIX = 'identity.tokenUser:';

/**
 * Write-side semantics for a secret field (see SECRET_MASK):
 *  `undefined` / mask -> unchanged, `null` -> clear, other string -> replace.
 */
export type SecretInput = string | null | undefined;

export type SecretChange = { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; value: string };

export function interpretSecretInput(input: SecretInput): SecretChange {
  if (input === undefined || input === SECRET_MASK) return { kind: 'keep' };
  if (input === null) return { kind: 'clear' };
  return { kind: 'set', value: input };
}

export class RepoExistsError extends Error {
  constructor(readonly id: string) {
    super(`repo "${id}" already exists`);
    this.name = 'RepoExistsError';
  }
}
export class RepoNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`repo "${id}" not found`);
    this.name = 'RepoNotFoundError';
  }
}

interface RepoSecrets {
  token: string;
  webhookSecret: string;
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Settings + repos persistence. Secrets exist in plaintext only in memory:
 *  - repo token + webhook secret -> `repos.secrets_enc` (one AES-GCM blob, AAD = `repo:<id>:secrets`)
 *  - Notion token                -> `settings` row `secret.notion.token` (`encrypted=1`)
 * Everything the API can see goes through the `*Public` accessors; `getRepo`/`getGlobal` (full) are
 * server-internal for services that must call GitLab/Notion.
 */
export class ConfigStore {
  constructor(
    private readonly app: AppDb,
    private readonly box: SecretBox,
    private readonly now: () => number = Date.now,
    /** Edition presets (`editions/<name>/presets.json`): the defaults until the first Settings save. */
    private readonly presetGlobal: Record<string, unknown> = {},
  ) {}

  // ───────────── global ─────────────

  getGlobalStored(): GlobalConfigStored {
    const row = this.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, GLOBAL_KEY))
      .get();
    // Re-parsing applies defaults for fields added after the row was written. Before the first save, the edition
    // presets stand in for the saved settings.
    return GlobalConfigStoredSchema.parse(row ? JSON.parse(row.value) : this.presetGlobal);
  }

  private getNotionToken(): string | undefined {
    const row = this.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, NOTION_TOKEN_KEY))
      .get();
    return row ? this.box.decrypt(row.value, ctxSetting(NOTION_TOKEN_KEY)) : undefined;
  }

  /** Full config incl. Notion token. Server-internal only. */
  getGlobal(): GlobalConfig {
    const stored = this.getGlobalStored();
    const token = this.getNotionToken();
    return { ...stored, notion: { ...stored.notion, ...(token ? { token } : {}) } };
  }

  getGlobalPublic(): GlobalConfigPublic {
    return toPublicGlobalConfig(this.getGlobal());
  }

  isDryRun(): boolean {
    return this.getGlobalStored().dryRun;
  }

  /** Replaces the non-secret global config; applies the Notion token change. Returns the public view. */
  saveGlobal(stored: GlobalConfigStored, notionToken: SecretInput): GlobalConfigPublic {
    const change = interpretSecretInput(notionToken);
    const t = this.now();
    this.app.sqlite.transaction(() => {
      this.upsertSetting(
        GLOBAL_KEY,
        JSON.stringify(GlobalConfigStoredSchema.parse(stored)),
        false,
        t,
      );
      if (change.kind === 'set') {
        this.upsertSetting(
          NOTION_TOKEN_KEY,
          this.box.encrypt(change.value, ctxSetting(NOTION_TOKEN_KEY)),
          true,
          t,
        );
      } else if (change.kind === 'clear') {
        this.app.db.delete(schema.settings).where(eq(schema.settings.key, NOTION_TOKEN_KEY)).run();
      }
    })();
    return this.getGlobalPublic();
  }

  // ───────────── Reviews: personal GitLab token + local state ─────────────

  /** The personal access token Reviews reads GitLab with (any project, as me). Server-internal only. */
  getReviewerToken(): string | undefined {
    const row = this.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, REVIEWER_TOKEN_KEY))
      .get();
    return row ? this.box.decrypt(row.value, ctxSetting(REVIEWER_TOKEN_KEY)) : undefined;
  }

  /** Saves (string) or clears (null) the reviewer token. */
  setReviewerToken(token: string | null): void {
    if (token === null) {
      this.app.db.delete(schema.settings).where(eq(schema.settings.key, REVIEWER_TOKEN_KEY)).run();
      return;
    }
    this.upsertSetting(
      REVIEWER_TOKEN_KEY,
      this.box.encrypt(token, ctxSetting(REVIEWER_TOKEN_KEY)),
      true,
      this.now(),
    );
  }

  /** The secret the Reviews webhook (`POST /webhook/reviews`) checks; created on first use. Server-internal only. */
  getReviewsWebhookSecret(create: boolean): string | undefined {
    const row = this.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, REVIEWS_HOOK_SECRET_KEY))
      .get();
    if (row) return this.box.decrypt(row.value, ctxSetting(REVIEWS_HOOK_SECRET_KEY));
    if (!create) return undefined;
    const secret = generateWebhookSecret();
    this.upsertSetting(
      REVIEWS_HOOK_SECRET_KEY,
      this.box.encrypt(secret, ctxSetting(REVIEWS_HOOK_SECRET_KEY)),
      true,
      this.now(),
    );
    return secret;
  }

  /** An encrypted value kept by a feature (`secret.<name>`). Server-internal only. */
  getSecret(name: string): string | undefined {
    const key = `secret.${name}`;
    const row = this.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get();
    return row ? this.box.decrypt(row.value, ctxSetting(key)) : undefined;
  }

  /** Saves (string) or removes (null) an encrypted value. */
  setSecret(name: string, value: string | null): void {
    const key = `secret.${name}`;
    if (value === null) {
      this.app.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
      return;
    }
    this.upsertSetting(key, this.box.encrypt(value, ctxSetting(key)), true, this.now());
  }

  /** A non-secret JSON value kept by a feature (`state.<name>`); undefined when absent or unreadable. */
  getState<T>(name: string): T | undefined {
    const row = this.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, `state.${name}`))
      .get();
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  setState(name: string, value: unknown): void {
    if (value === undefined) {
      this.app.db
        .delete(schema.settings)
        .where(eq(schema.settings.key, `state.${name}`))
        .run();
      return;
    }
    this.upsertSetting(`state.${name}`, JSON.stringify(value), false, this.now());
  }

  private upsertSetting(key: string, value: string, encrypted: boolean, at: number): void {
    this.app.db
      .insert(schema.settings)
      .values({ key, value, encrypted, updatedAt: at })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, encrypted, updatedAt: at } })
      .run();
  }

  // ───────────── repos ─────────────

  private rowToFull(row: typeof schema.repos.$inferSelect): RepoConfig {
    const stored = RepoConfigStoredSchema.parse(row.config);
    if (!row.secretsEnc) throw new Error(`repo "${row.id}" has no secrets blob`);
    const secrets = JSON.parse(this.box.decrypt(row.secretsEnc, ctxRepo(row.id))) as RepoSecrets;
    return { ...stored, gitlab: { ...stored.gitlab, ...secrets } };
  }

  private selectRow(id: string) {
    return this.app.db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
  }

  private encryptSecrets(id: string, s: RepoSecrets): string {
    return this.box.encrypt(JSON.stringify(s), ctxRepo(id));
  }

  /** Full repo incl. token + webhook secret. Server-internal only. */
  getRepo(id: string): RepoConfig | undefined {
    const row = this.selectRow(id);
    return row ? this.rowToFull(row) : undefined;
  }

  getRepoPublic(id: string): RepoConfigPublic | undefined {
    const full = this.getRepo(id);
    return full ? toPublicRepoConfig(full) : undefined;
  }

  listRepos(): RepoConfigPublic[] {
    const rows = this.app.db.select().from(schema.repos).orderBy(schema.repos.id).all();
    return rows.map((r) => toPublicRepoConfig(this.rowToFull(r)));
  }

  /** Full list (decrypted) for services. Server-internal only. */
  listReposFull(): RepoConfig[] {
    return this.app.db
      .select()
      .from(schema.repos)
      .orderBy(schema.repos.id)
      .all()
      .map((r) => this.rowToFull(r));
  }

  /** Webhook secret for the :3001 listener. `undefined` when the repo does not exist. */
  getWebhookSecret(id: string): string | undefined {
    const row = this.selectRow(id);
    if (!row?.secretsEnc) return undefined;
    return (JSON.parse(this.box.decrypt(row.secretsEnc, ctxRepo(id))) as RepoSecrets).webhookSecret;
  }

  /** Creates a repo; the webhook secret is generated here, never supplied by the client. */
  createRepo(stored: RepoConfigStored, token: string): RepoConfigPublic {
    const cfg = RepoConfigStoredSchema.parse(stored);
    const t = this.now();
    this.app.sqlite.transaction(() => {
      if (this.selectRow(cfg.id)) throw new RepoExistsError(cfg.id);
      this.app.db
        .insert(schema.repos)
        .values({
          id: cfg.id,
          name: cfg.name,
          config: cfg,
          secretsEnc: this.encryptSecrets(cfg.id, {
            token,
            webhookSecret: generateWebhookSecret(),
          }),
          createdAt: t,
          updatedAt: t,
        })
        .run();
    })();
    return this.mustGetPublic(cfg.id);
  }

  /** Updates config (id is immutable). The token follows `SecretInput`; the webhook secret is kept. */
  updateRepo(id: string, stored: RepoConfigStored, token: SecretInput): RepoConfigPublic {
    const cfg = RepoConfigStoredSchema.parse(stored);
    if (cfg.id !== id) throw new Error('repo id is immutable');
    const change = interpretSecretInput(token);
    if (change.kind === 'clear') throw new Error('the GitLab token cannot be cleared');
    this.app.sqlite.transaction(() => {
      const row = this.selectRow(id);
      if (!row) throw new RepoNotFoundError(id);
      const old = this.rowToFull(row);
      const secrets: RepoSecrets = {
        token: change.kind === 'set' ? change.value : old.gitlab.token,
        webhookSecret: old.gitlab.webhookSecret ?? generateWebhookSecret(),
      };
      this.app.db
        .update(schema.repos)
        .set({
          name: cfg.name,
          config: cfg,
          secretsEnc: this.encryptSecrets(id, secrets),
          updatedAt: this.now(),
        })
        .where(eq(schema.repos.id, id))
        .run();
    })();
    return this.mustGetPublic(id);
  }

  /**
   * Config import, all or nothing: replaces the global settings and upserts each repo. Repos not listed stay.
   * A secret left undefined keeps what this machine has. A new repo with no token is stored with an empty one
   * (`tokenSet: false`), which the sync skips until the user enters a token in Settings.
   */
  applyImport(input: {
    global: GlobalConfigStored;
    notionToken: string | undefined;
    repos: {
      stored: RepoConfigStored;
      token: string | undefined;
      webhookSecret: string | undefined;
    }[];
  }): void {
    this.app.sqlite.transaction(() => {
      this.saveGlobal(input.global, input.notionToken);
      for (const { stored, token, webhookSecret } of input.repos) {
        const cfg = RepoConfigStoredSchema.parse(stored);
        const row = this.selectRow(cfg.id);
        const old = row ? this.rowToFull(row) : undefined;
        const secretsEnc = this.encryptSecrets(cfg.id, {
          token: token ?? old?.gitlab.token ?? '',
          webhookSecret: webhookSecret ?? old?.gitlab.webhookSecret ?? generateWebhookSecret(),
        });
        const t = this.now();
        if (row) {
          this.app.db
            .update(schema.repos)
            .set({ name: cfg.name, config: cfg, secretsEnc, updatedAt: t })
            .where(eq(schema.repos.id, cfg.id))
            .run();
        } else {
          this.app.db
            .insert(schema.repos)
            .values({
              id: cfg.id,
              name: cfg.name,
              config: cfg,
              secretsEnc,
              createdAt: t,
              updatedAt: t,
            })
            .run();
        }
      }
    })();
  }

  /** Deletes a repo; returns its last public view (for the audit trail) or undefined. */
  deleteRepo(id: string): RepoConfigPublic | undefined {
    const before = this.getRepoPublic(id);
    if (before) {
      this.app.db.delete(schema.repos).where(eq(schema.repos.id, id)).run();
      this.setTokenUser(id, null);
    }
    return before;
  }

  // ───────────── identity ─────────────

  /**
   * The GitLab user behind a repo's token (from `GET /user`), kept in its own settings row so a repo save from
   * the UI never overwrites it. `null` forgets it.
   */
  setTokenUser(repoId: string, username: string | null): void {
    const key = `${TOKEN_USER_PREFIX}${repoId}`;
    if (username === null) {
      this.app.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    } else {
      this.upsertSetting(key, username, false, this.now());
    }
  }

  /** repoId -> token username, for the repos resolved so far. */
  tokenUsers(): Map<string, string> {
    const rows = this.app.db
      .select({ key: schema.settings.key, value: schema.settings.value })
      .from(schema.settings)
      .where(like(schema.settings.key, `${TOKEN_USER_PREFIX}%`))
      .all();
    return new Map(rows.map((r) => [r.key.slice(TOKEN_USER_PREFIX.length), r.value]));
  }

  /** Every username that is "me": `gitlab.myUsername` and the repos' token users. Lowercased. */
  myUsernames(): string[] {
    return myUsernames(this.getGlobalStored().gitlab.myUsername, this.tokenUsers().values());
  }

  private mustGetPublic(id: string): RepoConfigPublic {
    const r = this.getRepoPublic(id);
    if (!r) throw new RepoNotFoundError(id);
    return r;
  }
}
