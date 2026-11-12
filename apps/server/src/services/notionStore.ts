import { eq, inArray } from 'drizzle-orm';
import type { Card } from '@relay/shared';
import type { AppDb } from '../db';
import { cards, settings } from '../db/schema';
import type { NormalizedPage } from './notionCard';

/**
 * Persistence for `cards` + the Notion poll cursor.
 * Reads/writes the local cache only; nothing here talks to Notion.
 */

export type CachedCard = typeof cards.$inferSelect;

/** `created_time` is minute-granular in Notion; a card created within this slack of the last poll counts as "new". */
export const CREATED_SLACK_MS = 60_000;
const CHUNK = 400;

export function rowToCard(r: CachedCard): Card {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    type: r.type,
    assignees: r.assignees,
    estimationStart: r.estimationStart,
    estimationEnd: r.estimationEnd,
    branchName: r.branchName,
    parentId: r.parentId,
    productDomain: r.productDomain,
    point: r.point,
    sprint: r.sprint,
    subTaskIds: r.subTaskIds,
    url: r.url,
    notionCreatedAt: r.notionCreatedAt,
    lastEditedAt: r.lastEditedAt,
    assignedAtFirstSeen: r.assignedAtFirstSeen,
    assignedAtApprox: r.assignedAtApprox,
    archived: r.archived,
    syncedAt: r.syncedAt,
  };
}

export function getCard(app: AppDb, id: string): Card | undefined {
  const row = app.db.select().from(cards).where(eq(cards.id, id)).get();
  return row ? rowToCard(row) : undefined;
}

export function listCards(app: AppDb, opts: { includeArchived?: boolean } = {}): Card[] {
  const q = app.db.select().from(cards);
  const rows = opts.includeArchived ? q.all() : q.where(eq(cards.archived, false)).all();
  return rows.map(rowToCard);
}

// ───────────────────────────── upsert ─────────────────────────────

export interface UpsertContext {
  /** Epoch ms of this sync (used as `synced_at` and as the "first seen" instant). */
  now: number;
  /** Start of the last successful poll; null = nothing was ever synced (baseline). */
  previousPollAt: number | null;
  /**
   * true = who counts as "me" changed since the last poll (see `identityKey`). A card cached before that change was
   * never observed under the new identity, so it is treated like a baseline card: `created_time`, approx.
   */
  identityChanged?: boolean;
}

export interface UpsertOutcome {
  created: number;
  updated: number;
  /** Incoming copy older than the cached one: ignored. */
  stale: number;
  firstSeen: { recorded: number; approx: number };
}

/**
 * Decides `assigned_at_first_seen` for a card that is assigned to me and has none yet:
 *  - the card was already in the cache (so we saw it NOT assigned to me)  -> now, exact
 *  - new to the cache, created since the last poll                        -> now, exact
 *  - new to the cache but older than the last poll, or no previous poll    -> `created_time`, approx
 *    (a baseline sync cannot know when the assignment happened; created_time is the documented fallback)
 */
export function decideFirstSeen(input: {
  cachedBefore: boolean;
  createdAt: number | null;
  now: number;
  previousPollAt: number | null;
}): { at: number; approx: boolean } {
  if (input.cachedBefore) return { at: input.now, approx: false };
  const { createdAt, previousPollAt } = input;
  if (previousPollAt === null) return { at: createdAt ?? input.now, approx: true };
  if (createdAt !== null && createdAt < previousPollAt - CREATED_SLACK_MS) {
    return { at: createdAt, approx: true };
  }
  return { at: input.now, approx: false };
}

/**
 * Upserts normalized pages. Once recorded, `assigned_at_first_seen` is never moved or cleared (not even if
 * the card is later unassigned/reassigned). Trashed cards never get one.
 */
