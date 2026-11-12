import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Json } from '@relay/shared';
import { AUDIT_ACTORS } from '@relay/shared';
import { inList, nowMsSql } from './_helpers';

/**
 * Audit log: every external write, with before/after and an undo token when
 * reversible. Append-only by convention; intentionally has NO foreign keys so history
 * survives deletion of the things it describes. `before`/`after` must be pre-redacted.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull().default(nowMsSql),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    before: text('before', { mode: 'json' }).$type<Json | null>(),
    after: text('after', { mode: 'json' }).$type<Json | null>(),
    /** The write was only simulated (global dry-run). */
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    undoToken: text('undo_token').unique(),
    undoneAt: integer('undone_at'),
    /** Bulk operations share a batch id so "Undo bulk" is one action. */
    batchId: text('batch_id'),
    /** For an `undo` entry: id of the audit entry it reverted. */
    undoOf: integer('undo_of'),
  },
  (t) => [
    check('audit_actor_chk', inList(t.actor, AUDIT_ACTORS)),
    index('audit_at_idx').on(t.at),
    index('audit_target_idx').on(t.targetType, t.targetId),
    index('audit_batch_idx').on(t.batchId),
  ],
);
