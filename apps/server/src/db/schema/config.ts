import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RepoConfigStored } from '@relay/shared';
import { createdAtCol, updatedAtCol } from './_helpers';

/**
 * Per-repo config.
 * `config` holds the NON-secret part only (RepoConfigStored). Secrets (GitLab token, webhook
 * secret) live in `secrets_enc` as an AES-256-GCM envelope produced by the config store
 * (encryption itself is implemented in a later part). Plaintext secrets never touch this table.
 */
export const repos = sqliteTable('repos', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).$type<RepoConfigStored>().notNull(),
  secretsEnc: text('secrets_enc'),
  createdAt: createdAtCol(),
  updatedAt: updatedAtCol(),
});

/**
 * Key/value settings.
 *  - key `global`: GlobalConfigStored JSON (no secrets).
 *  - encrypted=1 rows hold an AES-GCM envelope instead of JSON (e.g. the Notion token).
 *  - other keys: small operational state (e.g. last Notion poll cursor).
 */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
    updatedAt: updatedAtCol(),
  },
  (t) => [index('settings_updated_idx').on(t.updatedAt)],
);
