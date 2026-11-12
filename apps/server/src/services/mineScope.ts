import { and, eq, isNotNull, or } from 'drizzle-orm';
import type { AppDb } from '../db';
import { cards, links } from '../db/schema';
import { idKey } from './familyTree';
import { mrKey } from './syncHealthEngine';

/**
 * Which cached cards and MRs are "mine"; the views show nothing else. Cards: the KPI set (`assigned_to_me`, or a
 * manual assigned-at). MRs: I am the author, an assignee or a reviewer, or the MR is linked to one of my cards.
 */

const same = (a: string | null | undefined, b: string): boolean =>
  !!a && a.toLowerCase() === b.toLowerCase();

export function mrInvolves(
  mr: { author: string | null; assignees: readonly string[]; reviewers: readonly string[] },
  myUsername: string | undefined,
): boolean {
  if (!myUsername) return false;
  return (
    same(mr.author, myUsername) ||
    mr.assignees.some((u) => same(u, myUsername)) ||
    mr.reviewers.some((u) => same(u, myUsername))
  );
}

/** `mrKey`s of MRs linked to one of my (non-archived) cards. */
export function mrKeysLinkedToMyCards(app: AppDb): Set<string> {
  const mine = new Set(
    app.db
      .select({ id: cards.id })
      .from(cards)
      .where(
        and(
          eq(cards.archived, false),
          or(eq(cards.assignedToMe, true), isNotNull(cards.assignedAtManual)),
        ),
      )
      .all()
      .map((r) => idKey(r.id)),
  );
  const out = new Set<string>();
  for (const l of app.db.select().from(links).all()) {
    if (mine.has(idKey(l.cardId))) out.add(mrKey(l.repoId, l.mrIid));
  }
  return out;
}
