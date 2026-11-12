import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema } from './common';

/**
 * Cached Notion card. Status/type are Notion option names; when one matches a configured
 * status / SLA type case- and whitespace-insensitively it is stored under the configured spelling.
 */
export const CardSchema = z.object({
  /** Notion page id (32-hex or dashed UUID, as returned by Notion). */
  id: NotionIdSchema,
  title: z.string(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  /** Notion People property is multi-valued; names as shown by Notion. */
  assignees: z.array(z.string()),
  /** Date strings exactly as Notion returns them (`YYYY-MM-DD` or ISO datetime). */
  estimationStart: z.string().nullable(),
  estimationEnd: z.string().nullable(),
  branchName: z.string().nullable(),
  /** Relation target (Issues → parent). May point to a page not (yet) in the cache. */
  parentId: z.string().nullable(),
  url: z.string().nullable(),
  notionCreatedAt: EpochMsSchema.nullable(),
  lastEditedAt: EpochMsSchema,
  /** First poll in which the card was seen assigned to me. */
  assignedAtFirstSeen: EpochMsSchema.nullable(),
  /** true = `assignedAtFirstSeen` is the card's `created_time` fallback, not a real observation ("approx"). */
  assignedAtApprox: z.boolean().default(false),
  /** Notion `Product Domain` (maps to a connected repo). */
  productDomain: z.string().nullable().default(null),
  /** Notion `Point` (complexity 1-6, see `pointEffort`). */
  point: z.number().nullable().default(null),
  /** Notion `Select Sprint`. */
  sprint: z.string().nullable().default(null),
  /** Notion `Sub-task` relation targets (may be pages not in the cache). */
  subTaskIds: z.array(z.string()).default([]),
  /** Archived / trashed in Notion. */
  archived: z.boolean(),
  syncedAt: EpochMsSchema,
});
export type Card = z.infer<typeof CardSchema>;
