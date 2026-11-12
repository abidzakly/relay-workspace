import { and, eq, inArray } from 'drizzle-orm';
import { isMyUser, type HeadPipeline } from '@relay/shared';
import type { AppDb } from '../db';
import { mrs, notesCache } from '../db/schema';
import { extractNotionPageId } from './notionUrl';
import type { MergeRequestEvent, NoteEvent, PipelineEvent, PushEvent } from './webhookEvents';

/**
 * Per-event cache updates from webhook payloads ("update cache").
 * Local cache only; nothing is written to GitLab or Notion. These are a FAST PATH: the SyncEngine
 * refresh that follows every qualifying event re-reads GitLab and is authoritative, so anything the
 * payload cannot tell us (author, resolvable threads, approvals reset by a push) is simply left
 * alone here and filled in by that refresh. An MR that is not cached yet is not created from a
 * payload (its author/approvals are unknown); the refresh lists it.
 * Out-of-order / replayed deliveries are tolerated: an event older than the cached row is skipped.
 */

export interface CacheUpdate {
  /** MR iids whose cached row changed. */
  iids: number[];
  /** Short machine-readable note for logs / the `events` row. */
  note: string;
}

const NONE = (note: string): CacheUpdate => ({ iids: [], note });

function cachedMr(app: AppDb, repoId: string, iid: number) {
  return app.db
    .select()
    .from(mrs)
    .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, iid)))
    .get();
}

const APPROVE = new Set(['approved', 'approval']);
const UNAPPROVE = new Set(['unapproved', 'unapproval']);

/** merge_request hook -> `mrs` row (title/state/draft/branches/conflicts/notion key/approvals). */
export function applyMergeRequestEvent(
  app: AppDb,
  repoId: string,
  ev: MergeRequestEvent,
  now: number,
): CacheUpdate {
  const row = cachedMr(app, repoId, ev.iid);
  if (!row) return NONE('mr_not_cached');
  if (ev.updatedAt !== undefined && row.updatedAt !== null && ev.updatedAt < row.updatedAt) {
    return NONE('stale_event');
  }

  const set: Partial<typeof mrs.$inferInsert> = {};
  if (ev.title !== undefined && ev.title !== row.title) set.title = ev.title;
  if (ev.state !== undefined && ev.state !== row.state) set.state = ev.state;
  if (ev.draft !== undefined && ev.draft !== row.draft) set.draft = ev.draft;
  if (ev.sourceBranch && ev.sourceBranch !== row.sourceBranch) set.sourceBranch = ev.sourceBranch;
  if (ev.targetBranch && ev.targetBranch !== row.targetBranch) set.targetBranch = ev.targetBranch;
  if (ev.hasConflicts !== undefined && ev.hasConflicts !== row.hasConflicts) {
    set.hasConflicts = ev.hasConflicts;
  }
  if (ev.description !== undefined) {
    const key = extractNotionPageId(ev.description) ?? null;
    if (key !== row.descriptionNotionId) set.descriptionNotionId = key;
  }
  if (ev.updatedAt !== undefined && ev.updatedAt !== row.updatedAt) set.updatedAt = ev.updatedAt;
  if ((ev.state === 'merged' || ev.action === 'merge') && row.mergedAt === null) {
    set.mergedAt = ev.mergedAt ?? ev.updatedAt ?? now;
    if (row.state !== 'merged') set.state = 'merged';
  }

  // Approvals: the actor of an approved/unapproved action. Optimistic; the refresh is authoritative
  // (it also knows about approval resets and about non-configured approvers).
  const actor = ev.actor?.toLowerCase();
  if (actor && ev.action && (APPROVE.has(ev.action) || UNAPPROVE.has(ev.action))) {
    const has = row.approvedBy.some((u) => u.toLowerCase() === actor);
    if (APPROVE.has(ev.action) && !has) set.approvedBy = [...row.approvedBy, ev.actor!];
    if (UNAPPROVE.has(ev.action) && has) {
      set.approvedBy = row.approvedBy.filter((u) => u.toLowerCase() !== actor);
    }
  }

  if (Object.keys(set).length === 0) return NONE('no_change');
  app.db
    .update(mrs)
    .set(set)
    .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, ev.iid)))
    .run();
  return { iids: [ev.iid], note: 'mr_updated' };
}

