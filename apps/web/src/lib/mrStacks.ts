import type { InboxMr } from '@relay/shared';

/**
 * Stacked-MR grouping for lists. Members of one stack are rendered together as a pile:
 * the parent (position 1, the only mergeable one) at the BOTTOM, dependents stacked upwards. Groups keep the order of
 * their best-ranked member in the incoming (already sorted) list. Pure.
 */
export interface MrGroup {
  id: string;
  /** Top → bottom (highest position first; the last item is the parent / `#1`). */
  items: InboxMr[];
  stacked: boolean;
}

export function groupByStack(items: readonly InboxMr[]): MrGroup[] {
  const groups = new Map<string, MrGroup>();
  const order: string[] = [];
  for (const m of items) {
    const st = m.stack;
    const id = st && st.size > 1 ? st.groupId : `${m.repoId}#${m.iid}`;
    let g = groups.get(id);
    if (!g) {
      g = { id, items: [], stacked: !!st && st.size > 1 };
      groups.set(id, g);
      order.push(id);
    }
    g.items.push(m);
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => (b.stack?.position ?? 1) - (a.stack?.position ?? 1) || a.iid - b.iid);
  }
  return order.map((id) => groups.get(id)!);
}

/** Short status line of a stack member, or null when it is mergeable / not stacked. */
export function stackWaitLabel(m: InboxMr): string | null {
  const st = m.stack;
  if (!st) return null;
  if (st.parentIid !== null) return `Waiting for !${st.parentIid} to merge`;
  if (st.parentBranch && !st.parentHasMr) return `Parent ${st.parentBranch} has no MR yet`;
  if (st.commitCount === null) return 'Stack not checked yet';
  return null;
}
