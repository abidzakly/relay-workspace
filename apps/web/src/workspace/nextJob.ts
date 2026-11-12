import type { ActionGroup, ActionRow } from '@/overview/needsActionModel';
import { objectForPath, type ObjectId } from './registry';

/** The one thing the workspace suggests next. Pure: no React, no fetching. */
export interface NextJob {
  row: ActionRow;
  group: ActionGroup['id'];
  /** The world object to glow; null when no object owns the row's page. */
  object: ObjectId | null;
  /** Always navigation words. The merge itself stays behind the live gate and its dialog. */
  cta: string;
}

const CTA: Record<ActionGroup['id'], string> = {
  mismatches: 'See the mismatch',
  mrs: 'Open the MR',
  pipelines: 'See the pipeline',
  sla: 'See the risk',
  release: 'Open the release',
};

/**
 * Lower goes first. The groups' own order is for a list, where a warning above a failed pipeline does no harm; one
 * suggestion has to be the most urgent thing.
 */
function rank(group: ActionGroup['id'], row: ActionRow): number {
  switch (group) {
    case 'mismatches':
    case 'sla':
      return row.severity === 'critical' ? 0 : 3;
    case 'pipelines':
      return 1;
    case 'mrs':
      return 2;
    case 'release':
      return 4;
  }
}

/**
 * The most urgent row, or null when nothing asks for you. A blocked stack member is never picked: its parent comes
 * first, so suggesting it would point at something that cannot move. Ties keep the source's order.
 */
export function pickNextJob(groups: readonly ActionGroup[]): NextJob | null {
  let best: { group: ActionGroup['id']; row: ActionRow; rank: number } | null = null;
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.blocked) continue;
      const r = rank(group.id, row);
      if (!best || r < best.rank) best = { group: group.id, row, rank: r };
    }
  }
  if (!best) return null;
  return {
    row: best.row,
    group: best.group,
    // `objectForPath` takes a path: `/release?repo=x` would otherwise belong to nothing.
    object: objectForPath(best.row.to.split(/[?#]/, 1)[0]!),
    cta: CTA[best.group],
  };
}