/** note hook (on a merge request) -> `notes_cache` + `mrs.last_note_at`. */
export function applyNoteEvent(
  app: AppDb,
  repoId: string,
  ev: NoteEvent,
  now: number,
  /** Usernames that are "me" (see `isMyUser`). */
  myUsernames: readonly string[] = [],
): CacheUpdate {
  if (ev.mrIid === undefined) return NONE('not_a_merge_request_note');
  const row = cachedMr(app, repoId, ev.mrIid);
  if (!row) return NONE('mr_not_cached');

  const createdAt = ev.createdAt ?? now;
  const mine = isMyUser(ev.author, myUsernames);

  app.db.transaction((tx) => {
    const existing = tx
      .select({ seen: notesCache.seen })
      .from(notesCache)
      .where(and(eq(notesCache.repoId, repoId), eq(notesCache.noteId, ev.noteId)))
      .get();
    if (existing) {
      // An edited note keeps its read state; thread flags are left to the refresh.
      tx.update(notesCache)
        .set({ body: ev.body, updatedAt: ev.updatedAt ?? now })
        .where(and(eq(notesCache.repoId, repoId), eq(notesCache.noteId, ev.noteId)))
        .run();
      return;
    }
    tx.insert(notesCache)
      .values({
        repoId,
        mrIid: ev.mrIid!,
        noteId: ev.noteId,
        // The payload's discussion id when present; otherwise a placeholder the refresh replaces.
        discussionId: ev.discussionId ?? `note-${ev.noteId}`,
        author: ev.author ?? null,
        body: ev.body.slice(0, 4000),
        system: ev.system,
        // The hook says nothing about threads: unresolved/not-resolvable until the refresh reads them.
        resolvable: false,
        resolved: false,
        createdAt,
        updatedAt: ev.updatedAt ?? null,
        // New notes are unread unless I wrote them.
        seen: mine,
      })
      .run();
    if (!ev.system && (row.lastNoteAt === null || createdAt > row.lastNoteAt)) {
      tx.update(mrs)
        .set({ lastNoteAt: createdAt })
        .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, ev.mrIid!)))
        .run();
    }
  });
  return { iids: [ev.mrIid], note: 'note_cached' };
}

/** pipeline hook -> `mrs.head_pipeline` (newest pipeline id wins; older ones never overwrite). */
export function applyPipelineEvent(app: AppDb, repoId: string, ev: PipelineEvent): CacheUpdate {
  if (ev.tag) return NONE('tag_pipeline');
  let iids: number[];
  if (ev.mrIid !== undefined) {
    iids = [ev.mrIid];
  } else if (ev.ref) {
    iids = app.db
      .select({ iid: mrs.iid })
      .from(mrs)
      .where(
        and(
          eq(mrs.repoId, repoId),
          eq(mrs.sourceBranch, ev.ref),
          inArray(mrs.state, ['opened', 'locked']),
        ),
      )
      .all()
      .map((r) => r.iid);
  } else {
    iids = [];
  }
  if (iids.length === 0) return NONE('no_matching_mr');

  const next: HeadPipeline = { id: ev.pipelineId, status: ev.status, webUrl: ev.webUrl };
  const changed: number[] = [];
  app.db.transaction((tx) => {
    for (const iid of iids) {
      const row = tx
        .select({ head: mrs.headPipeline })
        .from(mrs)
        .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, iid)))
        .get();
      if (!row) continue;
      const cur = row.head;
      if (cur && cur.id > next.id) continue;
      if (cur && cur.id === next.id && cur.status === next.status) continue;
      tx.update(mrs)
        .set({ headPipeline: next })
        .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, iid)))
        .run();
      changed.push(iid);
    }
  });
  return changed.length > 0
    ? { iids: changed, note: 'pipeline_cached' }
    : NONE('pipeline_not_newer');
}

export interface PushUpdate extends CacheUpdate {
  /** The pushed branch is the repo's base branch or the target of a cached open MR. */
  touchesTarget: boolean;
}

/**
 * push hook -> `mrs.updated_at` of open MRs whose source branch was pushed. Branch deletions and
 * tag pushes change nothing. (Approval resets caused by a push are picked up by the refresh.)
 */
export function applyPushEvent(
  app: AppDb,
  repoId: string,
  ev: PushEvent,
  baseBranch: string,
  now: number,
): PushUpdate {
  if (!ev.branch) return { iids: [], note: 'not_a_branch', touchesTarget: false };
  const open = app.db
    .select({
      iid: mrs.iid,
      source: mrs.sourceBranch,
      target: mrs.targetBranch,
      updatedAt: mrs.updatedAt,
    })
    .from(mrs)
    .where(and(eq(mrs.repoId, repoId), inArray(mrs.state, ['opened', 'locked'])))
    .all();
  const touchesTarget = ev.branch === baseBranch || open.some((m) => m.target === ev.branch);
  if (ev.deleted) return { iids: [], note: 'branch_deleted', touchesTarget };

  const at = ev.lastCommitAt ?? now;
  const hit = open.filter((m) => m.source === ev.branch);
  const changed: number[] = [];
  app.db.transaction((tx) => {
    for (const m of hit) {
      if (m.updatedAt !== null && m.updatedAt >= at) continue;
      tx.update(mrs)
        .set({ updatedAt: at })
        .where(and(eq(mrs.repoId, repoId), eq(mrs.iid, m.iid)))
        .run();
      changed.push(m.iid);
    }
  });
  return {
    iids: changed,
    note: hit.length > 0 ? 'mr_branch_pushed' : touchesTarget ? 'target_pushed' : 'no_matching_mr',
    touchesTarget: touchesTarget || hit.length > 0,
  };
}
