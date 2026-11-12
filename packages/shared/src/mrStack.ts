import { z } from 'zod';
import { RepoIdSchema } from './common';

/**
 * Stacked MRs. Every card MR targets `main`; a branch checked out from another
 * card's branch carries that parent's commits, so merging the child would silently merge the parent too.
 *
 * Rule: MR (or pushed branch) A is an ancestor of B  <=>  A's head SHA is one of B's commits (`main...B`).
 * The DIRECT parent is the ancestor whose head appears first in B's commit list (GitLab lists newest first).
 * Merge order is strictly one at a time, parent first; the bottom of a stack (position 1) is the only mergeable one.
 */

export interface StackInputNode {
  /** Stable key, e.g. `!12` for an MR or `branch:feat/x` for a pushed branch without MR. */
  key: string;
  iid: number | null;
  branch: string;
  headSha: string | null;
  /** Commits of `target...branch`, newest first; null = unknown (commit list not read). */
  commits: readonly string[] | null;
}

export interface StackPlacement {
  key: string;
  /** Direct parent key, null for a root. */
  parentKey: string | null;
  /** 1 = bottom (the parent, mergeable first), 2 = its child, … */
  position: number;
  /** Key of the root of this node's stack (= own key for a root). */
  rootKey: string;
}

const lowerSha = (s: string | null | undefined): string | null => (s ? s.toLowerCase() : null);

/** All open ancestors of `self` among `candidates` (heads found in self's commits). Pure. */
export function ancestorsOf<T extends { headSha: string | null; key: string }>(
  self: { key: string; headSha: string | null; commits: readonly string[] },
  candidates: readonly T[],
): T[] {
  const commits = self.commits.map((c) => c.toLowerCase());
  const own = lowerSha(self.headSha);
  return candidates.filter((c) => {
    const h = lowerSha(c.headSha);
    return c.key !== self.key && !!h && h !== own && commits.includes(h);
  });
}

/**
 * Places every node into a forest. Nodes whose commits are unknown are placed as roots (callers that GATE must
 * treat unknown as blocked; this function only lays out the list). Cycles are impossible with real git history
 * but are broken defensively (a node never becomes its own ancestor).
 */
export function buildStackForest(nodes: readonly StackInputNode[]): StackPlacement[] {
  const byKey = new Map(nodes.map((n) => [n.key, n] as const));
  const parent = new Map<string, string | null>();
  for (const n of nodes) {
    if (!n.commits) {
      parent.set(n.key, null);
      continue;
    }
    const anc = ancestorsOf({ key: n.key, headSha: n.headSha, commits: n.commits }, nodes);
    if (anc.length === 0) {
      parent.set(n.key, null);
      continue;
    }
    const idx = (a: StackInputNode) =>
      n.commits!.findIndex((c) => c.toLowerCase() === lowerSha(a.headSha));
    anc.sort((a, b) => idx(a) - idx(b) || a.key.localeCompare(b.key));
    parent.set(n.key, anc[0]!.key);
  }
  const out: StackPlacement[] = [];
  for (const n of nodes) {
    let position = 1;
    let rootKey = n.key;
    const seen = new Set<string>([n.key]);
    let p = parent.get(n.key) ?? null;
    while (p && byKey.has(p) && !seen.has(p)) {
      seen.add(p);
      position++;
      rootKey = p;
      p = parent.get(p) ?? null;
    }
    out.push({ key: n.key, parentKey: parent.get(n.key) ?? null, position, rootKey });
  }
  return out;
}

// ───────────────────────────── payload ─────────────────────────────

export const MrStackRefSchema = z.object({
  /** Same for every member of one stack (root key + repo). */
  groupId: z.string(),
  /** 1 = bottom (merge first). */
  position: z.number().int().positive(),
  /** Number of members in the group (1 = not stacked). */
  size: z.number().int().positive(),
  parentIid: z.number().int().positive().nullable(),
  parentBranch: z.string().nullable(),
  /** false = the parent is a pushed branch that has no MR yet. */
  parentHasMr: z.boolean(),
  /** true = an ancestor is still open / has no MR: merging is blocked (cosmetic; the server re-checks live). */
  blocked: z.boolean(),
  /** null = commit list not known yet (treated as blocked by the merge gate). */
  commitCount: z.number().int().nonnegative().nullable(),
});
export type MrStackRef = z.infer<typeof MrStackRefSchema>;

export const MrStackNodeSchema = z.object({
  key: z.string(),
  iid: z.number().int().positive().nullable(),
  branch: z.string(),
  parentKey: z.string().nullable(),
  position: z.number().int().positive(),
});
export const MrStackSchema = z.object({
  repoId: RepoIdSchema,
  groupId: z.string(),
  /** Sorted parent → child (position ascending). */
  nodes: z.array(MrStackNodeSchema),
});
export type MrStack = z.infer<typeof MrStackSchema>;

/** Groups placements into stacks of size > 1 (sorted by position). */
export function stacksOf(
  repoId: string,
  nodes: readonly StackInputNode[],
  placements: readonly StackPlacement[],
): MrStack[] {
  const byKey = new Map(nodes.map((n) => [n.key, n] as const));
  const groups = new Map<string, StackPlacement[]>();
  for (const p of placements) {
    const g = groups.get(p.rootKey);
    if (g) g.push(p);
    else groups.set(p.rootKey, [p]);
  }
  const out: MrStack[] = [];
  for (const [root, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
    out.push({
      repoId,
      groupId: `${repoId}:${root}`,
      nodes: list.map((p) => ({
        key: p.key,
        iid: byKey.get(p.key)?.iid ?? null,
        branch: byKey.get(p.key)?.branch ?? p.key,
        parentKey: p.parentKey,
        position: p.position,
      })),
    });
  }
  return out;
}
