import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN, makeCtx, makeWebhook, repoBody, type TestCtx } from '../testing/ctx';
import { RepoConfigStoredSchema } from '@relay/shared';
import { safeEqual } from './webhookApp';

let ctx: TestCtx;
let app: FastifyInstance | undefined; // undefined in tests that never boot
let secret: string;
async function boot(over: Parameters<typeof makeWebhook>[1] = {}) {
  app = await makeWebhook(ctx, over);
  return app;
}
beforeEach(() => {
  ctx = makeCtx();
  ctx.store.createRepo(RepoConfigStoredSchema.parse(repoBody()), TOKEN);
  secret = ctx.store.getWebhookSecret('app-a')!;
});
afterEach(async () => {
  await app?.close();
  ctx.cleanup();
});

const A = () => app as FastifyInstance;
const post = (
  url: string,
  headers: Record<string, string> = {},
  payload: unknown = { object_kind: 'push' },
) => A().inject({ method: 'POST', url, headers, payload: payload as object });

describe('safeEqual', () => {
  it('compares equal/unequal/different-length strings without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('only POST /webhook/:repoId exists', () => {
  it('404s every other route and method', async () => {
    await boot();
    const cases: [string, string][] = [
      ['GET', '/'],
      ['GET', '/api/repos'],
      ['GET', '/api/settings'],
      ['POST', '/api/repos'],
      ['PUT', '/api/settings'],
      ['GET', '/api/health'],
      ['GET', '/webhook/app-a'],
      ['PUT', '/webhook/app-a'],
      ['DELETE', '/webhook/app-a'],
      ['PATCH', '/webhook/app-a'],
      ['OPTIONS', '/webhook/app-a'],
      ['HEAD', '/webhook/app-a'],
      ['POST', '/webhook'],
      ['POST', '/webhook/'],
      ['POST', '/webhook/UPPER'],
      ['POST', '/webhook/-lead'],
      ['POST', '/webhook/a.b'],
      ['POST', `/webhook/${'a'.repeat(64)}`],
      ['POST', '/webhook/app-a/'],
      ['POST', '/webhook/app-a/extra'],
      ['POST', '/WEBHOOK/app-a'],
      ['GET', '/apks/x.apk'],
      ['GET', '/events'],
    ];
    for (const [method, url] of cases) {
      const r = await A().inject({
        method: method as 'GET',
        url,
        headers: { 'x-gitlab-token': secret },
      });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('exposes exactly one route', async () => {
    await boot();
    await A().ready();
    const routes = A().printRoutes({ commonPrefix: false, includeMeta: false });
    expect(routes).toContain('/webhook/:repoId');
    expect(routes).toContain('POST');
    expect(routes.split('\n').filter((l) => l.trim()).length).toBe(1);
    expect(routes).not.toContain('GET');
  });
});

describe('token check', () => {
  it('200 fast with the right token', async () => {
    await boot();
    const r = await post('/webhook/app-a', { 'x-gitlab-token': secret });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('401 for missing, wrong, truncated, extended, and empty tokens', async () => {
    await boot();
    for (const h of <Record<string, string>[]>[
      {},
      { 'x-gitlab-token': 'nope' },
      { 'x-gitlab-token': secret.slice(0, -1) },
      { 'x-gitlab-token': `${secret}x` },
      { 'x-gitlab-token': '' },
    ]) {
      const r = await post('/webhook/app-a', h);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it("repo A's token does not open repo B; unknown ids look identical to a bad token; malformed ids are 404", async () => {
    ctx.store.createRepo(RepoConfigStoredSchema.parse(repoBody({ id: 'app-b', name: 'B' })), TOKEN);
    await boot();
    const bad = await post('/webhook/app-b', { 'x-gitlab-token': secret });
    const unknown = await post('/webhook/ghost', { 'x-gitlab-token': secret });
    const malformed = await post('/webhook/..%2Fetc', { 'x-gitlab-token': secret });
    expect(malformed.statusCode).toBe(404);
    const dummy = await post('/webhook/ghost', { 'x-gitlab-token': 'x'.repeat(43) });
    for (const r of [bad, unknown, dummy]) {
      expect(r.statusCode).toBe(401);
      expect(r.body).toBe(bad.body);
    }
  });

  it('rejects before the body is parsed (garbage body + bad token -> 401, not 400)', async () => {
    await boot();
    const r = await A().inject({
      method: 'POST',
      url: '/webhook/app-a',
      headers: { 'content-type': 'application/json', 'x-gitlab-token': 'bad' },
      payload: '{not json',
    });
    expect(r.statusCode).toBe(401);
  });

  it('a deleted repo stops authenticating immediately', async () => {
    await boot();
    ctx.store.deleteRepo('app-a');
    expect((await post('/webhook/app-a', { 'x-gitlab-token': secret })).statusCode).toBe(401);
  });
});

describe('limits', () => {
  it('413 when the body exceeds the limit (authenticated request)', async () => {
    await boot({ bodyLimit: 1024 });
    const big = { x: 'a'.repeat(5000) };
    const r = await post('/webhook/app-a', { 'x-gitlab-token': secret }, big);
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBeTruthy();
  });

  it('429 after the rate limit is exceeded', async () => {
    await boot({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await post('/webhook/app-a', { 'x-gitlab-token': 'bad' })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    const r = await post('/webhook/app-a', { 'x-gitlab-token': 'bad' });
    expect(r.json()).toEqual({ error: 'rate_limited' });
  });

  it('non-JSON content type -> 415 (after auth)', async () => {
    await boot();
    const r = await A().inject({
      method: 'POST',
      url: '/webhook/app-a',
      headers: { 'content-type': 'text/plain', 'x-gitlab-token': secret },
      payload: 'hello',
    });
    expect(r.statusCode).toBe(415);
  });
});

describe('logging', () => {
  it('never logs the presented or the stored token', async () => {
    await boot();
    await post('/webhook/app-a', { 'x-gitlab-token': secret });
    await post('/webhook/app-a', { 'x-gitlab-token': 'presented-BAD-token-123' });
    const logs = ctx.logLines.join('');
    expect(logs).toContain('webhook rejected');
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain('presented-BAD-token-123');
  });
});
