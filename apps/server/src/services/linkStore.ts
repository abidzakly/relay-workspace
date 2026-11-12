import { and, eq } from 'drizzle-orm';
import type { MrDerivedState, RepoConfig } from '@relay/shared';
import type { AppDb } from '../db';
import { cards, links, mrs, notesCache } from '../db/schema';
import {
  matchCardsToMrs,
  type ManualLinkInput,
  type MatchCard,
  type MatchMr,
  type MatchResult,
} from './matcher';
import { deriveMrState } from './mrState';

/**
 * Persistence for `links` + the orchestrator that feeds the pure matcher from the cache.
 * Local cache only: nothing here talks to GitLab or Notion, and nothing writes to Notion.
 *  - Automatic rows (`match_by` title|description|both) are fully derived: recomputed, updated, and
 *    deleted when the keys stop matching.
 *  - `manual` rows (user-confirmed linker, later part) are never deleted here; only their `conflict`
 *    flag is refreshed.
 */

export interface PersistReport {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

const linkKey = (cardId: string, repoId: string, iid: number) =>
  `${cardId}\u0000${repoId}\u0000${iid}`;

export function loadMatchInput(app: AppDb): {
  cards: MatchCard[];
  mrs: MatchMr[];
  manualLinks: ManualLinkInput[];
} {
  const cardRows = app.db
    .select({ id: cards.id, branchName: cards.branchName, archived: cards.archived })
    .from(cards)
    .all();
  const mrRows = app.db
    .select({
      repoId: mrs.repoId,
      iid: mrs.iid,
      title: mrs.title,
      sourceBranch: mrs.sourceBranch,
      state: mrs.state,
      draft: mrs.draft,
      descriptionNotionId: mrs.descriptionNotionId,
    })
    .from(mrs)
    .all();
  const manual = app.db
    .select({ cardId: links.cardId, repoId: links.repoId, mrIid: links.mrIid })
    .from(links)
    .where(eq(links.matchBy, 'manual'))
    .all();
  return {
    cards: cardRows,
    mrs: mrRows.map((r) => ({ ...r, state: r.state as MatchMr['state'] })),
    manualLinks: manual,
  };
}

/** Makes `links` equal to `result.links` (see module comment for the manual-row rule). One transaction. */
export function persistLinks(app: AppDb, result: MatchResult): PersistReport {
  const report: PersistReport = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  app.db.transaction((tx) => {
    const existing = tx.select().from(links).all();
    const desired = new Map(result.links.map((l) => [linkKey(l.cardId, l.repoId, l.mrIid), l]));
    const seen = new Set<string>();

    for (const row of existing) {
      const key = linkKey(row.cardId, row.repoId, row.mrIid);
      const want = desired.get(key);
      if (!want) {
        if (row.matchBy === 'manual') continue; // never deleted here
        tx.delete(links).where(eq(links.id, row.id)).run();
        report.deleted++;
        continue;
      }
      seen.add(key);
      const matchBy = row.matchBy === 'manual' ? 'manual' : want.matchBy;
      if (row.matchBy === matchBy && row.conflict === want.conflict) {
        report.unchanged++;
        continue;
      }
      tx.update(links)
        .set({ matchBy, conflict: want.conflict })
        .where(and(eq(links.id, row.id)))
        .run();
      report.updated++;
    }

    for (const [key, want] of desired) {
      if (seen.has(key)) continue;
      tx.insert(links)
        .values({
          cardId: want.cardId,
          repoId: want.repoId,
          mrIid: want.mrIid,
          matchBy: want.matchBy,
          conflict: want.conflict,
        })
        .run();
      report.inserted++;
    }
  });
  return report;
}

/** Re-runs the matcher over the whole cache (all repos: duplicates can span repos) and persists it. */
export function relinkAll(
  app: AppDb,
  repos: readonly Pick<RepoConfig, 'id' | 'versionBranchPrefix'>[],
): { result: MatchResult; persisted: PersistReport } {
  const prefixes = new Map(repos.map((r) => [r.id, r.versionBranchPrefix] as const));
  const input = loadMatchInput(app);
  const result = matchCardsToMrs({ ...input, versionBranchPrefix: (id) => prefixes.get(id) });
  return { result, persisted: persistLinks(app, result) };
}

/** Derived state for every cached MR, keyed `"<repoId>#<iid>"` (reviewers are per repo). */
export function loadMrStates(
  app: AppDb,
  repos: readonly Pick<RepoConfig, 'id' | 'reviewers'>[],
): Map<string, Exclude<MrDerivedState, 'none'>> {
  const reviewers = new Map(repos.map((r) => [r.id, r.reviewers] as const));
  const notesByMr = new Map<string, { author: string | null; system: boolean }[]>();
  for (const n of app.db
    .select({
      repoId: notesCache.repoId,
      mrIid: notesCache.mrIid,
      author: notesCache.author,
      system: notesCache.system,
    })
    .from(notesCache)
    .all()) {
    const k = `${n.repoId}#${n.mrIid}`;
    const list = notesByMr.get(k);
    if (list) list.push(n);
    else notesByMr.set(k, [n]);
  }
  const out = new Map<string, Exclude<MrDerivedState, 'none'>>();
  for (const m of app.db.select().from(mrs).all()) {
    const k = `${m.repoId}#${m.iid}`;
    out.set(
      k,
      deriveMrState(
        {
          state: m.state as 'opened' | 'closed' | 'locked' | 'merged',
          draft: m.draft,
          author: m.author,
          approvedBy: m.approvedBy,
        },
        notesByMr.get(k) ?? [],
        reviewers.get(m.repoId) ?? [],
      ),
    );
  }
  return out;
}
