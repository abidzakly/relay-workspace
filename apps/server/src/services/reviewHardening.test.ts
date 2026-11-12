import { afterEach, describe, expect, it } from 'vitest';
import type { DiffFile } from '@relay/shared';
import { mapReviewDiscussions } from './gitlabReview';
import { MrActions, MrActionError } from './mrActions';
import { upsertMrSummaries } from './mrStore';
import { diffHunks, threadCode } from './threadCode';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';
import { makeCtx, NOTION_TOKEN, repoBody, TOKEN, type TestCtx } from '../testing/ctx';

const HOST = 'https://gitlab.example.test';
const SHA = (c: string) => c.repeat(40);
const DIFF = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n';

describe('thread code', () => {
  it('numbers diff lines per hunk', () => {
    const [h] = diffHunks(DIFF);
    expect(h!.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['ctx', 3, 4],
    ]);
  });
  it('cuts the commented line with a short lead-in from its hunk', () => {
    const files = [{ path: 'a.ts', oldPath: null, diff: DIFF }] as unknown as DiffFile[];
    const out = threadCode({ path: 'a.ts', oldPath: 'a.ts', newLine: 3, oldLine: null }, files);
    expect(out.lines.map((l) => l.text)).toEqual(['a', 'b', 'B', 'C']);
  });
  it('shows nothing when the line is not in the diff', () => {
    const files = [{ path: 'a.ts', oldPath: null, diff: DIFF }] as unknown as DiffFile[];
    expect(
      threadCode({ path: 'a.ts', oldPath: 'a.ts', newLine: 99, oldLine: null }, files).lines,
    ).toEqual([]);
  });
});

describe('thread positions', () => {
  it('keep the head commit they sit on, so the reviewer can tell outdated ones', () => {
    const [d] = mapReviewDiscussions([
      {
        id: 'd1',
        notes: [
          {
            id: 1,
            body: 'hm',
            author: { username: 'ana' },
            created_at: '2026-11-01T00:00:00Z',
            resolvable: true,
            resolved: false,
            position: {
              position_type: 'text',
              new_path: 'a.ts',
              old_path: 'a.ts',
              new_line: 3,
              old_line: null,
              head_sha: SHA('c'),
            },
          },
        ],
      },
    ])!;
    expect(d!.position).toMatchObject({ newLine: 3, headSha: SHA('c') });
  });
});

describe('MrActions.comment on a moved MR', () => {
  let ctx: TestCtx;
  let m: ReturnType<typeof mockHttp>;
  afterEach(async () => {
    await m.close();
    ctx.cleanup();
  });

  function setup() {
    ctx = makeCtx();
    m = mockHttp({ maxRetries: 0 });
    ctx.store.saveGlobal({ gitlab: { host: HOST }, dryRun: false } as never, NOTION_TOKEN);
    ctx.store.createRepo(repoBody() as never, TOKEN);
    upsertMrSummaries(
      ctx.app,
      'app-a',
      [
        {
          iid: 7,
          gitlabId: 70,
          title: 'MR',
          state: 'opened',
          draft: false,
          hasConflicts: false,
          mergeStatus: null,
          sourceBranch: 'feat',
          targetBranch: 'main',
          author: 'ana',
          assignees: [],
          reviewers: [],
          webUrl: null,
          createdAt: 1,
          updatedAt: 1,
          mergedAt: null,
          descriptionNotionId: null,
          headPipeline: null,
        },
      ],
      1,
    );
    m.agent
      .get(HOST)
      .intercept({ path: '/api/v4/projects/123/merge_requests/7', method: 'GET' })
      .reply(
        200,
        { diff_refs: { base_sha: SHA('a'), start_sha: SHA('a'), head_sha: SHA('d') } },
        { headers: JSON_HEADERS },
      );
    return new MrActions({
      config: ctx.store,
      audit: ctx.audit,
      store: ctx.app,
      http: m.http,
      log: ctx.log,
    });
  }

  it('refuses with 409 diff_changed when the reviewer read an older version, writing nothing', async () => {
    const actions = setup();
    const err = await actions
      .comment('app-a', 7, {
        position: { path: 'a.ts', oldPath: 'a.ts', newLine: 2, oldLine: null },
        body: 'nit',
        headSha: SHA('c'),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MrActionError);
    expect(err).toMatchObject({ status: 409, code: 'diff_changed' });
    const audits = ctx.app.sqlite.prepare('select count(*) c from audit_log').get() as {
      c: number;
    };
    expect(audits.c).toBe(0);
  });
});

describe('GET /api/review/:repo/compare', () => {
  it('refuses to compare a branch with itself (400 same_branch)', async () => {
    const { makeDashboard, dashHeaders } = await import('../testing/ctx');
    const ctx = makeCtx();
    const app = await makeDashboard(ctx, { cache: ctx.app });
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/review/app-a/compare?from=main&to=main',
        headers: dashHeaders,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: 'same_branch' });
    } finally {
      await app.close();
      ctx.cleanup();
    }
  });
});
