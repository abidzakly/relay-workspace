import { describe, expect, it } from 'vitest';
import type { GitlabService } from '../gitlabService';
import { ownCommitsCompare } from './diffSources';

const cmp = (ids: string[], tag: string) => ({
  commits: ids.map((id) => ({ id, title: id })),
  commitCount: ids.length,
  files: [{ path: tag }],
  truncated: false,
  webUrl: null,
});

/** child = c3 (own) on top of c2, c1 (parent head = c2). */
function fake(opts: {
  mrs?: { iid: number; sourceBranch: string; headSha: string }[];
  parentFails?: boolean;
}) {
  const calls: string[] = [];
  const svc = {
    compare: async (from: string, to: string) => {
      calls.push(`${from}...${to}`);
      if (from === 'main')
        return cmp(
          ['c3', 'c2', 'c1'].map((s) => s.padEnd(40, '0')),
          'full',
        );
      if (opts.parentFails) throw new Error('boom');
      return cmp(['c3'.padEnd(40, '0')], 'own');
    },
    listOpenMrsInto: async () => ({ mrs: opts.mrs ?? [], complete: true }),
  };
  return { svc: svc as unknown as GitlabService, calls };
}
const C2 = 'c2'.padEnd(40, '0');

describe('ownCommitsCompare', () => {
  it('no parent: full compare', async () => {
    const { svc } = fake({});
    const r = await ownCommitsCompare(svc, 'main', 'feat/child');
    expect(r.parent).toBeNull();
    expect(r.compare.files).toEqual([{ path: 'full' }]);
  });
  it('open MR parent: compare from its head', async () => {
    const { svc, calls } = fake({ mrs: [{ iid: 1, sourceBranch: 'feat/parent', headSha: C2 }] });
    const r = await ownCommitsCompare(svc, 'main', 'feat/child');
    expect(r.parent).toBe('feat/parent');
    expect(r.compare.files).toEqual([{ path: 'own' }]);
    expect(calls).toContain(`${C2}...feat/child`);
  });
  it('pushed branch without MR counts as parent', async () => {
    const { svc } = fake({});
    const r = await ownCommitsCompare(svc, 'main', 'feat/child', () => [
      { branch: 'feat/parent', sha: C2 },
    ]);
    expect(r.parent).toBe('feat/parent');
  });
  it('parent compare failure falls back to full', async () => {
    const { svc } = fake({
      mrs: [{ iid: 1, sourceBranch: 'feat/parent', headSha: C2 }],
      parentFails: true,
    });
    const r = await ownCommitsCompare(svc, 'main', 'feat/child');
    expect(r.parent).toBeNull();
    expect(r.compare.files).toEqual([{ path: 'full' }]);
  });
});
