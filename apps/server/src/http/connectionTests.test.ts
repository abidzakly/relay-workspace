import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionTestResultSchema, type ConnectionTestResult } from '@relay/shared';
import {
  CSRF,
  NOTION_TOKEN,
  TOKEN,
  dashHeaders,
  makeCtx,
  makeDashboard,
  repoBody,
  type TestCtx,
} from '../testing/ctx';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';

const H = { ...dashHeaders, ...CSRF };
const NOW = Date.parse('2026-11-01T00:00:00Z');
const FOLDER = 'FolderId12345';
const SA = 'bot@proj.iam.gserviceaccount.com';
const ACCESS = 'ya29.ROUTE-ACCESS-SECRET';

let ctx: TestCtx;
let app: FastifyInstance;
let mock: ReturnType<typeof mockHttp>;
let root: string;
let privatePem: string;

beforeEach(async () => {
  ctx = makeCtx();
  mock = mockHttp({ maxRetries: 0 });
  root = mkdtempSync(join(tmpdir(), 'route-root-'));
  privatePem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  mkdirSync(join(root, 'data/credentials'), { recursive: true });
  const key = join(root, 'data/credentials/drive-service-account.json');
  writeFileSync(
    key,
    JSON.stringify({ type: 'service_account', client_email: SA, private_key: privatePem }),
  );
  chmodSync(key, 0o600);
  app = await makeDashboard(ctx, { http: mock.http, rootDir: root, now: () => NOW });
});
afterEach(async () => {
  await app.close();
  await mock.close();
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = H) =>
  app.inject({
    method: 'POST',
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

function mockGitlab() {
  const p = mock.agent.get('https://gitlab.example.test');
  const ok = (path: string, body: unknown) =>
    p
      .intercept({ path, method: 'GET', headers: { 'private-token': TOKEN } })
      .reply(200, body as object, { headers: JSON_HEADERS })
      .persist();
  ok('/api/v4/user', { username: 'jane.doe' });
  ok('/api/v4/personal_access_tokens/self', { active: true, scopes: ['api'] });
  ok('/api/v4/projects/123', {
    path_with_namespace: 'team/app-a',
    permissions: { project_access: { access_level: 40 } },
  });
  ok('/api/v4/projects/123/merge_requests?state=opened&per_page=1', [{ iid: 1 }]);
  ok('/api/v4/projects/123/merge_requests/1/approvals', { approved_by: [] });
}
const HOOK_URL = 'https://hooks.example.test/webhook/app-a';
const hook = (over: Record<string, unknown> = {}) => ({
  id: 9,
  url: HOOK_URL,
  push_events: true,
  merge_requests_events: true,
  note_events: true,
  pipeline_events: true,
  enable_ssl_verification: true,
  alert_status: 'executable',
  ...over,
});
/** Hook list + GitLab's "test hook" answer (201 = our listener returned 2xx). */
function mockHooks(
  hooks: unknown[] = [hook()],
  test: [number, unknown] = [201, { message: '201 Created' }],
) {
  const p = mock.agent.get('https://gitlab.example.test');
  p.intercept({
    path: '/api/v4/projects/123/hooks?per_page=100&page=1',
    method: 'GET',
    headers: { 'private-token': TOKEN },
  })
    .reply(200, hooks as object, { headers: JSON_HEADERS })
    .persist();
  p.intercept({
    path: '/api/v4/projects/123/hooks/9/test/push_events',
    method: 'POST',
    headers: { 'private-token': TOKEN },
  })
    .reply(test[0], test[1] as object, { headers: JSON_HEADERS })
    .persist();
}
function mockGoogle(folderStatus = 200) {
  mock.agent
    .get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' })
    .reply(200, { access_token: ACCESS }, { headers: JSON_HEADERS })
    .persist();
  mock.agent
    .get('https://www.googleapis.com')
    .intercept({
      path: (p) => p.startsWith(`/drive/v3/files/${FOLDER}?`),
      method: 'GET',
      headers: { authorization: `Bearer ${ACCESS}` },
    })
    .reply(
      folderStatus,
      {
        name: 'QA',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'D',
        capabilities: { canAddChildren: true, canShare: true },
      },
      { headers: JSON_HEADERS },
    )
    .persist();
}
async function setup(globalOver: Record<string, unknown> = {}) {
  ctx.store.saveGlobal(
    {
      gitlab: { host: 'https://gitlab.example.test' },
      publicBaseUrl: 'https://hooks.example.test',
      ...globalOver,
    } as never,
    NOTION_TOKEN,
  );
}
const auditCount = () =>
  (ctx.app.sqlite.prepare('select count(*) c from audit_log').get() as { c: number }).c;
const body = (r: { json(): unknown }) => r.json() as ConnectionTestResult;

describe('POST /api/repos/:id/test', () => {
  it('runs the GitLab + Drive checklist; result is valid, secret-free and unaudited', async () => {
    await setup();
    ctx.store.createRepo({ ...repoBody({ drive: { folderId: FOLDER } }) } as never, TOKEN);
    mockGitlab();
    mockHooks();
    mockGoogle();
    const before = auditCount();
    const r = await post('/api/repos/app-a/test');
    expect(r.statusCode).toBe(200);
    const res = body(r);
    expect(ConnectionTestResultSchema.safeParse(res).success).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.testedAt).toBe(NOW);
    expect(res.checks.map((c) => c.id)).toEqual([
      'gitlab.auth',
      'gitlab.scope',
      'gitlab.project',
      'gitlab.access',
      'gitlab.approvals',
      'webhook.hook',
      'webhook.delivery',
      'drive.key',
      'drive.auth',
      'drive.folder.app-a',
    ]);
    expect(res.summary).toEqual({ pass: 10, warn: 0, fail: 0, skip: 0 });
    for (const secret of [TOKEN, NOTION_TOKEN, ACCESS, 'PRIVATE KEY']) {
      expect(r.body).not.toContain(secret);
      expect(mock.logs.join('\n')).not.toContain(secret);
    }
    expect(auditCount()).toBe(before);
  });

  it('a failing check makes ok=false but is still HTTP 200', async () => {
    await setup();
    ctx.store.createRepo(repoBody() as never, TOKEN);
    mock.agent
      .get('https://gitlab.example.test')
      .intercept({ path: '/api/v4/user', method: 'GET' })
      .reply(401, { message: '401' })
      .persist();
    const r = await post('/api/repos/app-a/test');
    expect(r.statusCode).toBe(200);
    expect(body(r).ok).toBe(false);
    expect(body(r).checks[0]).toMatchObject({ id: 'gitlab.auth', status: 'fail' });
  });

  it('GitLab host not configured -> fail checklist (no request)', async () => {
    ctx.store.createRepo(repoBody() as never, TOKEN);
    const res = body(await post('/api/repos/app-a/test'));
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.id === 'gitlab.auth')?.hint).toMatch(/host/i);
  });

  it('repo without a Drive folder -> warn only', async () => {
    await setup();
    ctx.store.createRepo(repoBody() as never, TOKEN);
    mockGitlab();
    mockHooks();
    mock.agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: ACCESS })
      .persist();
    const res = body(await post('/api/repos/app-a/test'));
    expect(res.ok).toBe(true);
    expect(res.checks.find((c) => c.id === 'drive.folder.app-a')?.status).toBe('warn');
  });

  it('still runs in dry-run (tests are reads)', async () => {
    await setup({ dryRun: true });
    ctx.store.createRepo(repoBody({ drive: { folderId: FOLDER } }) as never, TOKEN);
    mockGitlab();
    mockHooks();
    mockGoogle();
    expect(ctx.store.isDryRun()).toBe(true);
    expect(body(await post('/api/repos/app-a/test')).ok).toBe(true);
  });

  it('webhook token mismatch: GitLab reports HTTP 401 from the hook -> delivery fails with the fix', async () => {
    await setup();
    ctx.store.createRepo(repoBody() as never, TOKEN);
    mockGitlab();
    mockHooks(
      [hook()],
      [
        422,
        { message: 'Hook executed successfully but returned HTTP 401 {"error":"unauthorized"}' },
      ],
    );
    const res = body(await post('/api/repos/app-a/test'));
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.id === 'webhook.hook')?.status).toBe('pass');
    const d = res.checks.find((c) => c.id === 'webhook.delivery')!;
    expect(d.status).toBe('fail');
    expect(d.message).toMatch(/secret token/);
    expect(d.hint).toMatch(/Register/);
  });

  it('no hook on the project -> hook fails, delivery skipped', async () => {
    await setup();
    ctx.store.createRepo(repoBody() as never, TOKEN);
    mockGitlab();
    mockHooks([hook({ id: 3, url: 'https://elsewhere.test/hook' })]);
    const res = body(await post('/api/repos/app-a/test'));
    expect(res.checks.find((c) => c.id === 'webhook.hook')?.status).toBe('fail');
    expect(res.checks.find((c) => c.id === 'webhook.delivery')?.status).toBe('skip');
  });

  it('tunnel down: GitLab reports HTTP 502 -> delivery fails pointing at ngrok', async () => {
    await setup();
    ctx.store.createRepo(repoBody() as never, TOKEN);
    mockGitlab();
    mockHooks([hook()], [422, { message: 'Hook executed successfully but returned HTTP 502' }]);
    const d = body(await post('/api/repos/app-a/test')).checks.find(
      (c) => c.id === 'webhook.delivery',
    )!;
    expect(d.status).toBe('fail');
    expect(d.hint).toMatch(/ngrok/);
  });

  it('unknown repo -> 404; bad id -> 404/400', async () => {
    expect((await post('/api/repos/nope/test')).statusCode).toBe(404);
  });

  it('requires the CSRF header and a good Host', async () => {
    ctx.store.createRepo(repoBody() as never, TOKEN);
    expect((await post('/api/repos/app-a/test', undefined, dashHeaders)).statusCode).toBe(403);
    expect(
      (await post('/api/repos/app-a/test', undefined, { ...CSRF, host: 'evil.example' }))
        .statusCode,
    ).toBe(403);
  });
});

