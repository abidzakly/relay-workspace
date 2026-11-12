import { afterEach, describe, expect, it } from 'vitest';
import type { RepoConfig } from '@relay/shared';
import { GitlabService } from './gitlabService';
import {
  countChanges,
  mapBranches,
  mapCompare,
  mapDiffFilesFull,
  mapReviewDiscussions,
  mrDiffRefs,
} from './gitlabReview';
import { GitlabDiscussionsApi } from './gitlabDiscussions';
import { APPROVAL_NOTE, GitlabApproveApi } from './gitlabApprove';
import { mapApproveError } from './mrActions';
import { reviewApproval } from './review';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';
import { makeCtx, type TestCtx } from '../testing/ctx';

const HOST = 'https://gitlab.example.test';
const TOKEN = 'glpat-REVIEW-TOKEN-1234';
const SHA = (c: string) => c.repeat(40);

const DIFF = '@@ -1,3 +1,3 @@\n line\n-old\n+new\n+more\n\\ No newline at end of file\n';

describe('gitlabReview mapping', () => {
  it('counts +/- lines, ignoring markers', () => {
    expect(countChanges(DIFF)).toEqual({ additions: 2, deletions: 1 });
  });

  it('keeps diff text and classifies kinds', () => {
    const out = mapDiffFilesFull([
      { old_path: 'a.ts', new_path: 'a.ts', diff: DIFF },
      { old_path: 'b.ts', new_path: 'c.ts', renamed_file: true, diff: '' },
      {
        old_path: 'x.png',
        new_path: 'x.png',
        new_file: true,
        diff: 'Binary files /dev/null and b/x.png differ\n',
      },
      { old_path: 'big.js', new_path: 'big.js', too_large: true, diff: '' },
      { old_path: 'col.js', new_path: 'col.js', collapsed: true, diff: '' },
      { nonsense: true },
    ]);
    expect(out?.skipped).toBe(1);
    const [a, b, x, big, col] = out!.files;
    expect(a).toMatchObject({ kind: 'modified', diff: DIFF, additions: 2, deletions: 1 });
    expect(b).toMatchObject({ kind: 'renamed', oldPath: 'b.ts', path: 'c.ts', diff: '' });
    expect(x).toMatchObject({ kind: 'added', binary: true, diff: null });
    expect(big).toMatchObject({ tooLarge: true, diff: null });
    expect(col).toMatchObject({ collapsed: true, diff: null });
    expect(mapDiffFilesFull({})).toBeUndefined();
  });

  it('reads diff_refs only when all three SHAs are valid', () => {
    expect(
      mrDiffRefs({ diff_refs: { base_sha: SHA('a'), start_sha: SHA('b'), head_sha: SHA('c') } }),
    ).toEqual({ baseSha: SHA('a'), startSha: SHA('b'), headSha: SHA('c') });
    expect(
      mrDiffRefs({ diff_refs: { base_sha: 'x', start_sha: SHA('b'), head_sha: SHA('c') } }),
    ).toBeNull();
    expect(mrDiffRefs({})).toBeNull();
  });

  it('keeps discussion positions and drops system-only threads', () => {
    const d = mapReviewDiscussions([
      {
        id: 'd2',
        notes: [
          {
            id: 2,
            body: 'nit',
            author: { username: 'rina' },
            created_at: '2026-11-02T00:00:00Z',
            resolvable: true,
            resolved: false,
            position: {
              position_type: 'text',
              old_path: 'a.ts',
              new_path: 'a.ts',
              new_line: 3,
              old_line: null,
            },
          },
        ],
      },
      { id: 'd1', notes: [{ id: 1, body: 'general', created_at: '2026-11-01T00:00:00Z' }] },
      {
        id: 'sys',
        notes: [
          { id: 3, body: 'added 1 commit', system: true, created_at: '2026-11-01T00:00:00Z' },
        ],
      },
    ]);
    expect(d?.map((x) => x.id)).toEqual(['d1', 'd2']);
    expect(d?.[0]?.position).toBeNull();
    expect(d?.[1]).toMatchObject({
      resolvable: true,
      resolved: false,
      position: { path: 'a.ts', oldPath: 'a.ts', newLine: 3, oldLine: null },
    });
  });

  it('maps branches and compare', () => {
    expect(
      mapBranches([
        { name: 'main', default: true, commit: { committed_date: '2026-11-01T00:00:00Z' } },
        { bad: 1 },
      ]),
    ).toEqual([
      {
        name: 'main',
        default: true,
        protected: false,
        merged: false,
        committedAt: Date.parse('2026-11-01T00:00:00Z'),
        sha: null,
      },
    ]);
    const c = mapCompare({
      commits: [
        { id: SHA('1'), short_id: '1111', title: 'first' },
        { id: SHA('2'), title: 'second', author_name: 'Ana' },
      ],
      diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: DIFF }],
      web_url: 'javascript:alert(1)',
    });
    expect(c?.commits.map((x) => x.title)).toEqual(['second', 'first']);
    expect(c?.commitCount).toBe(2);
    expect(c?.files).toHaveLength(1);
    expect(c?.webUrl).toBeNull();
  });
});

