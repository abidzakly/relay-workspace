import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env';
import { makeCtx, makeDashboard, makeWebhook, type TestCtx } from '../testing/ctx';
import { NonLoopbackBindError, assertLoopbackHost, listenDashboard, listenWebhook } from './listen';
import type { FastifyInstance } from 'fastify';

let ctx: TestCtx;
const apps: FastifyInstance[] = [];
beforeEach(() => void (ctx = makeCtx()));
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  ctx.cleanup();
});

describe('dashboard refuses non-loopback binding', () => {
  it.each([
    '0.0.0.0',
    '::',
    '::1',
    'localhost',
    '192.168.1.10',
    '127.0.0.2',
    '',
    ' 127.0.0.1',
    'example.com',
  ])('assertLoopbackHost(%j) throws', (host) => {
    expect(() => assertLoopbackHost(host)).toThrow(NonLoopbackBindError);
  });
  it('accepts 127.0.0.1', () => expect(() => assertLoopbackHost('127.0.0.1')).not.toThrow());

  it('listenDashboard throws before listening on a non-loopback host', async () => {
    const app = await makeDashboard(ctx);
    apps.push(app);
    await expect(listenDashboard(app, { host: '0.0.0.0', port: 0 })).rejects.toThrow(
      NonLoopbackBindError,
    );
    expect(app.server.listening).toBe(false);
  });

  it('DASHBOARD_HOST in the environment is validated at load time; defaults are 127.0.0.1:3000 / :3001', () => {
    expect(() => loadEnv({ DASHBOARD_HOST: '0.0.0.0' })).toThrow(/DASHBOARD_HOST/);
    expect(() => loadEnv({ DASHBOARD_HOST: 'localhost' })).toThrow(/DASHBOARD_HOST/);
    const e = loadEnv({});
    expect([e.DASHBOARD_HOST, e.DASHBOARD_PORT, e.WEBHOOK_HOST, e.WEBHOOK_PORT]).toEqual([
      '127.0.0.1',
      3000,
      '127.0.0.1',
      3001,
    ]);
    expect(() => loadEnv({ DASHBOARD_PORT: '4000', WEBHOOK_PORT: '4000' })).toThrow(/must differ/);
  });
});

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('two real listeners', () => {
  it('both bind to 127.0.0.1 and serve disjoint surfaces', async () => {
    const dash = await makeDashboard(ctx);
    const hook = await makeWebhook(ctx);
    apps.push(dash, hook);
    await listenDashboard(dash, { host: '127.0.0.1', port: 0 });
    await listenWebhook(hook, { host: '127.0.0.1', port: 0 });
    const dAddr = dash.server.address() as AddressInfo;
    const hAddr = hook.server.address() as AddressInfo;
    expect(dAddr.address).toBe('127.0.0.1');
    expect(hAddr.address).toBe('127.0.0.1');
    expect(dAddr.port).not.toBe(hAddr.port);

    // the test dashboard allowlists Host 127.0.0.1:3000; over real TCP only that Host is served
    expect((await rawGet(dAddr.port, '/api/health', { host: '127.0.0.1:3000' })).status).toBe(200);
    expect(
      (await rawGet(dAddr.port, '/api/health', { host: `127.0.0.1:${dAddr.port}` })).status,
    ).toBe(403);
    expect((await rawGet(dAddr.port, '/api/health', { host: 'evil.example' })).status).toBe(403);
    // webhook listener 404s everything but the webhook route
    for (const p of ['/api/health', '/api/repos', '/api/settings', '/']) {
      expect((await rawGet(hAddr.port, p)).status).toBe(404);
    }
  });
});
