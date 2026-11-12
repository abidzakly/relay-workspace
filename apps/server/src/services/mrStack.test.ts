import { afterEach, describe, expect, it } from 'vitest';
import { readLiveStack, type StackReader } from './mrStack';
import type { MrFields } from './gitlabMr';
import { GitlabApiError } from './gitlabService';
import { GitlabMergeApi } from './gitlabMerge';
import { GitlabReleaseApi } from './gitlabRelease';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';

const sha = (c: string) => c.repeat(40);
const mr = (iid: number, branch: string, head: string | null): MrFields =>
  ({ iid, sourceBranch: branch, targetBranch: 'main', headSha: head }) as MrFields;

const reader = (over: Partial<StackReader> = {}): StackReader => ({
  getMrCommitShas: async () => ({ shas: [sha('b'), sha('a')], truncated: false }),
  listOpenMrsInto: async () => ({
    mrs: [mr(1, 'a', sha('a')), mr(2, 'b', sha('b'))],
    complete: true,
  }),
  ...over,
});
const self = { iid: 2, sourceBranch: 'b', targetBranch: 'main' };

describe('readLiveStack', () => {
  it('finds the open parent', async () => {
    const s = await readLiveStack(reader(), self);
    expect(s).toEqual({ status: 'ok', openParents: [{ iid: 1, branch: 'a' }], commitCount: 2 });
  });
  it('a pushed branch without MR counts as parent', async () => {
    const s = await readLiveStack(
      reader({ listOpenMrsInto: async () => ({ mrs: [mr(2, 'b', sha('b'))], complete: true }) }),
      self,
      { branchHeads: async () => [{ branch: 'a', sha: sha('a') }] },
    );
    expect(s.openParents).toEqual([{ iid: null, branch: 'a' }]);
  });
  it.each([
    [
      'commit read fails',
      { getMrCommitShas: () => Promise.reject(new GitlabApiError('server', 500, '/x')) },
    ],
    ['commits truncated', { getMrCommitShas: async () => ({ shas: [], truncated: true }) }],
    ['open list incomplete', { listOpenMrsInto: async () => ({ mrs: [], complete: false }) }],
    [
      'open MR without sha',
      { listOpenMrsInto: async () => ({ mrs: [mr(1, 'a', null)], complete: true }) },
    ],
  ] as const)('fails closed: %s', async (_n, over) => {
    const s = await readLiveStack(reader(over as Partial<StackReader>), self);
    expect(s.status).toBe('error');
  });
});

describe('write bodies (never squash)', () => {
  const HOST = 'https://gitlab.example.test';
  let m: ReturnType<typeof mockHttp>;
  afterEach(async () => {
    await m.close();
  });

  it('merge always sends squash:false + should_remove_source_branch:true', async () => {
    m = mockHttp({ maxRetries: 0 });
    let body: unknown;
    m.agent
      .get(HOST)
      .intercept({
        path: '/api/v4/projects/9/merge_requests/5/merge',
        method: 'PUT',
        body: (b) => {
          body = JSON.parse(b);
          return true;
        },
      })
      .reply(200, {}, { headers: JSON_HEADERS });
    await new GitlabMergeApi(HOST, 'tok', 9, m.http).merge(5, sha('c'));
    expect(body).toEqual({ sha: sha('c'), squash: false, should_remove_source_branch: true });
  });

  it('createMr sends squash:false + remove_source_branch:true', async () => {
    m = mockHttp({ maxRetries: 0 });
    let body: Record<string, unknown> = {};
    m.agent
      .get(HOST)
      .intercept({
        path: '/api/v4/projects/9/merge_requests',
        method: 'POST',
        body: (b) => {
          body = JSON.parse(b) as Record<string, unknown>;
          return true;
        },
      })
      .reply(201, {}, { headers: JSON_HEADERS });
    await new GitlabReleaseApi(HOST, 'tok', 9, m.http).createMr({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      title: 'feat/x',
      description: 'https://notion.so/x',
      assigneeId: 1,
      reviewerIds: [2],
    });
    expect(body).toMatchObject({ squash: false, remove_source_branch: true, title: 'feat/x' });
    expect(body).not.toHaveProperty('milestone_id');
    expect(body).not.toHaveProperty('labels');
  });
});
