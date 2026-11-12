import { describe, expect, it } from 'vitest';
import type { InboxMr } from '@relay/shared';
import { groupByStack, stackWaitLabel } from './mrStacks';

const mr = (iid: number, stack: InboxMr['stack']): InboxMr =>
  ({ repoId: 'app', iid, stack }) as InboxMr;
const ref = (position: number, parentIid: number | null) => ({
  groupId: 'app:!1',
  position,
  size: 3,
  parentIid,
  parentBranch: parentIid ? `b${parentIid}` : null,
  parentHasMr: true,
  blocked: parentIid !== null,
  commitCount: position,
});

describe('groupByStack', () => {
  it('piles a stack with the parent at the bottom and keeps singles alone', () => {
    const g = groupByStack([mr(2, ref(2, 1)), mr(9, null), mr(1, ref(1, null)), mr(3, ref(3, 2))]);
    expect(g.map((x) => x.items.map((m) => m.iid))).toEqual([[3, 2, 1], [9]]);
    expect(g[0]!.stacked).toBe(true);
  });
  it('labels a waiting child', () => {
    expect(stackWaitLabel(mr(2, ref(2, 1)))).toBe('Waiting for !1 to merge');
    expect(stackWaitLabel(mr(1, ref(1, null)))).toBeNull();
  });
});
