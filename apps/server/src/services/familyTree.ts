import type { Card, FamilyChild, FamilyTree, MrDerivedState, ParentChip } from '@relay/shared';
import { normalizeName } from '@relay/shared';
import { normalizeNotionId } from './notionUrl';

/**
 * Parent / "On Feedback" / Issues linkage: parent → child Issues cards, parent chips, and the
 * "all child Issues Ready to Test → suggest parent Ready to Test" signal. PURE. Suggests only: moving the parent
 * is a user-confirmed, audited, undoable Notion write.
 *
 * "Issues card" = type OR status named "Issues" (the word is used for both; both exist in the config).
 */

export const idKey = (id: string): string => normalizeNotionId(id) ?? id.toLowerCase();

export function isIssuesCard(card: Pick<Card, 'type' | 'status'>): boolean {
  return (
    (card.type !== null && normalizeName(card.type) === 'issues') ||
    (card.status !== null && normalizeName(card.status) === 'issues')
  );
}

export interface FamilyCardMr {
  state: MrDerivedState;
  repoId: string | null;
  iid: number | null;
}

export interface FamilyInput {
  /** Non-archived cards. */
  cards: readonly Card[];
  /** MR summary per card id (as `Card.id`); missing = no MR. */
  mrOf: (cardId: string) => FamilyCardMr | undefined;
  /** Configured "Ready to Test" status name. */
  readyStatus: string;
  /** Status name of a parent waiting on its Issues (default "On Feedback"). */
  onFeedbackStatus?: string;
}

export interface FamilyResult {
  families: FamilyTree[];
  chips: ParentChip[];
  /** parent id key → tree (for rules). */
  byParent: Map<string, FamilyTree>;
}

export function buildFamilies(input: FamilyInput): FamilyResult {
  const ready = normalizeName(input.readyStatus);
  const onFeedback = normalizeName(input.onFeedbackStatus ?? 'On Feedback');
  const byId = new Map(input.cards.map((c) => [idKey(c.id), c] as const));

  const kids = new Map<string, Card[]>();
  const chips: ParentChip[] = [];
  for (const c of input.cards) {
    if (!c.parentId) continue;
    const pk = idKey(c.parentId);
    const list = kids.get(pk);
    if (list) list.push(c);
    else kids.set(pk, [c]);
    const parent = byId.get(pk);
    chips.push({
      cardId: c.id,
      parentId: c.parentId,
      parentKnown: parent !== undefined,
      parentTitle: parent?.title ?? null,
      parentStatus: parent?.status ?? null,
    });
  }

  // A family exists for every parent that has children, and for every On Feedback card (even without children,
  // so the UI can show the empty tree behind an "orphan feedback" verdict).
  const parentKeys = new Set(kids.keys());
  for (const c of input.cards) {
    if (c.status !== null && normalizeName(c.status) === onFeedback) parentKeys.add(idKey(c.id));
  }

  const families: FamilyTree[] = [];
  const byParent = new Map<string, FamilyTree>();
  for (const pk of parentKeys) {
    const parent = byId.get(pk);
    const children: FamilyChild[] = (kids.get(pk) ?? [])
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .map((c) => {
        const mr = input.mrOf(c.id);
        return {
          cardId: c.id,
          title: c.title,
          status: c.status,
          type: c.type,
          isIssues: isIssuesCard(c),
          readyToTest: c.status !== null && normalizeName(c.status) === ready,
          mrState: mr?.state ?? 'none',
          mrRepoId: mr?.repoId ?? null,
          mrIid: mr?.iid ?? null,
        };
      });
    const issues = children.filter((c) => c.isIssues);
    const readyIssues = issues.filter((c) => c.readyToTest);
    const allIssuesReady = issues.length > 0 && readyIssues.length === issues.length;
    const tree: FamilyTree = {
      parentId: parent
        ? parent.id
        : (input.cards.find((c) => c.parentId && idKey(c.parentId) === pk)?.parentId ?? pk),
      parentKnown: parent !== undefined,
      parentTitle: parent?.title ?? null,
      parentStatus: parent?.status ?? null,
      children,
      issuesChildren: issues.length,
      readyIssuesChildren: readyIssues.length,
      allIssuesReady,
      suggestParentReady:
        allIssuesReady &&
        parent !== undefined &&
        parent.status !== null &&
        normalizeName(parent.status) === onFeedback,
    };
    families.push(tree);
    byParent.set(pk, tree);
  }
  families.sort(
    (a, b) =>
      (a.parentTitle ?? '~').localeCompare(b.parentTitle ?? '~') ||
      a.parentId.localeCompare(b.parentId),
  );
  return { families, chips, byParent };
}
