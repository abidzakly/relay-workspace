import { z } from 'zod';
import { EpochMsSchema, RepoIdSchema } from './common';

/**
 * Config export / import (Settings: backup/export). The file holds the non-secret settings and repos.
 * Secrets are left out unless the user asks for them, and then only as one block sealed with a passphrase.
 */

export const CONFIG_EXPORT_FORMAT = 'relay.config';
/** Formats still accepted on import: files exported before the rename to Relay. */
export const LEGACY_CONFIG_EXPORT_FORMATS = ['core-dashboard.config'] as const;
export const CONFIG_EXPORT_FORMATS = [
  CONFIG_EXPORT_FORMAT,
  ...LEGACY_CONFIG_EXPORT_FORMATS,
] as const;
/** Bump on any change to the file's shape, and add a migration, or every older file is refused as downgraded. */
export const CONFIG_EXPORT_SCHEMA_VERSION = 1;
export const CONFIG_PASSPHRASE_MIN = 12;
export const CONFIG_PASSPHRASE_MAX = 1024;
/** The dashboard's JSON body limit is 1 MiB, and the file travels inside a JSON body. */
export const CONFIG_FILE_MAX_BYTES = 900 * 1024;

const Base64UrlSchema = z
  .string()
  .max(1024 * 1024)
  .regex(/^[A-Za-z0-9_-]+$/, 'not base64url');

/**
 * scrypt + AES-256-GCM. The KDF parameters are literals: a file cannot lower them to weaken the
 * passphrase, or raise them to exhaust this machine's memory.
 */
export const SealedSecretsSchema = z.strictObject({
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: z.literal(131072),
    r: z.literal(8),
    p: z.literal(1),
  }),
  salt: Base64UrlSchema,
  iv: Base64UrlSchema,
  tag: Base64UrlSchema,
  ciphertext: Base64UrlSchema,
});
export type SealedSecrets = z.infer<typeof SealedSecretsSchema>;

/** The envelope. `settings` and each repo are then checked against the stored-config schemas by the server. */
export const ConfigExportFileSchema = z.strictObject({
  format: z.enum(CONFIG_EXPORT_FORMATS),
  schemaVersion: z.literal(CONFIG_EXPORT_SCHEMA_VERSION),
  exportedAt: EpochMsSchema,
  settings: z.record(z.string(), z.unknown()),
  repos: z.array(z.record(z.string(), z.unknown())).max(500),
  secrets: SealedSecretsSchema.nullable(),
});
export type ConfigExportFile = z.infer<typeof ConfigExportFileSchema>;

export const ConfigExportBodySchema = z.discriminatedUnion('includeSecrets', [
  z.strictObject({ includeSecrets: z.literal(false) }),
  z.strictObject({
    includeSecrets: z.literal(true),
    passphrase: z.string().min(CONFIG_PASSPHRASE_MIN).max(CONFIG_PASSPHRASE_MAX),
  }),
]);
export type ConfigExportBody = z.infer<typeof ConfigExportBodySchema>;

const ImportFields = {
  /** Validated by the server; deliberately untyped here so a bad file gets the import's own errors. */
  file: z.unknown(),
  passphrase: z.string().min(1).max(CONFIG_PASSPHRASE_MAX).optional(),
};
export const ConfigImportPreviewBodySchema = z.strictObject(ImportFields);
/** `confirm` is what the confirm dialog sends. Nothing else reaches the write. */
export const ConfigImportApplyBodySchema = z.strictObject({
  ...ImportFields,
  confirm: z.literal(true),
});

export const ConfigImportPreviewSchema = z.object({
  exportedAt: EpochMsSchema,
  /** Top-level settings sections that would change. */
  settingsChanged: z.array(z.string()),
  /** The import would turn dry-run off, so confirmed writes become real. */
  dryRunTurnsOff: z.boolean(),
  reposAdded: z.array(z.object({ id: RepoIdSchema, name: z.string() })),
  reposUpdated: z.array(z.object({ id: RepoIdSchema, name: z.string() })),
  reposUnchanged: z.array(RepoIdSchema),
  /** Repos on this machine that are not in the file. An import never deletes them. */
  reposNotInFile: z.array(RepoIdSchema),
  /** New repos with no token in the file: created, but not synced until a token is entered. */
  reposWithoutToken: z.array(RepoIdSchema),
  /** `ignored` = the file has sealed secrets and no passphrase was given. */
  secrets: z.enum(['none', 'ignored', 'restored']),
  secretCount: z.int().nonnegative(),
});
export type ConfigImportPreview = z.infer<typeof ConfigImportPreviewSchema>;

/** `POST /api/webhooks/check-public-url`: one request, only ever from the user's click. */
export const PUBLIC_URL_CHECK_STATES = [
  /** Our webhook listener answered through the tunnel. */
  'reachable',
  /** ngrok answered with its own error (agent offline, for example). */
  'tunnel_error',
  /** Something answered, but not our listener. */
  'unexpected',
  /** No HTTP answer at all. */
  'unreachable',
  /** No usable https public URL is set. */
  'not_configured',
] as const;
export const PublicUrlCheckSchema = z.object({
  state: z.enum(PUBLIC_URL_CHECK_STATES),
  checkedAt: EpochMsSchema,
  /** Origin only. */
  host: z.string().nullable(),
  httpStatus: z.int().nullable(),
  /** ngrok's error code, or the kind of network failure. */
  detail: z.string().nullable(),
});
export type PublicUrlCheck = z.infer<typeof PublicUrlCheckSchema>;
