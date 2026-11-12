import type { MrDerivedState, MrState } from '@relay/shared';

/**
 * Derived MR state: none / open / draft / reviewed / approved / merged / closed.
 * PURE and COSMETIC: the merge gate re-fetches live MR + approvals at click time and never uses this.
 *
 *   merged                      state = merged
 *   closed                      state = closed
 *   draft                       open MR flagged draft (wins over approved/reviewed: a draft cannot merge)
 *   approved                    approved by ANY configured reviewer
 *   reviewed                    a configured reviewer left a non-system note (and is not the MR author)
 *   open                        everything else
 * `locked` (GitLab: merge in progress) is treated as an open MR.
 */

export interface MrStateInput {
  state: MrState;
  draft: boolean;
  author: string | null;
  approvedBy: readonly string[];
}

export interface MrStateNote {
  author: string | null;
  system: boolean;
}

const lower = (s: string) => s.toLowerCase();

export function deriveMrState(
  mr: MrStateInput,
  notes: readonly MrStateNote[],
  reviewers: readonly string[],
): Exclude<MrDerivedState, 'none'> {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed') return 'closed';
  if (mr.draft) return 'draft';

  const rev = new Set(reviewers.map(lower));
  if (mr.approvedBy.some((u) => rev.has(lower(u)))) return 'approved';

  const author = mr.author ? lower(mr.author) : null;
  const reviewed = notes.some(
    (n) => !n.system && n.author !== null && rev.has(lower(n.author)) && lower(n.author) !== author,
  );
  return reviewed ? 'reviewed' : 'open';
}

/**
 * State of a CARD from the MRs linked to it: no link -> `none`; otherwise its primary MR = the newest
 * live (non-closed) one, else the newest closed one. Several live MRs is a flagged duplicate
 * (never auto-resolved); "newest" is only a display convention until the user resolves it.
 */
export function deriveCardMrState(
  linked: readonly { state: Exclude<MrDerivedState, 'none'>; createdAt: number }[],
): MrDerivedState {
  if (linked.length === 0) return 'none';
  const newest = (xs: typeof linked) => [...xs].sort((a, b) => b.createdAt - a.createdAt)[0]!;
  const live = linked.filter((l) => l.state !== 'closed');
  return newest(live.length > 0 ? live : linked).state;
}
