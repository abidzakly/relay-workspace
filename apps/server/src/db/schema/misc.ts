import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Json } from '@relay/shared';
import { createdAtCol, nowMsSql } from './_helpers';

/** Web Push subscriptions. */
export const pushSubs = sqliteTable('push_subs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: createdAtCol(),
  lastUsedAt: integer('last_used_at'),
});

/**
 * Every notification sent, for the notification center. Facts only: the actions are derived from the current state
 * when read. No foreign key to `repos`: the log outlives a removed repo.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    event: text('event').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    url: text('url').notNull(),
    repoId: text('repo_id'),
    subject: text('subject', { mode: 'json' }).$type<Json | null>(),
    at: integer('at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => [index('notifications_at_idx').on(t.at), index('notifications_read_at_idx').on(t.readAt)],
);

/** Monthly scorecards, frozen at month end. `month` = `YYYY-MM`. */
export const kpiSnapshots = sqliteTable('kpi_snapshots', {
  month: text('month').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Json>().notNull(),
  frozenAt: integer('frozen_at').notNull().default(nowMsSql),
});

/**
 * Gamification ledger: XP awards, badges, streak marks and per-release history
 * are rows distinguished by `kind`. `dedupe_key` is UNIQUE so replayed webhooks / re-polls can
 * never award the same thing twice (INSERT … ON CONFLICT DO NOTHING). Totals are derived
 * (e.g. SUM(amount) for XP).
 */
export const gamification = sqliteTable(
  'gamification',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull().default(nowMsSql),
    /** e.g. `xp`, `badge`, `streak`, `release`. */
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** XP delta (0 for non-XP rows). */
    amount: integer('amount').notNull().default(0),
    data: text('data', { mode: 'json' }).$type<Json | null>(),
  },
  (t) => [index('gamification_kind_at_idx').on(t.kind, t.at)],
);

/**
 * AI answers, keyed by sha256(template + model tier + rendered prompt): the prompt
 * embeds the diff text, so the key is content-addressed (same diff + hunk + template = no second payment).
 */
export const aiCache = sqliteTable('ai_cache', {
  key: text('key').primaryKey(),
  template: text('template').notNull(),
  engine: text('engine').notNull(),
  value: text('value', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Review decks: one row per diff source. `cards` are rebuilt when `diff_sha` changes;
 * `state` (cursor, verdicts, notes) survives, notes are re-anchored or marked stale.
 */
export const reviewDecks = sqliteTable('review_decks', {
  deckId: text('deck_id').primaryKey(),
  sourceKey: text('source_key').notNull().unique(),
  source: text('source', { mode: 'json' }).notNull(),
  title: text('title').notNull(),
  subtitle: text('subtitle').notNull().default(''),
  diffSha: text('diff_sha').notNull(),
  cards: text('cards', { mode: 'json' }).notNull(),
  ai: text('ai', { mode: 'json' }).notNull(),
  state: text('state', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Cockpit workspaces: directories on the Mac, validated by the host. */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  absPath: text('abs_path').notNull().unique(),
  repoId: text('repo_id'),
  defaultBase: text('default_base').notNull().default('main'),
  color: text('color').notNull().default('amber'),
  createdAt: integer('created_at').notNull(),
  /** 'repo' = a folder the user registered; 'worktree' = a git worktree of `parent_id` made for a bulk card start. */
  kind: text('kind').notNull().default('repo'),
  parentId: text('parent_id'),
});

/**
 * Sync Health findings marked as false positives. `key` = `healthFindingKey(...)` (rule + card + MR), so a finding
 * stays hidden only while the same rule fires on the same card / MR. Local only, never sent to Notion or GitLab.
 */
export const healthDismissals = sqliteTable('health_dismissals', {
  key: text('key').primaryKey(),
  ruleId: text('rule_id').notNull(),
  cardId: text('card_id'),
  repoId: text('repo_id'),
  mrIid: integer('mr_iid'),
  createdAt: createdAtCol(),
});

/**
 * Folders of files saved for an agent (`<git dir>/cockpit-attachments/<group>`), so the storage cleanup knows what
 * each one belongs to: a started card, a review thread or a test finding.
 */
export const cockpitAttachments = sqliteTable('cockpit_attachments', {
  group: text('group').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  /** 'card' | 'thread' | 'finding' */
  kind: text('kind').notNull(),
  /** Card id, `<repoId>!<iid>#<discussionId>`, or finding id. */
  refId: text('ref_id').notNull(),
  createdAt: integer('created_at').notNull(),
});
