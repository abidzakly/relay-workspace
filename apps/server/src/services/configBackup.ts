import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import {
  CONFIG_EXPORT_FORMAT,
  CONFIG_EXPORT_FORMATS,
  CONFIG_EXPORT_SCHEMA_VERSION,
  ConfigExportFileSchema,
  GlobalConfigStoredSchema,
  RepoConfigStoredSchema,
  SecretSchema,
  toStoredRepoConfig,
  type ConfigExportFile,
  type ConfigImportPreview,
  type GlobalConfigStored,
  type RepoConfigStored,
  type SealedSecrets,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import { ActionError } from './actionError';

/**
 * Config export and import. The passphrase lives only in this module's local variables: it is never
 * stored, logged, audited or put in an error. Every failure here says what is wrong without quoting a value.
 */

const KDF = { name: 'scrypt', N: 131072, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
/** scrypt needs 128 * N * r bytes, 128 MiB here, and Node's default ceiling is lower. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** Authenticated, so the sealed block cannot be moved under another format or version. */
const aadFor = (format: string) => Buffer.from(`${format}/${CONFIG_EXPORT_SCHEMA_VERSION}/secrets`);
const AAD = aadFor(CONFIG_EXPORT_FORMAT);
/** Below this, a value could match ordinary text and fail an export for nothing. */
const LEAK_CHECK_MIN_LEN = 8;

const SecretsPayloadSchema = z.strictObject({
  notionToken: SecretSchema.optional(),
  repos: z.record(
    z.string(),
    z.strictObject({
      token: SecretSchema.optional(),
      webhookSecret: SecretSchema.optional(),
    }),
  ),
});
type SecretsPayload = z.infer<typeof SecretsPayloadSchema>;

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      KEY_LEN,
      { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(new Error('key derivation failed')) : resolve(key)),
    );
  });
}

async function seal(payload: SecretsPayload, passphrase: string): Promise<SealedSecrets> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv, {
    authTagLength: TAG_LEN,
  });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return {
    kdf: { ...KDF },
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

async function unseal(
  sealed: SealedSecrets,
  passphrase: string,
  format: string = CONFIG_EXPORT_FORMAT,
): Promise<SecretsPayload> {
  const refused = new ActionError(
    400,
    'bad_passphrase',
    'Wrong passphrase, or the secrets in this file were altered.',
  );
  const key = await deriveKey(passphrase, Buffer.from(sealed.salt, 'base64url'));
  let text: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'), {
      authTagLength: TAG_LEN,
    });
    decipher.setAAD(aadFor(format));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    text = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw refused;
  }
  try {
    return SecretsPayloadSchema.parse(JSON.parse(text));
  } catch {
    throw refused;
  }
}

/**
 * A URL can carry a credential the secret fields do not cover (`https://user:token@host/x.git`). An ssh user name is
 * an address, not a secret, so `git@host:x` and `ssh://git@host/x` are left alone.
 */
export function stripUrlCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, '$1').replace(/^(ssh:\/\/[^/:@]+):[^/@]*@/i, '$1@');
}

function stripGlobal(g: GlobalConfigStored): GlobalConfigStored {
  return {
    ...g,
    ...(g.publicBaseUrl ? { publicBaseUrl: stripUrlCredentials(g.publicBaseUrl) } : {}),
    gitlab: {
      ...g.gitlab,
      ...(g.gitlab.host ? { host: stripUrlCredentials(g.gitlab.host) } : {}),
    },
  };
}

/** The last check before a file leaves: if a secret value is anywhere in the readable part, the export fails. */
function assertNoPlaintext(doc: ConfigExportFile, secrets: SecretsPayload): void {
  const text = JSON.stringify(doc);
  const values = [
    secrets.notionToken,
    ...Object.values(secrets.repos).flatMap((r) => [r.token, r.webhookSecret]),
  ];
  for (const value of values) {
    if (value && value.length >= LEAK_CHECK_MIN_LEN && text.includes(value)) {
      throw new ActionError(
        500,
        'export_contains_secret',
        'The export was stopped: a secret value appears in a settings field. Remove it from that field first.',
      );
    }
  }
}

