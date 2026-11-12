import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { HeadPipeline } from '@relay/shared';
import { MR_STATES, WEBHOOK_EVENT_STATUSES } from '@relay/shared';
import { inList } from './_helpers';
import { repos } from './config';

/** Cached MRs. Mirrors `Mr` in packages/shared. PK = (repo_id, iid). */
export const mrs = sqliteTable(
  'mrs',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    iid: integer('iid').notNull(),
    gitlabId: integer('gitlab_id'),
    title: text('title').notNull(),
    state: text('state').notNull(),
    draft: integer('draft', { mode: 'boolean' }).notNull().default(false),
    hasConflicts: integer('has_conflicts', { mode: 'boolean' }).notNull().default(false),
    sourceBranch: text('source_branch').notNull(),
    targetBranch: text('target_branch').notNull(),
    author: text('author'),
    webUrl: text('web_url'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at'),
    mergedAt: integer('merged_at'),
    /** Notion page id extracted from the MR description (first match). */
    descriptionNotionId: text('description_notion_id'),
    approvedBy: text('approved_by', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** GitLab usernames from the MR's `assignees` / `reviewers` (list and detail payloads). */
    assignees: text('assignees', { mode: 'json' }).$type<string[]>().notNull().default([]),
    reviewers: text('reviewers', { mode: 'json' }).$type<string[]>().notNull().default([]),
    lastNoteAt: integer('last_note_at'),
    headPipeline: text('head_pipeline', { mode: 'json' }).$type<HeadPipeline | null>(),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.iid] }),
    check('mrs_state_chk', inList(t.state, MR_STATES)),
    index('mrs_repo_state_idx').on(t.repoId, t.state),
    index('mrs_repo_merged_idx').on(t.repoId, t.mergedAt),
    index('mrs_source_branch_idx').on(t.repoId, t.sourceBranch),
    index('mrs_desc_notion_idx').on(t.descriptionNotionId),
  ],
);

/** Latest notes per MR: drives "x ago", waiting-on, unread. */
export const notesCache = sqliteTable(
  'notes_cache',
  {
    repoId: text('repo_id').notNull(),
    mrIid: integer('mr_iid').notNull(),
    noteId: integer('note_id').notNull(),
    discussionId: text('discussion_id').notNull(),
    author: text('author'),
    body: text('body').notNull().default(''),
    system: integer('system', { mode: 'boolean' }).notNull().default(false),
    resolvable: integer('resolvable', { mode: 'boolean' }).notNull().default(false),
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at'),
    /** false = unread in the dashboard. */
    seen: integer('seen', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.noteId] }),
    foreignKey({ columns: [t.repoId, t.mrIid], foreignColumns: [mrs.repoId, mrs.iid] }).onDelete(
      'cascade',
    ),
    index('notes_mr_created_idx').on(t.repoId, t.mrIid, t.createdAt),
    index('notes_discussion_idx').on(t.repoId, t.mrIid, t.discussionId),
  ],
);

/**
 * Webhook deliveries. `event_uuid` = `X-Gitlab-Event-UUID`;
 * its UNIQUE constraint is the dedupe mechanism (INSERT … ON CONFLICT DO NOTHING).
 */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventUuid: text('event_uuid').notNull().unique(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** `X-Gitlab-Event` header, e.g. "Merge Request Hook". */
    eventType: text('event_type').notNull(),
    /** Payload `object_kind`. */
    objectKind: text('object_kind'),
    /** Payload action (e.g. `approved`, `merge`), when present. */
    action: text('action'),
    payload: text('payload', { mode: 'json' }),
    status: text('status').notNull().default('received'),
    error: text('error'),
    receivedAt: integer('received_at').notNull(),
    processedAt: integer('processed_at'),
  },
  (t) => [
    check('events_status_chk', inList(t.status, WEBHOOK_EVENT_STATUSES)),
    index('events_repo_received_idx').on(t.repoId, t.receivedAt),
    index('events_received_idx').on(t.receivedAt),
  ],
);

/**
 * Commit list per open MR, keyed by the head SHA it was read at: drives the
 * stacked-MR layout of the lists. COSMETIC cache only: the merge gate re-reads commits LIVE.
 */
export const mrCommits = sqliteTable(
  'mr_commits',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    iid: integer('iid').notNull(),
    headSha: text('head_sha').notNull(),
    /** `target...source`, newest first. */
    shas: text('shas', { mode: 'json' }).$type<string[]>().notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.iid] })],
);

/**
 * Heads of pushed non-target branches: from push webhooks, with a branch-list poll as
 * fallback. Drives "Ready for MR" (branch == card Branch formula, no open MR) and counts as a stack parent without
 * MR. `commits` = `base...branch` (newest first), read when the head moves; null = not read yet.
 */
export const branchPushes = sqliteTable(
  'branch_pushes',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull(),
    sha: text('sha').notNull(),
    pushedAt: integer('pushed_at').notNull(),
    actor: text('actor'),
    commits: text('commits', { mode: 'json' }).$type<string[] | null>(),
    /** When a "ready for MR" notification went out for this head. */
    notifiedSha: text('notified_sha'),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.branch] })],
);