export function upsertCards(
  app: AppDb,
  items: readonly NormalizedPage[],
  ctx: UpsertContext,
): UpsertOutcome {
  const out: UpsertOutcome = {
    created: 0,
    updated: 0,
    stale: 0,
    firstSeen: { recorded: 0, approx: 0 },
  };
  if (items.length === 0) return out;

  app.db.transaction((tx) => {
    // The same page can appear twice in one run when it is edited while we paginate: last copy wins.
    const byId = new Map(items.map((i) => [i.fields.id, i] as const));
    const existing = new Map<string, CachedCard>();
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += CHUNK) {
      for (const row of tx
        .select()
        .from(cards)
        .where(inArray(cards.id, ids.slice(i, i + CHUNK)))
        .all()) {
        existing.set(row.id, row);
      }
    }

    for (const item of byId.values()) {
      const f = item.fields;
      const prior = existing.get(f.id);
      if (prior && f.lastEditedAt < prior.lastEditedAt) {
        out.stale++;
        continue;
      }

      let firstSeen = prior?.assignedAtFirstSeen ?? null;
      let approx = prior?.assignedAtApprox ?? false;
      if (firstSeen === null && item.assignedToMe && !f.archived) {
        const d = decideFirstSeen({
          cachedBefore: prior !== undefined && !ctx.identityChanged,
          createdAt: f.notionCreatedAt,
          now: ctx.now,
          previousPollAt: ctx.identityChanged ? null : ctx.previousPollAt,
        });
        firstSeen = d.at;
        approx = d.approx;
        out.firstSeen.recorded++;
        if (d.approx) out.firstSeen.approx++;
      }

      const row = {
        title: f.title,
        status: f.status,
        type: f.type,
        assignees: f.assignees,
        estimationStart: f.estimationStart,
        estimationEnd: f.estimationEnd,
        branchName: f.branchName,
        parentId: f.parentId,
        productDomain: f.productDomain,
        point: f.point,
        sprint: f.sprint,
        subTaskIds: f.subTaskIds,
        url: f.url,
        notionCreatedAt: f.notionCreatedAt,
        lastEditedAt: f.lastEditedAt,
        assignedAtFirstSeen: firstSeen,
        assignedAtApprox: approx,
        assignedAtProperty: item.assignedAtProperty ?? null,
        assignedToMe: item.assignedToMe,
        archived: f.archived,
        syncedAt: ctx.now,
      };
      tx.insert(cards)
        .values({ id: f.id, ...row })
        .onConflictDoUpdate({ target: cards.id, set: row })
        .run();
      if (prior) out.updated++;
      else out.created++;
    }
  });
  return out;
}

/**
 * After a COMPLETE full sync: cards that are cached but no longer returned (trashed, or moved out of the data
 * source) are flagged `archived`. Returns how many changed. Cache-only, nothing is written to Notion.
 */
export function archiveMissing(app: AppDb, seen: ReadonlySet<string>, now: number): number {
  const missing = app.db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.archived, false))
    .all()
    .map((r) => r.id)
    .filter((id) => !seen.has(id));
  app.db.transaction((tx) => {
    for (let i = 0; i < missing.length; i += CHUNK) {
      tx.update(cards)
        .set({ archived: true, syncedAt: now })
        .where(inArray(cards.id, missing.slice(i, i + CHUNK)))
        .run();
    }
  });
  return missing.length;
}

// ───────────────────────────── poll cursor ─────────────────────────────

const STATE_KEY = 'notion.sync.state';

export interface NotionSyncState {
  dataSourceId: string;
  /** Epoch ms when the last successful sync (full or incremental) STARTED. */
  lastPollAt: number;
  lastFullAt: number | null;
  /** `identityKey` of the config the last poll ran with; undefined in cursors written before it existed. */
  identityKey?: string;
}

/**
 * Fingerprint of everything that decides `assigned_to_me`: the Assignee property and the "me" spellings. Order and
 * case of the aliases do not matter.
 */
export function identityKey(input: {
  assigneeProp: string;
  myUsername: string | undefined;
  aliases: readonly string[];
}): string {
  const norm = (v: string) => v.trim().toLowerCase();
  return JSON.stringify([
    norm(input.assigneeProp),
    norm(input.myUsername ?? ''),
    [...new Set(input.aliases.map(norm))].sort(),
  ]);
}

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The saved cursor, or undefined when none exists / it belongs to another data source / it is malformed. */
export function readSyncState(app: AppDb, dataSourceId: string): NotionSyncState | undefined {
  const row = app.db.select().from(settings).where(eq(settings.key, STATE_KEY)).get();
  if (!row) return undefined;
  try {
    const v = JSON.parse(row.value) as Record<string, unknown>;
    if (v.dataSourceId !== dataSourceId || !isEpoch(v.lastPollAt)) return undefined;
    return {
      dataSourceId,
      lastPollAt: v.lastPollAt,
      lastFullAt: isEpoch(v.lastFullAt) ? v.lastFullAt : null,
      ...(typeof v.identityKey === 'string' ? { identityKey: v.identityKey } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeSyncState(app: AppDb, state: NotionSyncState, now: number): void {
  const value = JSON.stringify(state);
  app.db
    .insert(settings)
    .values({ key: STATE_KEY, value, encrypted: false, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, encrypted: false, updatedAt: now } })
    .run();
}

/**
 * After a CONFIRMED status write: mirrors Notion's answer into the cache so the board and Sync Health move at
 * once (the next poll reconciles anyway). `lastEditedAt` only ever moves forward, so a poll that still carries
 * the old edit time cannot be mistaken for newer data. Cache-only; nothing is sent to Notion.
 */
export function applyWrittenStatus(
  app: AppDb,
  cardId: string,
  status: string | null,
  lastEditedAt: number | null,
): boolean {
  const prior = app.db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (!prior) return false;
  app.db
    .update(cards)
    .set({
      status,
      lastEditedAt:
        lastEditedAt !== null ? Math.max(prior.lastEditedAt, lastEditedAt) : prior.lastEditedAt,
    })
    .where(eq(cards.id, cardId))
    .run();
  return true;
}
