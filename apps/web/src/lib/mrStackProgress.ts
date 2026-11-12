import type { MrStack } from '@relay/shared';

/**
 * Who belongs to a stack, remembered on this device. The server only lays out open MRs and names a stack after its
 * current root, so once a parent merges nothing says which MRs were one stack. This only answers "which MRs to check":
 * calling a stack fully merged still needs the server to report every one of them merged.
 */
export interface StackMembers {
  repoId: string;
  iids: number[];
}

const STORAGE_KEY = 'core-stack-members';
const LIMIT = 40;

/** Adds what was just seen. Stacks sharing an MR are one stack at different moments, so they are joined. */
export function joinStacks(
  known: readonly StackMembers[],
  seen: readonly MrStack[],
): StackMembers[] {
  let next = [...known];
  for (const stack of seen) {
    const iids = stack.nodes.flatMap((n) => (n.iid === null ? [] : [n.iid]));
    if (iids.length === 0) continue;
    const overlapping = next.filter(
      (k) => k.repoId === stack.repoId && k.iids.some((i) => iids.includes(i)),
    );
    const joined = [...new Set([...overlapping.flatMap((k) => k.iids), ...iids])].sort(
      (a, b) => a - b,
    );
    next = [
      ...next.filter((k) => !overlapping.includes(k)),
      { repoId: stack.repoId, iids: joined },
    ];
  }
  return next.slice(-LIMIT);
}

function read(): StackMembers[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as StackMembers[]) : [];
  } catch {
    return [];
  }
}

export function rememberStacks(seen: readonly MrStack[]): void {
  if (seen.length === 0) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(joinStacks(read(), seen)));
  } catch {
    /* Without storage the stack's event is skipped; the merge keeps its own reward. */
  }
}

/** The remembered members of this MR's stack, or null when it was never seen in one. */
export function stackMembersOf(repoId: string, iid: number): number[] | null {
  return read().find((k) => k.repoId === repoId && k.iids.includes(iid))?.iids ?? null;
}
