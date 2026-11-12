import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@relay/shared';
import { CSP } from './security';
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

let ctx: TestCtx;
let app: FastifyInstance;
beforeEach(async () => {
  ctx = makeCtx();
  app = await makeDashboard(ctx);
});
afterEach(async () => {
  await app.close();
  ctx.cleanup();
});

const H = { ...dashHeaders, ...CSRF };
const send = (
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = H,
) =>
  app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe('browser protections', () => {
  it('sends CSP (no inline script, no remote origins) and hardening headers', async () => {
    const r = await send('GET', '/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('CSP also covers error responses', async () => {
    const r = await send('GET', '/api/nope');
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-security-policy']).toBe(CSP);
  });

  it.each([
    ['POST', '/api/repos', repoBody()],
    ['PUT', '/api/settings', {}],
    ['PUT', '/api/repos/app-a', repoBody()],
    ['DELETE', '/api/repos/app-a', undefined],
  ] as const)(
    '%s %s without the CSRF header -> 403 and nothing is written',
    async (m, url, body) => {
      const r = await send(m, url, body, dashHeaders);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'csrf', message: 'csrf' });
      expect(ctx.store.listRepos()).toHaveLength(0);
      expect(ctx.audit.get(1)).toBeUndefined();
    },
  );

  it('a wrong CSRF header value is rejected; GET needs no header', async () => {
    const bad = await send('POST', '/api/repos', repoBody(), {
      ...dashHeaders,
      'x-requested-with': 'XMLHttpRequest',
    });
    expect(bad.statusCode).toBe(403);
    expect((await send('GET', '/api/repos', undefined, dashHeaders)).statusCode).toBe(200);
  });

  it('a cross-site Origin is rejected even with the header; a local Origin is accepted', async () => {
    const evil = await send('POST', '/api/repos', repoBody(), {
      ...H,
      origin: 'https://evil.example',
    });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error).toBe('bad_origin');
    const ok = await send('POST', '/api/repos', repoBody(), {
      ...H,
      origin: 'http://127.0.0.1:3000',
    });
    expect(ok.statusCode).toBe(201);
  });

  it('rejects unexpected Host headers (DNS rebinding) on every route', async () => {
    for (const host of [
      'evil.example',
      'evil.example:3000',
      '192.168.1.5:3000',
      '127.0.0.1:9999',
    ]) {
      const r = await send('GET', '/api/settings', undefined, { host });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('bad_host');
    }
    expect(
      (await send('GET', '/api/health', undefined, { host: 'localhost:3000' })).statusCode,
    ).toBe(200);
  });

  it('serves nothing under /webhook (that lives only on :3001)', async () => {
    const r = await send('POST', '/webhook/app-a', {}, H);
    expect(r.statusCode).toBe(404);
  });
});

describe('validation + error handler', () => {
  it('400 with path/message issues, no echo of submitted values', async () => {
    const r = await send(
      'POST',
      '/api/repos',
      repoBody({ id: 'Bad Id', cloneUrl: '--upload-pack=evil' }),
    );
    expect(r.statusCode).toBe(400);
    const j = r.json();
    expect(j.error).toBe('validation');
    expect(j.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['id', 'cloneUrl']),
    );
    expect(r.body).not.toContain('upload-pack');
  });

  it('create requires a real token (missing or mask -> 400)', async () => {
    const b = repoBody();
    expect((await send('POST', '/api/repos', { ...b, gitlab: { projectId: 1 } })).statusCode).toBe(
      400,
    );
    expect(
      (await send('POST', '/api/repos', { ...b, gitlab: { projectId: 1, token: SECRET_MASK } }))
        .statusCode,
    ).toBe(400);
  });

  it('malformed JSON -> 400; unknown route -> JSON 404; internal errors -> generic 500', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/repos',
      headers: { ...H, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect((await send('GET', '/api/missing')).json()).toEqual({ error: 'not_found' });

    ctx.app.sqlite.exec('drop table repos');
    const r = await send('GET', '/api/repos');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'internal' });
    expect(r.body).not.toMatch(/sqlite|repos/i);
  });
});

