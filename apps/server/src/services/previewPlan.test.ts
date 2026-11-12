import { describe, expect, it } from 'vitest';
import { orderForMerge, type PreviewMrRow } from './previewPlan';

const sha = (c: string) => c.repeat(40);
const row = (iid: number, branch: string, head: string, commits: string[]): PreviewMrRow => ({
  iid,
  title: branch,
  branch,
  draft: false,
  hasConflicts: false,
  webUrl: null,
  headSha: head,
  commits,
});

describe('orderForMerge', () => {
  it('puts a stack parent before its child even when the child has the lower number', () => {
    const parent = row(9, 'parent', sha('a'), [sha('a')]);
    const child = row(3, 'child', sha('b'), [sha('b'), sha('a')]);
    const out = orderForMerge([child, parent]);
    expect(out.map((r) => r.iid)).toEqual([9, 3]);
    expect(out[1]?.parentBranch).toBe('parent');
  });

  it('orders independent MRs by number', () => {
    const a = row(5, 'a', sha('a'), [sha('a')]);
    const b = row(2, 'b', sha('b'), [sha('b')]);
    expect(orderForMerge([a, b]).map((r) => r.iid)).toEqual([2, 5]);
  });

  it('treats unknown commit lists as independent', () => {
    const a = { ...row(5, 'a', sha('a'), []), commits: null };
    const b = { ...row(2, 'b', sha('b'), []), commits: null };
    expect(orderForMerge([a, b]).map((r) => r.iid)).toEqual([2, 5]);
  });
});