describe('POST /api/settings/test-notion', () => {
  const schema = {
    object: 'data_source',
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title', title: {} },
      Status: {
        id: 's1',
        name: 'Status',
        type: 'status',
        status: {
          options: [
            'Backlog',
            'Next Up',
            'In Progress',
            'Complete',
            'Ready to Test',
            'On Feedback',
            'Issues',
          ].map((n) => ({ id: n, name: n })),
        },
      },
      Type: {
        id: 't',
        name: 'Type',
        type: 'select',
        select: {
          options: ['Bug', 'New Feature', 'Improvement', 'Issues', 'Feedback'].map((n) => ({
            id: n,
            name: n,
          })),
        },
      },
      Assignee: { id: 'a', name: 'Assignee', type: 'people', people: {} },
      Estimation: { id: 'e', name: 'Estimation', type: 'date', date: {} },
      'Branch name': { id: 'b', name: 'Branch name', type: 'rich_text', rich_text: {} },
      'Parent item': { id: 'p', name: 'Parent item', type: 'relation', relation: {} },
    },
  };

  it('returns the checklist plus detection, without the token', async () => {
    ctx.store.saveGlobal({ notion: { dataSourceId: 'ds1' } } as never, NOTION_TOKEN);
    mock.agent
      .get('https://api.notion.com')
      .intercept({
        path: '/v1/data_sources/ds1',
        method: 'GET',
        headers: { authorization: `Bearer ${NOTION_TOKEN}`, 'notion-version': '2025-09-03' },
      })
      .reply(200, schema, { headers: JSON_HEADERS });
    const r = await post('/api/settings/test-notion');
    expect(r.statusCode).toBe(200);
    const res = body(r);
    expect(ConnectionTestResultSchema.safeParse(res).success).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.notion?.statusProp?.type).toBe('status');
    expect(r.body).not.toContain(NOTION_TOKEN);
    expect(mock.logs.join('\n')).not.toContain(NOTION_TOKEN);
  });

  it('nothing configured -> a failing checklist, not an HTTP error', async () => {
    const res = body(await post('/api/settings/test-notion'));
    expect(res.ok).toBe(false);
    expect(res.checks).toHaveLength(1);
  });

  it('requires CSRF', async () => {
    expect((await post('/api/settings/test-notion', undefined, dashHeaders)).statusCode).toBe(403);
  });
});