function collectSecrets(store: ConfigStore): SecretsPayload {
  const notionToken = store.getGlobal().notion.token;
  const repos: SecretsPayload['repos'] = {};
  for (const repo of store.listReposFull()) {
    const { token, webhookSecret } = repo.gitlab;
    repos[repo.id] = {
      ...(token ? { token } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    };
  }
  return { ...(notionToken ? { notionToken } : {}), repos };
}

/** Builds the file. With no passphrase, `secrets` is null and the file holds no secret, encrypted or not. */
export async function buildConfigExport(
  store: ConfigStore,
  passphrase: string | undefined,
  nowMs: number,
): Promise<ConfigExportFile> {
  const held = collectSecrets(store);
  const doc: ConfigExportFile = {
    format: CONFIG_EXPORT_FORMAT,
    schemaVersion: CONFIG_EXPORT_SCHEMA_VERSION,
    exportedAt: nowMs,
    settings: stripGlobal(store.getGlobalStored()),
    repos: store.listReposFull().map((repo) => {
      const stored = toStoredRepoConfig(repo);
      return { ...stored, cloneUrl: stripUrlCredentials(stored.cloneUrl) };
    }),
    secrets: null,
  };
  assertNoPlaintext(doc, held);
  if (passphrase !== undefined) doc.secrets = await seal(held, passphrase);
  return doc;
}

// ───────────────────────────── import ─────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Issue = { code: 'custom'; path: (string | number)[]; message: string; input: unknown };

/**
 * The schemas fill in defaults and drop unknown keys, which suits a settings form but not a backup: a partial file
 * would silently reset fields, and a stray `token` would silently vanish. So the file must match its parsed form.
 */
function shapeIssues(raw: unknown, parsed: unknown, path: (string | number)[]): Issue[] {
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return [];
  const issues: Issue[] = [];
  for (const key of Object.keys(parsed)) {
    if (parsed[key] !== undefined && !Object.hasOwn(raw, key)) {
      issues.push({
        code: 'custom',
        path: [...path, key],
        message: 'missing from the file: it was made by an older or edited export',
        input: undefined,
      });
    }
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(parsed, key)) {
      issues.push({
        code: 'custom',
        path: [...path, key],
        message: 'not a field this version knows',
        input: undefined,
      });
    } else {
      issues.push(...shapeIssues(raw[key], parsed[key], [...path, key]));
    }
  }
  return issues;
}

function parseSection<T>(schema: z.ZodType<T>, raw: unknown, path: (string | number)[]): T {
  const out = schema.safeParse(raw);
  if (!out.success) {
    throw new z.ZodError(
      out.error.issues.map((i) => ({ ...i, path: [...path, ...i.path] })) as z.core.$ZodIssue[],
    );
  }
  const issues = shapeIssues(raw, out.data, path);
  if (issues.length > 0) throw new z.ZodError(issues as z.core.$ZodIssue[]);
  return out.data;
}

export interface ParsedConfigFile {
  /** The file's format: the current one, or a legacy one from before the rename. */
  format: string;
  exportedAt: number;
  settings: GlobalConfigStored;
  repos: RepoConfigStored[];
  sealed: SealedSecrets | null;
}

