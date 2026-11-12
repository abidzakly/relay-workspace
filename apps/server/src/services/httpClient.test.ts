import { afterEach, describe, expect, it } from 'vitest';
import { HttpNetworkError, parseRetryAfterMs, safeUrl } from './httpClient';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';

const ORIGIN = 'https://api.example.test';
let m: ReturnType<typeof mockHttp>;
afterEach(async () => {
  await m.close();
});

describe('HttpClient', () => {
  it('returns status, headers and parsed JSON', async () => {
    m = mockHttp();
    m.agent
      .get(ORIGIN)
      .intercept({ path: '/ok', method: 'GET' })
      .reply(200, { a: 1 }, { headers: JSON_HEADERS });
    const r = await m.http.send({ url: `${ORIGIN}/ok` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ a: 1 });
    expect(r.attempts).toBe(1);
  });

  it('non-JSON body: json undefined, text kept', async () => {
    m = mockHttp();
    m.agent.get(ORIGIN).intercept({ path: '/t', method: 'GET' }).reply(200, 'hello');
    const r = await m.http.send({ url: `${ORIGIN}/t` });
    expect(r.json).toBeUndefined();
    expect(r.text).toBe('hello');
  });

  it('sends JSON bodies with a content-type and string bodies as-is', async () => {
    m = mockHttp();
    const seen: { ct?: unknown; body?: unknown }[] = [];
    m.agent
      .get(ORIGIN)
      .intercept({ path: '/p', method: 'POST' })
      .reply(200, (o) => {
        seen.push({ ct: (o.headers as Record<string, unknown>)['content-type'], body: o.body });
        return '{}';
      })
      .times(2);
    await m.http.send({ method: 'POST', url: `${ORIGIN}/p`, body: { x: 1 } });
    await m.http.send({
      method: 'POST',
      url: `${ORIGIN}/p`,
      body: 'a=b',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(seen[0]).toEqual({ ct: 'application/json', body: '{"x":1}' });
    expect(seen[1]).toEqual({ ct: 'application/x-www-form-urlencoded', body: 'a=b' });
  });

  it('retries 429 then succeeds, honouring Retry-After', async () => {
    m = mockHttp();
    const pool = m.agent.get(ORIGIN);
    pool
      .intercept({ path: '/r', method: 'GET' })
      .reply(429, '{}', { headers: { 'retry-after': '2' } });
    pool
      .intercept({ path: '/r', method: 'GET' })
      .reply(200, { ok: true }, { headers: JSON_HEADERS });
    const r = await m.http.send({ url: `${ORIGIN}/r` });
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(2);
    expect(m.sleeps).toEqual([2000]);
  });

  it('retries 5xx with exponential backoff, then returns the last response', async () => {
    m = mockHttp({ backoffBaseMs: 100, maxRetries: 2 });
    m.agent.get(ORIGIN).intercept({ path: '/e', method: 'GET' }).reply(503, '{}').times(3);
    const r = await m.http.send({ url: `${ORIGIN}/e` });
    expect(r.status).toBe(503);
    expect(r.attempts).toBe(3);
    expect(m.sleeps).toEqual([100, 200]);
  });

  it('does not retry other 4xx', async () => {
    m = mockHttp();
    m.agent.get(ORIGIN).intercept({ path: '/n', method: 'GET' }).reply(404, '{}');
    const r = await m.http.send({ url: `${ORIGIN}/n` });
    expect(r.status).toBe(404);
    expect(r.attempts).toBe(1);
    expect(m.sleeps).toEqual([]);
  });

  it('caps Retry-After', () => {
    expect(parseRetryAfterMs('3600')).toBe(10_000);
    expect(parseRetryAfterMs('1')).toBe(1000);
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('times out slow responses (and retries them)', async () => {
    m = mockHttp({ timeoutMs: 20, maxRetries: 1 });
    m.agent
      .get(ORIGIN)
      .intercept({ path: '/slow', method: 'GET' })
      .reply(200, '{}')
      .delay(300)
      .times(2);
    const err = await m.http.send({ url: `${ORIGIN}/slow` }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect((err as HttpNetworkError).kind).toBe('timeout');
    expect(m.sleeps).toHaveLength(1);
  });

  it('transport errors become HttpNetworkError without the underlying text', async () => {
    m = mockHttp({ maxRetries: 0 });
    m.agent
      .get(ORIGIN)
      .intercept({ path: '/x', method: 'GET' })
      .replyWithError(new Error('secret-detail-ghp_123'));
    const err = (await m.http
      .send({ url: `${ORIGIN}/x?token=abc` })
      .catch((e: unknown) => e)) as HttpNetworkError;
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect(err.kind).toBe('network');
    expect(err.message).toBe('network calling api.example.test');
    expect(JSON.stringify(err)).not.toContain('secret-detail');
  });

  it('does not follow redirects (auth headers are never replayed elsewhere)', async () => {
    m = mockHttp();
    m.agent
      .get(ORIGIN)
      .intercept({ path: '/redir', method: 'GET' })
      .reply(302, '', { headers: { location: 'https://evil.test/' } });
    const r = await m.http.send({
      url: `${ORIGIN}/redir`,
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(r.status).toBe(302);
  });

  it('rejects non-http(s) and malformed URLs before any I/O', async () => {
    m = mockHttp();
    for (const url of ['file:///etc/passwd', 'not a url', 'ftp://x.test/']) {
      const err = (await m.http.send({ url }).catch((e: unknown) => e)) as HttpNetworkError;
      expect(err).toBeInstanceOf(HttpNetworkError);
      expect(err.kind).toBe('invalid_url');
    }
  });

  it('refuses oversized bodies', async () => {
    m = mockHttp({ maxRetries: 0 });
    m.agent
      .get(ORIGIN)
      .intercept({ path: '/big', method: 'GET' })
      .reply(200, 'x'.repeat(5 * 1024 * 1024 + 10));
    const err = (await m.http
      .send({ url: `${ORIGIN}/big` })
      .catch((e: unknown) => e)) as HttpNetworkError;
    expect(err.kind).toBe('too_large');
  });

  it('logs method/host/path/status only: no headers, query or body', async () => {
    m = mockHttp();
    m.agent
      .get(ORIGIN)
      .intercept({ path: /^\/l/, method: 'POST' })
      .reply(200, '{"access_token":"TOPSECRET-RESP"}');
    await m.http.send({
      method: 'POST',
      url: `${ORIGIN}/l?private_token=QUERYSECRET`,
      headers: { authorization: 'Bearer HEADERSECRET', 'private-token': 'PATSECRET' },
      body: { assertion: 'BODYSECRET' },
    });
    const all = m.logs.join('\n');
    expect(all).toContain('outbound http');
    expect(all).toContain('api.example.test');
    for (const s of ['HEADERSECRET', 'PATSECRET', 'QUERYSECRET', 'BODYSECRET', 'TOPSECRET-RESP']) {
      expect(all).not.toContain(s);
    }
  });

  it('safeUrl strips userinfo, query, fragment', () => {
    expect(safeUrl('https://u:p@h.test:8443/a/b?x=1#f')).toEqual({
      host: 'h.test:8443',
      path: '/a/b',
    });
    expect(safeUrl('nope')).toEqual({ host: 'invalid', path: '' });
  });
});