describe('repos API', () => {
  it('CRUD round trip; secrets are never returned (response, list, get, update)', async () => {
    const created = await send('POST', '/api/repos', repoBody());
    expect(created.statusCode).toBe(201);
    expect(created.json().repo.gitlab).toEqual({
      projectId: 123,
      tokenSet: true,
      webhookSecretSet: true,
    });

    const secret = ctx.store.getWebhookSecret('app-a')!;
    const bodies: string[] = [created.body];
    bodies.push(
      (await send('GET', '/api/repos')).body,
      (await send('GET', '/api/repos/app-a')).body,
    );
    expect((await send('GET', '/api/repos/nope')).statusCode).toBe(404);

    const upd = await send(
      'PUT',
      '/api/repos/app-a',
      repoBody({ name: 'Renamed', gitlab: { projectId: 123, token: SECRET_MASK } }),
    );
    expect(upd.statusCode).toBe(200);
    expect(upd.json().repo.name).toBe('Renamed');
    bodies.push(upd.body);
    for (const b of bodies) {
      expect(b).not.toContain(TOKEN);
      expect(b).not.toContain(secret);
      expect(b).not.toMatch(/"token"|"webhookSecret"/);
    }
    expect(ctx.store.getRepo('app-a')!.gitlab.token).toBe(TOKEN); // mask = unchanged

    expect(
      (await send('PUT', '/api/repos/app-a', repoBody({ gitlab: { projectId: 123 } }))).statusCode,
    ).toBe(200); // omitted = unchanged
    expect(ctx.store.getRepo('app-a')!.gitlab.token).toBe(TOKEN);

    await send(
      'PUT',
      '/api/repos/app-a',
      repoBody({ gitlab: { projectId: 123, token: 'glpat-ROTATED' } }),
    );
    expect(ctx.store.getRepo('app-a')!.gitlab.token).toBe('glpat-ROTATED');

    expect((await send('DELETE', '/api/repos/app-a')).statusCode).toBe(204);
    expect((await send('DELETE', '/api/repos/app-a')).statusCode).toBe(404);
    expect(ctx.store.listRepos()).toEqual([]);
  });

  it('409 on duplicate id; 400 when the body id differs from the URL; 404 on unknown update', async () => {
    await send('POST', '/api/repos', repoBody());
    expect((await send('POST', '/api/repos', repoBody())).statusCode).toBe(409);
    expect((await send('PUT', '/api/repos/app-a', repoBody({ id: 'app-b' }))).statusCode).toBe(400);
    expect((await send('PUT', '/api/repos/ghost', repoBody({ id: 'ghost' }))).statusCode).toBe(404);
  });

  it('a client-supplied webhookSecret is ignored (server generates it)', async () => {
    await send(
      'POST',
      '/api/repos',
      repoBody({ gitlab: { projectId: 1, token: TOKEN, webhookSecret: 'client-chosen' } }),
    );
    expect(ctx.store.getWebhookSecret('app-a')).not.toBe('client-chosen');
  });

  it('writes audit rows with before/after that contain no secrets', async () => {
    await send('POST', '/api/repos', repoBody());
    await send(
      'PUT',
      '/api/repos/app-a',
      repoBody({ name: 'N2', gitlab: { projectId: 123, token: 'glpat-ROTATED' } }),
    );
    await send('DELETE', '/api/repos/app-a');
    const rows = [1, 2, 3].map((i) => ctx.audit.get(i)!);
    expect(rows.map((r) => r.action)).toEqual(['repo.create', 'repo.update', 'repo.delete']);
    expect(rows[1]).toMatchObject({
      actor: 'user',
      targetId: 'app-a',
      before: { name: 'App A' },
      after: { name: 'N2', tokenChanged: true },
    });
    const all = JSON.stringify(rows);
    for (const s of [TOKEN, 'glpat-ROTATED']) expect(all).not.toContain(s);
  });
});