describe('POST /api/settings/test-drive', () => {
  it('no body: checks the folder of every repo that has one', async () => {
    ctx.store.createRepo(repoBody({ drive: { folderId: FOLDER } }) as never, TOKEN);
    ctx.store.createRepo(repoBody({ id: 'app-b', name: 'B' }) as never, TOKEN);
    mockGoogle();
    const res = body(await post('/api/settings/test-drive'));
    expect(res.ok).toBe(true);
    expect(res.checks.map((c) => c.id)).toEqual(['drive.key', 'drive.auth', 'drive.folder.app-a']);
  });

  it('{ folderId }: checks just that folder', async () => {
    mockGoogle();
    const res = body(await post('/api/settings/test-drive', { folderId: FOLDER }));
    expect(res.checks.map((c) => c.id)).toEqual(['drive.key', 'drive.auth', 'drive.folder']);
    expect(res.ok).toBe(true);
  });

  it('no repo has a folder -> warn', async () => {
    mock.agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: ACCESS });
    const res = body(await post('/api/settings/test-drive'));
    expect(res.ok).toBe(true);
    expect(res.checks.find((c) => c.id === 'drive.folder')?.status).toBe('warn');
  });

  it('missing key file -> failing checklist', async () => {
    await setup({ drive: { serviceAccountKeyPath: 'data/credentials/missing.json' } });
    const res = body(await post('/api/settings/test-drive'));
    expect(res.ok).toBe(false);
    expect(res.checks[0]).toMatchObject({ id: 'drive.key', status: 'fail' });
  });

  it('rejects a malformed folder id and unknown body keys (400)', async () => {
    expect((await post('/api/settings/test-drive', { folderId: '../etc' })).statusCode).toBe(400);
    expect(
      (await post('/api/settings/test-drive', { folderId: FOLDER, extra: 1 })).statusCode,
    ).toBe(400);
  });

  it('requires CSRF', async () => {
    expect((await post('/api/settings/test-drive', undefined, dashHeaders)).statusCode).toBe(403);
  });
});
