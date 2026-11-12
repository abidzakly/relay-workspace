import { describe, expect, it } from 'vitest';
import {
  extractLinks,
  htmlToText,
  isPrivateAddress,
  isPublicHost,
  openLinks,
  type LinkOpenerDeps,
} from './linkContext';

describe('extractLinks', () => {
  it('finds links, drops trailing punctuation and duplicates, and caps at 5', () => {
    const t =
      'see https://a.test/x, and (https://b.test/y). again https://a.test/x https://c.test https://d.test https://e.test https://f.test';
    expect(extractLinks(t)).toEqual([
      'https://a.test/x',
      'https://b.test/y',
      'https://c.test/',
      'https://d.test/',
      'https://e.test/',
    ]);
  });
});

describe('isPrivateAddress / isPublicHost', () => {
  it('flags private ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
  it('refuses names that resolve inside and single-label hosts', async () => {
    expect(await isPublicHost('localhost')).toBe(false);
    expect(await isPublicHost('intranet')).toBe(false);
    expect(await isPublicHost('evil.test', async () => ['10.0.0.5'])).toBe(false);
    expect(await isPublicHost('ok.test', async () => ['93.184.216.34'])).toBe(true);
  });
});

describe('htmlToText', () => {
  it('drops scripts and tags', () => {
    expect(htmlToText('<h1>Hi</h1><script>x()</script><p>a &amp; b</p>')).toBe('Hi\n a & b');
  });
});

describe('openLinks', () => {
  const deps = (over: Partial<LinkOpenerDeps> = {}): LinkOpenerDeps => ({
    http: {
      send: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        text: '<p>Spec</p>',
        json: undefined,
        attempts: 1,
      }),
    } as never,
    gitlabHost: 'https://git.test',
    gitlabItem: async () => ({ title: 'T', description: 'D', state: 'opened' }),
    isPublic: async (h) => h !== 'private.test',
    ...over,
  });

  it('reads a page, a GitLab MR through the API, and refuses a private host', async () => {
    const r = await openLinks(
      ['https://pub.test/a', 'https://git.test/g/p/-/merge_requests/7', 'https://private.test/x'],
      deps(),
    );
    expect(r[0]).toMatchObject({ ok: true, text: 'Spec' });
    expect(r[1]).toMatchObject({ ok: true, text: 'T [opened]\n\nD' });
    expect(r[2]).toMatchObject({ ok: false, text: 'Could not open: not a public address' });
  });

  it('reports a redirect and a failing GitLab item', async () => {
    const r = await openLinks(
      ['https://pub.test/a', 'https://git.test/g/p/-/issues/1'],
      deps({
        http: {
          send: async () => ({ status: 302, headers: {}, text: '', json: undefined, attempts: 1 }),
        } as never,
        gitlabItem: async () => {
          throw new Error('nope');
        },
      }),
    );
    expect(r.every((x) => !x.ok)).toBe(true);
    expect(r[0]!.text).toContain('redirects');
  });
});
