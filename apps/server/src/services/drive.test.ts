import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Check } from '@relay/shared';
import {
  GOOGLE_TOKEN_URL,
  loadServiceAccountKey,
  resolveKeyPath,
  signAssertion,
  testDrive,
  type DriveFolderTarget,
} from './drive';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';

const SA = 'bot@proj.iam.gserviceaccount.com';
const NOW = Date.parse('2026-11-01T00:00:00Z');
const FOLDER = 'FolderId12345';
const ACCESS = 'ya29.SUPERSECRET-ACCESS-TOKEN';

let dir: string;
let privatePem: string;
let publicPem: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'drive-test-'));
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privatePem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  publicPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function keyFile(name: string, content: unknown, mode = 0o600): string {
  const f = join(dir, name);
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content), { mode });
  chmodSync(f, mode);
  return f;
}
const goodKey = () => ({
  type: 'service_account',
  client_email: SA,
  private_key: privatePem,
  token_uri: 'https://evil.example/token',
});

let m: ReturnType<typeof mockHttp> | undefined;
afterEach(async () => {
  await m?.close();
  m = undefined;
});

interface Scn {
  token?: [number, unknown] | 'neterr';
  folder?: [number, unknown] | 'neterr';
}
const folderBody = (over: Record<string, unknown> = {}) => ({
  id: FOLDER,
  name: 'QA Builds',
  mimeType: 'application/vnd.google-apps.folder',
  driveId: '0ASharedDrive',
  capabilities: { canAddChildren: true, canShare: true },
  ...over,
});