/** Fully validates an uploaded file. Writes nothing. Throws a 400 for anything but a current, complete export. */
export function parseConfigFile(raw: unknown): ParsedConfigFile {
  if (!isPlainObject(raw) || !(CONFIG_EXPORT_FORMATS as readonly unknown[]).includes(raw.format)) {
    throw new ActionError(400, 'not_a_config_export', 'This is not a Relay config export.');
  }
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ActionError(400, 'schema_version_invalid', 'The file has no valid schema version.');
  }
  if (version < CONFIG_EXPORT_SCHEMA_VERSION) {
    throw new ActionError(
      400,
      'schema_downgraded',
      `The file uses schema ${version}, older than this dashboard's ${CONFIG_EXPORT_SCHEMA_VERSION}. Importing it could silently undo newer settings.`,
    );
  }
  if (version > CONFIG_EXPORT_SCHEMA_VERSION) {
    throw new ActionError(
      400,
      'schema_too_new',
      `The file uses schema ${version}, newer than this dashboard's ${CONFIG_EXPORT_SCHEMA_VERSION}. Update the dashboard first.`,
    );
  }
  const file = ConfigExportFileSchema.parse(raw);
  const settings = parseSection(GlobalConfigStoredSchema, file.settings, ['settings']);
  const repos = file.repos.map((r, i) => parseSection(RepoConfigStoredSchema, r, ['repos', i]));
  const ids = new Set<string>();
  for (const repo of repos) {
    if (ids.has(repo.id)) {
      throw new ActionError(400, 'duplicate_repo', `Repo "${repo.id}" appears twice in the file.`);
    }
    ids.add(repo.id);
    if (stripUrlCredentials(repo.cloneUrl) !== repo.cloneUrl) {
      throw new ActionError(
        400,
        'clone_url_has_credentials',
        `The clone URL of repo "${repo.id}" holds credentials. An export never does, so this file was edited.`,
      );
    }
  }
  return {
    format: file.format,
    exportedAt: file.exportedAt,
    settings,
    repos,
    sealed: file.secrets,
  };
}

export async function openSecrets(
  parsed: ParsedConfigFile,
  passphrase: string | undefined,
): Promise<SecretsPayload | null> {
  if (!parsed.sealed || passphrase === undefined) return null;
  return unseal(parsed.sealed, passphrase, parsed.format);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the import would do. Reads only. */
export function previewImport(
  store: ConfigStore,
  parsed: ParsedConfigFile,
  secrets: SecretsPayload | null,
): ConfigImportPreview {
  const current = store.getGlobalStored();
  const settingsChanged = Object.keys(parsed.settings).filter(
    (key) =>
      !sameJson(
        current[key as keyof GlobalConfigStored],
        parsed.settings[key as keyof GlobalConfigStored],
      ),
  );
  const existing = new Map(store.listReposFull().map((r) => [r.id, toStoredRepoConfig(r)]));
  const fileIds = new Set(parsed.repos.map((r) => r.id));
  const preview: ConfigImportPreview = {
    exportedAt: parsed.exportedAt,
    settingsChanged,
    dryRunTurnsOff: current.dryRun && !parsed.settings.dryRun,
    reposAdded: [],
    reposUpdated: [],
    reposUnchanged: [],
    reposNotInFile: [...existing.keys()].filter((id) => !fileIds.has(id)),
    reposWithoutToken: [],
    secrets: !parsed.sealed ? 'none' : secrets ? 'restored' : 'ignored',
    secretCount: 0,
  };
  if (secrets?.notionToken) preview.secretCount++;
  for (const repo of parsed.repos) {
    const held = secrets?.repos[repo.id];
    if (held?.token) preview.secretCount++;
    if (held?.webhookSecret) preview.secretCount++;
    const old = existing.get(repo.id);
    const row = { id: repo.id, name: repo.name };
    if (!old) {
      preview.reposAdded.push(row);
      if (!held?.token) preview.reposWithoutToken.push(repo.id);
    } else if (sameJson(RepoConfigStoredSchema.parse(old), repo)) {
      preview.reposUnchanged.push(repo.id);
    } else {
      preview.reposUpdated.push(row);
    }
  }
  return preview;
}

export function applyImport(
  store: ConfigStore,
  parsed: ParsedConfigFile,
  secrets: SecretsPayload | null,
): void {
  store.applyImport({
    global: parsed.settings,
    notionToken: secrets?.notionToken,
    repos: parsed.repos.map((stored) => ({
      stored,
      token: secrets?.repos[stored.id]?.token,
      webhookSecret: secrets?.repos[stored.id]?.webhookSecret,
    })),
  });
}
