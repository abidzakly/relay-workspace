import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Cached Notion cards. Mirrors `Card` in packages/shared. */
export const cards = sqliteTable(
  'cards',
  {
    /** Notion page id. */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    status: text('status'),
    type: text('type'),
    assignees: text('assignees', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** Raw Notion date strings (`YYYY-MM-DD` or ISO datetime). */
    estimationStart: text('estimation_start'),
    estimationEnd: text('estimation_end'),
    branchName: text('branch_name'),
    /** Relation target; no FK because the parent may not be cached yet. */
    parentId: text('parent_id'),
    url: text('url'),
    notionCreatedAt: integer('notion_created_at'),
    lastEditedAt: integer('last_edited_at').notNull(),
    /** First poll in which the card was seen assigned to me. */
    assignedAtFirstSeen: integer('assigned_at_first_seen'),
    /** 1 = the value above is the created_time fallback ("approx"). */
    assignedAtApprox: integer('assigned_at_approx', { mode: 'boolean' }).notNull().default(false),
    /** Local per-card override. The sync never touches it. Changed only by the audited route. */
    assignedAtManual: integer('assigned_at_manual'),
    /** Raw Notion "Assigned at" date. Kept whichever `sla.assignedAtSource` is set. */
    assignedAtProperty: text('assigned_at_property'),
    /** At the last sync of this card, one of its assignees was me. Decides whose KPI it counts for. */
    assignedToMe: integer('assigned_to_me', { mode: 'boolean' }).notNull().default(false),
    /** Notion `Product Domain` (maps 1:1 to a repo). */
    productDomain: text('product_domain'),
    /** Notion `Point` (1-6). */
    point: real('point'),
    /** Notion `Select Sprint`. */
    sprint: text('sprint'),
    /** Notion `Sub-task` relation targets. */
    subTaskIds: text('sub_task_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [
    index('cards_status_idx').on(t.status),
    index('cards_parent_idx').on(t.parentId),
    index('cards_branch_idx').on(t.branchName),
    index('cards_last_edited_idx').on(t.lastEditedAt),
    index('cards_sprint_idx').on(t.sprint),
  ],
);