async function run(
  keyPath: string,
  s: Scn = {},
  folders: DriveFolderTarget[] = [{ repoId: 'app-a', folderId: FOLDER }],
  anyoneWithLink = true,
): Promise<{ checks: Check[]; tokenRequests: string[] }> {
  const mk = mockHttp({ maxRetries: 0 });
  m = mk;
  const tokenRequests: string[] = [];
  const t = mk.agent
    .get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' });
  const tr = s.token ?? [200, { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' }];
  if (tr === 'neterr') t.replyWithError(new Error('boom')).persist();
  else
    t.reply(
      tr[0],
      (o) => {
        tokenRequests.push(String(o.body));
        return JSON.stringify(tr[1]);
      },
      { headers: JSON_HEADERS },
    ).persist();
  const f = mk.agent.get('https://www.googleapis.com').intercept({
    path: (p) => p.startsWith(`/drive/v3/files/${FOLDER}?`) && p.includes('supportsAllDrives=true'),
    method: 'GET',
    headers: { authorization: `Bearer ${ACCESS}` },
  });
  const fr = s.folder ?? [200, folderBody()];
  if (fr === 'neterr') f.replyWithError(new Error('boom')).persist();
  else f.reply(fr[0], fr[1] as object, { headers: JSON_HEADERS }).persist();
  const checks = await testDrive({
    keyPath,
    baseDir: dir,
    anyoneWithLink,
    folders,
    http: m.http,
    now: NOW,
  });
  return { checks, tokenRequests };
}
const by = (cs: Check[], id: string) => cs.find((c) => c.id === id)!;
const st = (cs: Check[]) => Object.fromEntries(cs.map((c) => [c.id, c.status]));

describe('signAssertion', () => {
  it('produces a verifiable RS256 JWT with the expected claims', () => {
    const jwt = signAssertion({ clientEmail: SA, privateKey: privatePem }, NOW);
    const [h, c, sig] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toEqual({
      iss: SA,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: GOOGLE_TOKEN_URL,
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(publicPem, Buffer.from(sig, 'base64url')),
    ).toBe(true);
  });
});

describe('loadServiceAccountKey / resolveKeyPath', () => {
  it('resolves relative paths against the base dir, keeps absolute ones', () => {
    expect(resolveKeyPath('data/k.json', '/root')).toBe('/root/data/k.json');
    expect(resolveKeyPath('/abs/k.json', '/root')).toBe('/abs/k.json');
  });
  it.each([
    ['missing file', () => join(dir, 'nope.json'), 'missing'],
    ['a directory', () => dir, 'missing'],
    ['invalid json', keyFileLazy('bad.json', '{nope'), 'invalid_json'],
    ['wrong type', keyFileLazy('oauth.json', { type: 'authorized_user' }), 'not_service_account'],
    [
      'no email',
      keyFileLazy('noemail.json', { type: 'service_account', private_key: 'PRIVATE KEY' }),
      'missing_fields',
    ],
    [
      'no private key',
      keyFileLazy('nokey.json', { type: 'service_account', client_email: SA }),
      'missing_fields',
    ],
    [
      'junk private key',
      keyFileLazy('junk.json', { type: 'service_account', client_email: SA, private_key: 'hello' }),
      'missing_fields',
    ],
    ['huge', keyFileLazy('huge.json', 'x'.repeat(70_000)), 'too_large'],
  ])('%s -> %s', (_n, file, reason) => {
    expect(loadServiceAccountKey(file())).toEqual({ ok: false, reason });
  });
});
function keyFileLazy(name: string, content: unknown) {
  return () => {
    mkdirSync(dir, { recursive: true });
    return keyFile(name, content);
  };
}

describe('testDrive', () => {
  it('healthy: key, sign-in and folder pass; the JWT is sent form-encoded; the file token_uri is ignored', async () => {
    const f = keyFile('good.json', goodKey());
    const { checks, tokenRequests } = await run(f);
    expect(st(checks)).toEqual({
      'drive.key': 'pass',
      'drive.auth': 'pass',
      'drive.folder.app-a': 'pass',
    });
    expect(by(checks, 'drive.key').message).toContain(SA);
    const form = new URLSearchParams(tokenRequests[0]);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')!.split('.')).toHaveLength(3);
  });

  it('never reveals the private key or tokens in results or logs', async () => {
    const f = keyFile('good2.json', goodKey());
    const { checks } = await run(f);
    const all = JSON.stringify(checks) + m!.logs.join('\n');
    expect(all).not.toContain('PRIVATE KEY');
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain(privatePem.slice(40, 80));
  });

  it('relative key path resolves against baseDir', async () => {
    keyFile('rel.json', goodKey());
    const { checks } = await run('rel.json');
    expect(by(checks, 'drive.key').status).toBe('pass');
  });

  describe('key file', () => {
    it.each([
      ['missing', join('nope', 'k.json')],
      ['invalid', '__bad__'],
    ])('%s key -> fail; sign-in and folders skipped; no HTTP', async (_n, p) => {
      if (p === '__bad__') p = keyFile('bad2.json', '{{');
      const { checks, tokenRequests } = await run(p);
      expect(st(checks)).toEqual({
        'drive.key': 'fail',
        'drive.auth': 'skip',
        'drive.folder.app-a': 'skip',
      });
      expect(tokenRequests).toEqual([]);
    });
    it('group/other readable -> warn (POSIX), flow continues', async () => {
      if (process.platform === 'win32') return;
      const f = keyFile('loose.json', goodKey(), 0o644);
      const { checks } = await run(f);
      expect(st(checks)).toEqual({
        'drive.key': 'warn',
        'drive.auth': 'pass',
        'drive.folder.app-a': 'pass',
      });
      expect(by(checks, 'drive.key').hint).toMatch(/chmod 600/);
    });
  });

  describe('sign-in', () => {
    it('unparsable private key -> fail without echoing anything', async () => {
      const f = keyFile('badpem.json', {
        ...goodKey(),
        private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      });
      const { checks } = await run(f);
      expect(st(checks)).toMatchObject({ 'drive.auth': 'fail', 'drive.folder.app-a': 'skip' });
      expect(JSON.stringify(checks)).not.toContain('AAAA');
    });
    it('invalid_grant -> fail with clock/key hint', async () => {
      const f = keyFile('good3.json', goodKey());
      const { checks } = await run(f, {
        token: [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }],
      });
      const c = by(checks, 'drive.auth');
      expect(c.status).toBe('fail');
      expect(c.message).toContain('Invalid JWT Signature');
      expect(c.hint).toMatch(/clock/);
      expect(by(checks, 'drive.folder.app-a').status).toBe('skip');
    });
    it('other error / 200 without access_token -> fail', async () => {
      const f = keyFile('good4.json', goodKey());
      expect(
        by((await run(f, { token: [401, { error: 'invalid_client' }] })).checks, 'drive.auth')
          .status,
      ).toBe('fail');
      expect(by((await run(f, { token: [200, {}] })).checks, 'drive.auth').status).toBe('fail');
    });
    it('network error -> fail', async () => {
      const f = keyFile('good5.json', goodKey());
      expect(by((await run(f, { token: 'neterr' })).checks, 'drive.auth').message).toContain(
        'Could not reach',
      );
    });
  });

  describe('folder', () => {
    const f = () => keyFile('good6.json', goodKey());
    it('404 -> fail and tells which email to add', async () => {
      const c = by(
        (await run(f(), { folder: [404, { error: { code: 404 } }] })).checks,
        'drive.folder.app-a',
      );
      expect(c.status).toBe('fail');
      expect(c.hint).toContain(SA);
    });
    it('403 insufficient permissions -> fail with Content manager hint', async () => {
      const c = by(
        (
          await run(f(), {
            folder: [403, { error: { errors: [{ reason: 'insufficientFilePermissions' }] } }],
          })
        ).checks,
        'drive.folder.app-a',
      );
      expect(c).toMatchObject({ status: 'fail' });
      expect(c.hint).toContain('Content manager');
    });
    it('403 accessNotConfigured -> fail telling to enable the Drive API', async () => {
      const c = by(
        (
          await run(f(), {
            folder: [403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }],
          })
        ).checks,
        'drive.folder.app-a',
      );
      expect(c.status).toBe('fail');
      expect(c.hint).toMatch(/Enable "Google Drive API"/);
    });
    it('5xx / network -> fail', async () => {
      expect(by((await run(f(), { folder: [500, {}] })).checks, 'drive.folder.app-a').status).toBe(
        'fail',
      );
      expect(by((await run(f(), { folder: 'neterr' })).checks, 'drive.folder.app-a').status).toBe(
        'fail',
      );
    });
    it('not a folder -> fail', async () => {
      const c = by(
        (await run(f(), { folder: [200, folderBody({ mimeType: 'application/pdf' })] })).checks,
        'drive.folder.app-a',
      );
      expect(c.status).toBe('fail');
    });
    it('canAddChildren=false -> fail', async () => {
      const c = by(
        (
          await run(f(), {
            folder: [200, folderBody({ capabilities: { canAddChildren: false, canShare: true } })],
          })
        ).checks,
        'drive.folder.app-a',
      );
      expect(c.status).toBe('fail');
      expect(c.hint).toContain('Content manager');
    });
    it('My Drive folder (no driveId) -> warn about the service-account quota', async () => {
      const c = by(
        (await run(f(), { folder: [200, folderBody({ driveId: undefined })] })).checks,
        'drive.folder.app-a',
      );
      expect(c.status).toBe('warn');
      expect(c.hint).toMatch(/Shared Drive/);
    });
    it('cannot share + anyoneWithLink -> warn; without anyoneWithLink -> pass', async () => {
      const body = folderBody({ capabilities: { canAddChildren: true, canShare: false } });
      expect(
        by((await run(f(), { folder: [200, body] })).checks, 'drive.folder.app-a').status,
      ).toBe('warn');
      expect(
        by((await run(f(), { folder: [200, body] }, undefined, false)).checks, 'drive.folder.app-a')
          .status,
      ).toBe('pass');
    });
    it('repo without a folder id -> warn (single target)', async () => {
      const { checks } = await run(f(), {}, [{ repoId: 'app-a', folderId: undefined }]);
      expect(by(checks, 'drive.folder.app-a').status).toBe('warn');
    });
    it('no targets at all -> warn', async () => {
      const { checks } = await run(f(), {}, []);
      expect(by(checks, 'drive.folder')).toMatchObject({ status: 'warn' });
    });
    it('ad-hoc folder id (no repo) uses the plain id', async () => {
      const { checks } = await run(f(), {}, [{ folderId: FOLDER }]);
      expect(by(checks, 'drive.folder').status).toBe('pass');
    });
    it('several repos: repos without a folder are left out, others are checked', async () => {
      const { checks } = await run(f(), {}, [
        { repoId: 'app-a', folderId: FOLDER },
        { repoId: 'app-b', folderId: undefined },
      ]);
      expect(checks.map((c) => c.id)).toEqual(['drive.key', 'drive.auth', 'drive.folder.app-a']);
    });
  });
});