describe('GitlabService review reads', () => {
  let m: ReturnType<typeof mockHttp>;
  let ctx: TestCtx;
  afterEach(async () => {
    await m.close();
    ctx.cleanup();
  });

  const service = () => {
    ctx = makeCtx();
    m = mockHttp({ maxRetries: 0 });
    const repo = { id: 'app-a', gitlab: { projectId: 123, token: TOKEN } } as unknown as RepoConfig;
    return new GitlabService({ repo, host: HOST, http: m.http, store: ctx.app, log: m.log });
  };

  it('paginates MR diffs and keeps the text', async () => {
    const svc = service();
    const pool = m.agent.get(HOST);
    pool
      .intercept({ path: /\/projects\/123\/merge_requests\/7\/diffs\?.*page=1/, method: 'GET' })
      .reply(200, [{ old_path: 'a.ts', new_path: 'a.ts', diff: DIFF }], {
        headers: { ...JSON_HEADERS, 'x-next-page': '2' },
      });
    pool
      .intercept({ path: /\/projects\/123\/merge_requests\/7\/diffs\?.*page=2/, method: 'GET' })
      .reply(
        200,
        [{ old_path: 'b.ts', new_path: 'b.ts', new_file: true, diff: '@@ -0,0 +1 @@\n+x\n' }],
        {
          headers: JSON_HEADERS,
        },
      );
    const r = await svc.getMrDiffs(7);
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => [f.path, f.kind, f.additions])).toEqual([
      ['a.ts', 'modified', 2],
      ['b.ts', 'added', 1],
    ]);
  });

  it('compares two branches with straight=false', async () => {
    const svc = service();
    m.agent
      .get(HOST)
      .intercept({
        path: '/api/v4/projects/123/repository/compare?from=main&to=feature%2Fx&straight=false',
        method: 'GET',
      })
      .reply(
        200,
        {
          commits: [{ id: SHA('1'), title: 'c' }],
          diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: DIFF }],
        },
        {
          headers: JSON_HEADERS,
        },
      );
    const r = await svc.compare('main', 'feature/x');
    expect(r.commitCount).toBe(1);
    expect(r.files[0]?.diff).toBe(DIFF);
  });

  it('posts a diff thread with the position and diff refs', async () => {
    ctx = makeCtx();
    m = mockHttp({ maxRetries: 0 });
    let sent: unknown;
    m.agent
      .get(HOST)
      .intercept({ path: '/api/v4/projects/123/merge_requests/7/discussions', method: 'POST' })
      .reply(
        201,
        (opts) => {
          sent = JSON.parse(String(opts.body));
          return {
            id: 'abc123abc123',
            notes: [
              {
                id: 9,
                body: 'hi',
                created_at: '2026-11-03T00:00:00Z',
                author: { username: 'me' },
                position: { new_path: 'a.ts', old_path: 'a.ts', new_line: 3 },
              },
            ],
          };
        },
        { headers: JSON_HEADERS },
      );
    const api = new GitlabDiscussionsApi(HOST, TOKEN, 123, 'app-a', m.http);
    const d = await api.createDiffThread(
      7,
      { baseSha: SHA('a'), startSha: SHA('b'), headSha: SHA('c') },
      { path: 'a.ts', oldPath: 'a.ts', newLine: 3, oldLine: null },
      'hi',
    );
    expect(sent).toEqual({
      body: 'hi',
      position: {
        position_type: 'text',
        base_sha: SHA('a'),
        start_sha: SHA('b'),
        head_sha: SHA('c'),
        new_path: 'a.ts',
        old_path: 'a.ts',
        new_line: 3,
      },
    });
    expect(d?.position).toEqual({ path: 'a.ts', oldPath: 'a.ts', newLine: 3, oldLine: null });
  });
});

