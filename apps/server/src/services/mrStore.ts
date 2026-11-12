import { and, eq, notInArray } from 'drizzle-orm';
import { isMyUser, type Mr, type Note } from '@relay/shared';
import type { AppDb } from '../db';
import { mrs, notesCache } from '../db/schema';
import { mrInvolves } from './mineScope';
import type { MrFields } from './gitlabMr';

/**
 * Persistence for `mrs` / `notes_cache`.
 *  - `mrs.synced_at` is advanced only by a FULL (detail) sync or when a row is first created; a list
 *    sync that updates an existing row leaves it alone. Note read-state uses it as a baseline.
 *  - List payloads carry no approvals / notes / pipeline, so `upsertMrSummaries` never overwrites those.
 */

export type CachedMr = typeof mrs.$inferSelect;

export function getCachedMr(app: AppDb, repoId: string, iid: number): CachedMr | undefined {
  return app.db
    .select()
    .from(mrs)
    .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, iid)))
    .get();
}

/** iids cached as `opened` for a repo (used to notice MRs that were merged/closed meanwhile). */
/** Cached open MRs of a repo; with `involving`, only those where that user is author, assignee or reviewer. */
export function listCachedOpenIids(app: AppDb, repoId: string, involving?: string): number[] {
  return app.db
    .select({
      iid: mrs.iid,
      author: mrs.author,
      assignees: mrs.assignees,
      reviewers: mrs.reviewers,
    })
    .from(mrs)
    .where(and(eq(mrs.repoId, repoId), eq(mrs.state, 'opened')))
    .all()
    .filter((r) => involving === undefined || mrInvolves(r, involving))
    .map((r) => r.iid);
}

/**
 * Upserts MRs coming from a LIST response. Only fields the list endpoint is authoritative for are
 * updated; approvals, last note and head pipeline are kept. `hasConflicts`/`headPipeline` are updated
 * only when the payload actually carried them.
 */
export function upsertMrSummaries(
  app: AppDb,
  repoId: string,
  items: readonly MrFields[],
  now: number,
): number {
  if (items.length === 0) return 0;
  app.db.transaction((tx) => {
    for (const f of items) {
      const common = {
        gitlabId: f.gitlabId,
        title: f.title,
        state: f.state,
        draft: f.draft,
        sourceBranch: f.sourceBranch,
        targetBranch: f.targetBranch,
        author: f.author,
        webUrl: f.webUrl,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        mergedAt: f.mergedAt,
        descriptionNotionId: f.descriptionNotionId,
        ...(f.hasConflicts !== null ? { hasConflicts: f.hasConflicts } : {}),
        ...(f.headPipeline !== undefined ? { headPipeline: f.headPipeline } : {}),
        ...(f.assignees !== undefined ? { assignees: f.assignees } : {}),
        ...(f.reviewers !== undefined ? { reviewers: f.reviewers } : {}),
      };
      tx.insert(mrs)
        .values({
          repoId,
          iid: f.iid,
          ...common,
          hasConflicts: f.hasConflicts ?? false,
          headPipeline: f.headPipeline ?? null,
          approvedBy: [],
          assignees: f.assignees ?? [],
          reviewers: f.reviewers ?? [],
          lastNoteAt: null,
          syncedAt: now,
        })
        .onConflictDoUpdate({ target: [mrs.repoId, mrs.iid], set: common })
        .run();
    }
  });
  return items.length;
}

/**
 * Upserts one fully synced MR and, when `notes` is given, replaces its cached notes in the same
 * transaction. `notes === undefined` means "notes could not be fetched": the cache is left untouched.
 */