describe('settings API', () => {
  it('GET returns defaults; PUT saves, masks the notion token, mask/omitted keep it, null clears', async () => {
    const g = await send('GET', '/api/settings');
    expect(g.json().settings).toMatchObject({ dryRun: false, notion: { tokenSet: false } });

    const put = await send('PUT', '/api/settings', {
      dryRun: true,
      notion: { token: NOTION_TOKEN, dataSourceId: 'ds1' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings).toMatchObject({
      dryRun: true,
      notion: { tokenSet: true, dataSourceId: 'ds1' },
    });
    expect(put.body).not.toContain(NOTION_TOKEN);
    expect((await send('GET', '/api/settings')).body).not.toContain(NOTION_TOKEN);
    expect(ctx.store.isDryRun()).toBe(true);

    await send('PUT', '/api/settings', { dryRun: true, notion: { token: SECRET_MASK } });
    expect(ctx.store.getGlobal().notion.token).toBe(NOTION_TOKEN);
    await send('PUT', '/api/settings', { dryRun: true, notion: {} });
    expect(ctx.store.getGlobal().notion.token).toBe(NOTION_TOKEN);
    const cleared = await send('PUT', '/api/settings', { notion: { token: null } });
    expect(cleared.json().settings.notion.tokenSet).toBe(false);
  });

  it('validates (bad URL / statuses) with 400 and changes nothing', async () => {
    const r = await send('PUT', '/api/settings', { publicBaseUrl: 'javascript:alert(1)' });
    expect(r.statusCode).toBe(400);
    const r2 = await send('PUT', '/api/settings', { notion: { readyStatus: 'Nope' } });
    expect(r2.statusCode).toBe(400);
    expect(ctx.audit.get(1)).toBeUndefined();
  });

  it('audits settings changes (dryRun toggle gets its own action) with no token in the log', async () => {
    await send('PUT', '/api/settings', { notion: { token: NOTION_TOKEN } });
    await send('PUT', '/api/settings', { dryRun: true });
    const [a, b] = [ctx.audit.get(1)!, ctx.audit.get(2)!];
    expect(a.action).toBe('settings.update');
    expect(a.after).toMatchObject({ notionTokenChanged: true });
    expect(b.action).toBe('settings.dryRun');
    expect(JSON.stringify([a, b])).not.toContain(NOTION_TOKEN);
  });
});

describe('logging never contains secrets', () => {
  it('after a full create/update/settings flow, no secret is in any log line', async () => {
    await send('PUT', '/api/settings', { notion: { token: NOTION_TOKEN } });
    await send('POST', '/api/repos', repoBody());
    const secret = ctx.store.getWebhookSecret('app-a')!;
    await send('POST', '/api/repos', repoBody({ id: 'Bad' })); // validation error path
    const logs = ctx.logLines.join('');
    for (const s of [TOKEN, NOTION_TOKEN, secret]) expect(logs).not.toContain(s);
  });
});

describe('dashboard behind a local TLS proxy (DASHBOARD_TLS_HOSTS)', () => {
  const TS = 'mac.tail5b903e.ts.net';
  let tlsApp: FastifyInstance;
  beforeEach(async () => {
    tlsApp = await makeDashboard(ctx, { tlsHosts: [TS], tlsUsers: ['me@example.com'] });
  });
  afterEach(async () => {
    await tlsApp.close();
  });

  const ME = { 'tailscale-user-login': 'Me@example.com' };

  it('accepts the TLS host over https only, and nothing else new', async () => {
    for (const host of [TS, `${TS}:443`]) {
      const r = await tlsApp.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host, ...ME },
      });
      expect(r.statusCode).toBe(200);
    }
    for (const host of [`${TS}:3000`, `evil.${TS}`, 'evil.example']) {
      const r = await tlsApp.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(r.json().error).toBe('bad_host');
    }
    const post = (origin: string) =>
      tlsApp.inject({
        method: 'POST',
        url: '/api/repos',
        headers: { ...CSRF, ...ME, host: TS, origin },
        payload: repoBody(),
      });
    expect((await post(`http://${TS}`)).json().error).toBe('bad_origin');
    expect((await post(`https://${TS}`)).statusCode).toBe(201);
  });

  it('refuses other tailnet users, and requests without a Tailscale login', async () => {
    for (const headers of [
      { host: TS },
      { host: TS, 'tailscale-user-login': 'someone@else.com' },
    ]) {
      const r = await tlsApp.inject({ method: 'GET', url: '/api/health', headers });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('bad_user');
    }
    const local = await tlsApp.inject({ method: 'GET', url: '/api/health', headers: dashHeaders });
    expect(local.statusCode).toBe(200);
  });
});