describe('approval capability', () => {
  const mr = (
    o: Partial<{ state: 'opened' | 'merged'; author: string | null; approvedBy: string[] }>,
  ) => ({
    state: 'opened' as const,
    author: 'alice',
    approvedBy: [] as string[],
    ...o,
  });

  it('lets a reviewer approve an open MR of someone else', () => {
    expect(reviewApproval(mr({}), 'approvals_api', 'Bob')).toEqual({
      mode: 'approvals_api',
      approvedByMe: false,
      canApprove: true,
      canRevoke: false,
      reason: null,
    });
  });
  it('offers revoke once approved, except where a note is the approval', () => {
    const a = reviewApproval(mr({ approvedBy: ['bob'] }), 'award_emoji', 'BOB');
    expect(a).toMatchObject({ approvedByMe: true, canApprove: false, canRevoke: true });
    expect(reviewApproval(mr({ approvedBy: ['bob'] }), 'note_keyword', 'bob').canRevoke).toBe(
      false,
    );
  });
  it('never offers approving my own, a closed MR, or without an identity', () => {
    expect(reviewApproval(mr({ author: 'bob' }), 'approvals_api', 'bob')).toMatchObject({
      canApprove: false,
      reason: 'You cannot approve your own MR.',
    });
    expect(reviewApproval(mr({ state: 'merged' }), 'approvals_api', 'bob').canApprove).toBe(false);
    expect(reviewApproval(mr({}), 'approvals_api', undefined).canApprove).toBe(false);
  });
});

describe('GitlabApproveApi', () => {
  let m: ReturnType<typeof mockHttp>;
  afterEach(async () => {
    await m.close();
  });

  it('approves through the endpoint of each approval mode', async () => {
    m = mockHttp({ maxRetries: 0 });
    const sent: { path: string; body: unknown }[] = [];
    const pool = m.agent.get(HOST);
    for (const path of [
      '/api/v4/projects/123/merge_requests/7/approve',
      '/api/v4/projects/123/merge_requests/7/award_emoji',
      '/api/v4/projects/123/merge_requests/7/notes',
    ])
      pool.intercept({ path, method: 'POST' }).reply(
        201,
        (opts) => {
          sent.push({ path, body: JSON.parse(String(opts.body)) });
          return {};
        },
        { headers: JSON_HEADERS },
      );
    const api = new GitlabApproveApi(HOST, TOKEN, 123, m.http);
    await api.approve(7, 'approvals_api');
    await api.approve(7, 'award_emoji');
    await api.approve(7, 'note_keyword');
    expect(sent.map((s) => s.body)).toEqual([{}, { name: 'thumbsup' }, { body: APPROVAL_NOTE }]);
  });

  it('finds my own approval award to remove it', async () => {
    m = mockHttp({ maxRetries: 0 });
    m.agent
      .get(HOST)
      .intercept({ path: /\/projects\/123\/merge_requests\/7\/award_emoji/, method: 'GET' })
      .reply(
        200,
        [
          { id: 1, name: 'thumbsup', user: { username: 'alice' } },
          { id: 2, name: 'tada', user: { username: 'bob' } },
          { id: 3, name: 'thumbsup', user: { username: 'Bob' } },
        ],
        { headers: JSON_HEADERS },
      );
    const api = new GitlabApproveApi(HOST, TOKEN, 123, m.http);
    expect(await api.myAward(7, 'bob')).toBe(3);
  });

  it('turns a 401 on approve into a plain refusal', async () => {
    m = mockHttp({ maxRetries: 0 });
    m.agent
      .get(HOST)
      .intercept({ path: '/api/v4/projects/123/merge_requests/7/approve', method: 'POST' })
      .reply(401, { message: '401 Unauthorized' }, { headers: JSON_HEADERS });
    const api = new GitlabApproveApi(HOST, TOKEN, 123, m.http);
    const err = await api.approve(7, 'approvals_api').catch((e: unknown) => e);
    expect(() => mapApproveError(err)).toThrow(/GitLab refused the approval/);
  });
});