export function persistSyncedMr(
  app: AppDb,
  mr: Mr,
  notes: readonly Note[] | undefined,
  /** Usernames that are "me" (see `isMyUser`). */
  mine: readonly string[] = [],
): void {
  app.db.transaction((tx) => {
    const prior = tx
      .select({ syncedAt: mrs.syncedAt })
      .from(mrs)
      .where(and(eq(mrs.repoId, mr.repoId), eq(mrs.iid, mr.iid)))
      .get();

    const { repoId, iid, ...rest } = mr;
    tx.insert(mrs)
      .values({ repoId, iid, ...rest })
      .onConflictDoUpdate({ target: [mrs.repoId, mrs.iid], set: rest })
      .run();

    if (notes === undefined) return;

    const existing = new Map(
      tx
        .select({ noteId: notesCache.noteId, seen: notesCache.seen })
        .from(notesCache)
        .where(and(eq(notesCache.repoId, repoId), eq(notesCache.mrIid, iid)))
        .all()
        .map((r) => [r.noteId, r.seen] as const),
    );

    for (const n of notes) {
      // New notes are unread unless: it is the first time we see this MR, it is older than our last
      // full sync of it, or I wrote it. Notes we already cache keep their read state.
      const readByDefault =
        prior === undefined || n.createdAt <= prior.syncedAt || isMyUser(n.author, mine);
      const seen = existing.get(n.noteId) ?? readByDefault;
      tx.insert(notesCache)
        .values({
          repoId,
          mrIid: iid,
          noteId: n.noteId,
          discussionId: n.discussionId,
          author: n.author,
          body: n.body,
          system: n.system,
          resolvable: n.resolvable,
          resolved: n.resolved,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          seen,
        })
        .onConflictDoUpdate({
          target: [notesCache.repoId, notesCache.noteId],
          set: {
            mrIid: iid,
            discussionId: n.discussionId,
            author: n.author,
            body: n.body,
            system: n.system,
            resolvable: n.resolvable,
            resolved: n.resolved,
            updatedAt: n.updatedAt,
          },
        })
        .run();
    }

    // Notes deleted on GitLab disappear from the cache (only after a complete fetch).
    const keep = notes.map((n) => n.noteId);
    tx.delete(notesCache)
      .where(
        keep.length > 0
          ? and(
              eq(notesCache.repoId, repoId),
              eq(notesCache.mrIid, iid),
              notInArray(notesCache.noteId, keep),
            )
          : and(eq(notesCache.repoId, repoId), eq(notesCache.mrIid, iid)),
      )
      .run();
  });
}

/** Cached notes of one thread (oldest first). Empty when the thread is not cached (yet). */
export function getCachedDiscussionNotes(
  app: AppDb,
  repoId: string,
  iid: number,
  discussionId: string,
): (typeof notesCache.$inferSelect)[] {
  return app.db
    .select()
    .from(notesCache)
    .where(
      and(
        eq(notesCache.repoId, repoId),
        eq(notesCache.mrIid, iid),
        eq(notesCache.discussionId, discussionId),
      ),
    )
    .orderBy(notesCache.createdAt)
    .all();
}

/**
 * After a live resolve/unresolve: mirror GitLab's answer into the cached notes of that thread (only the
 * notes GitLab returned; anything else waits for the next sync). Returns the number of rows changed.
 */
export function applyDiscussionNotes(app: AppDb, notes: readonly Note[]): number {
  let changed = 0;
  app.db.transaction((tx) => {
    for (const n of notes) {
      const r = tx
        .update(notesCache)
        .set({ resolvable: n.resolvable, resolved: n.resolved, updatedAt: n.updatedAt })
        .where(and(eq(notesCache.repoId, n.repoId), eq(notesCache.noteId, n.noteId)))
        .run();
      changed += r.changes;
    }
  });
  return changed;
}

/**
 * After a live reply: cache the note GitLab created, marked as read (I wrote it). The MR row must exist
 * (FK); the next full sync or the note webhook reconciles everything else (`lastNoteAt`, waiting-on).
 */
export function insertOwnNote(app: AppDb, n: Note): void {
  app.db
    .insert(notesCache)
    .values({
      repoId: n.repoId,
      mrIid: n.mrIid,
      noteId: n.noteId,
      discussionId: n.discussionId,
      author: n.author,
      body: n.body,
      system: n.system,
      resolvable: n.resolvable,
      resolved: n.resolved,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      seen: true,
    })
    .onConflictDoNothing()
    .run();
}
