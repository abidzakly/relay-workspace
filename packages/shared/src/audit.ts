import { z } from 'zod';
import { EpochMsSchema, JsonSchema } from './common';

export const AUDIT_ACTORS = ['user', 'system', 'webhook'] as const;
export const AuditActorSchema = z.enum(AUDIT_ACTORS);
export type AuditActor = z.infer<typeof AuditActorSchema>;

/**
 * Every external write → one row with before/after. `undoToken` is set only when the
 * write is reversible. `before`/`after` must never contain secrets (callers pass redacted data).
 * Bulk operations share a `batchId` so "Undo bulk" can restore them all in one action.
 */
export const AuditEntrySchema = z.object({
  id: z.number().int().positive(),
  at: EpochMsSchema,
  actor: AuditActorSchema,
  /** Namespaced verb, e.g. `card.status`, `card.bulkReady`, `mr.merge`, `undo`. */
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  before: JsonSchema.nullable(),
  after: JsonSchema.nullable(),
  /** The write was only simulated (global dry-run). */
  dryRun: z.boolean(),
  undoToken: z.string().min(1).nullable(),
  undoneAt: EpochMsSchema.nullable(),
  batchId: z.string().min(1).nullable(),
  /** For an `undo` entry: id of the entry it reverted. */
  undoOf: z.number().int().positive().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** A row as the API shows it: the undo token stays on the server. */
export const AuditListEntrySchema = AuditEntrySchema.omit({ undoToken: true }).extend({
  /** `POST /api/audit/:id/undo` can be tried now (real write, has a token, a handler exists, not undone). */
  undoable: z.boolean(),
  /** Human name of the target when known (a card's title), else null. */
  targetLabel: z.string().nullable(),
});
export type AuditListEntry = z.infer<typeof AuditListEntrySchema>;

const FlagSchema = z.enum(['true', 'false']).transform((v) => v === 'true');

/** `GET /api/audit` query string. Newest first; page with `beforeId`. */
export const AuditListQuerySchema = z
  .object({
    action: z.string().min(1).max(100).optional(),
    actor: AuditActorSchema.optional(),
    targetType: z.string().min(1).max(100).optional(),
    batchId: z.string().min(1).max(100).optional(),
    onlyUndoable: FlagSchema.optional(),
    beforeId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditListSchema = z.object({
  entries: z.array(AuditListEntrySchema),
  /** Pass as `beforeId` for the next page; null on the last one. */
  nextBeforeId: z.number().int().positive().nullable(),
  /** Every distinct value in the log, for the filter menus. */
  facets: z.object({ actions: z.array(z.string()), targetTypes: z.array(z.string()) }),
});
export type AuditList = z.infer<typeof AuditListSchema>;
