import { afterEach, describe, expect, it } from 'vitest';
import type { Check } from '@relay/shared';
import { testGitlab } from './gitlab';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';

const HOST = 'https://gitlab.example.test';
const TOKEN = 'glpat-SUPERSECRET-9999';
const NOW = Date.parse('2026-11-01T00:00:00Z');

type Reply = [number, unknown];
interface Scenario {
  user?: Reply;
  self?: Reply;
  project?: Reply;
  mrOpened?: Reply;
  mrAll?: Reply;
  approvals?: Reply;
  netErrorOn?: 'user' | 'project';
}
const project = (level: unknown = 40, extra: Record<string, unknown> = {}) => ({
  id: 123,
  path_with_namespace: 'team/app-a',
  archived: false,
  merge_requests_enabled: true,
  permissions: {
    project_access: level === null ? null : { access_level: level },
    group_access: null,
  },
  ...extra,
});
const OK: Required<Omit<Scenario, 'netErrorOn'>> = {
  user: [200, { id: 1, username: 'jane.doe' }],
  self: [200, { active: true, revoked: false, scopes: ['api'], expires_at: '2027-12-31' }],
  project: [200, project()],
  mrOpened: [200, [{ iid: 7 }]],
  mrAll: [200, [{ iid: 7 }]],
  approvals: [200, { approved_by: [] }],
};

let m: ReturnType<typeof mockHttp>;
afterEach(async () => {
  await m.close();
});

async function run(
  s: Scenario = {},
  over: {
    approvalMode?: 'approvals_api' | 'award_emoji' | 'note_keyword';
    host?: string | undefined;
    me?: string | undefined;
  } = {},
): Promise<Check[]> {
  m = mockHttp({ maxRetries: 0 });
  const r = { ...OK, ...s };
  const pool = m.agent.get(HOST);
  const add = (path: string | RegExp, reply: Reply, err = false) => {
    const i = pool.intercept({ path, method: 'GET', headers: { 'private-token': TOKEN } });
    (err
      ? i.replyWithError(new Error('boom'))
      : i.reply(reply[0], reply[1] as object, { headers: JSON_HEADERS })
    ).persist();
  };
  add('/api/v4/user', r.user, s.netErrorOn === 'user');
  add('/api/v4/personal_access_tokens/self', r.self);
  add('/api/v4/projects/123', r.project, s.netErrorOn === 'project');
  add('/api/v4/projects/123/merge_requests?state=opened&per_page=1', r.mrOpened);
  add('/api/v4/projects/123/merge_requests?state=all&per_page=1', r.mrAll);
  add('/api/v4/projects/123/merge_requests/7/approvals', r.approvals);
  const host = 'host' in over ? over.host : HOST;
  return testGitlab({
    global: { gitlab: { ...(host ? { host } : {}), ...(over.me ? { myUsername: over.me } : {}) } },
    repo: {
      gitlab: { projectId: 123, token: TOKEN },
      approvalMode: over.approvalMode ?? 'approvals_api',
    },
    http: m.http,
    now: NOW,
  });
}
const by = (cs: Check[], id: string) => cs.find((c) => c.id === id)!;
const statuses = (cs: Check[]) => Object.fromEntries(cs.map((c) => [c.id, c.status]));

describe('testGitlab', () => {
  it('all pass on a healthy project', async () => {
    const cs = await run();
    expect(statuses(cs)).toEqual({
      'gitlab.auth': 'pass',
      'gitlab.scope': 'pass',
      'gitlab.project': 'pass',
      'gitlab.access': 'pass',
      'gitlab.approvals': 'pass',
    });
    expect(by(cs, 'gitlab.auth').message).toContain('@jane.doe');
  });

  it('missing host -> fail + everything else skipped, no request made', async () => {
    const cs = await run({}, { host: undefined });
    expect(statuses(cs)).toEqual({
      'gitlab.auth': 'fail',
      'gitlab.scope': 'skip',
      'gitlab.project': 'skip',
      'gitlab.access': 'skip',
      'gitlab.approvals': 'skip',
    });
    expect(by(cs, 'gitlab.auth').hint).toMatch(/host/i);
  });

  it('401 on /user -> fail with a token hint; dependents skipped', async () => {
    const cs = await run({ user: [401, { message: '401 Unauthorized' }] });
    expect(by(cs, 'gitlab.auth')).toMatchObject({ status: 'fail' });
    expect(by(cs, 'gitlab.auth').hint).toMatch(/api/);
    expect(cs.filter((c) => c.status === 'skip')).toHaveLength(4);
  });

  it('non-401 failure on /user', async () => {
    const cs = await run({ user: [500, {}] });
    expect(by(cs, 'gitlab.auth').status).toBe('fail');
    expect(by(cs, 'gitlab.auth').message).toContain('HTTP 500');
  });

  it('network error -> fail, message never contains the token', async () => {
    const cs = await run({ netErrorOn: 'user' });
    expect(by(cs, 'gitlab.auth').status).toBe('fail');
    expect(JSON.stringify(cs)).not.toContain(TOKEN);
  });

  it('warns when the token user differs from the configured username (case-insensitive otherwise)', async () => {
    expect(by(await run({}, { me: 'someone-else' }), 'gitlab.auth').status).toBe('warn');
    expect(by(await run({}, { me: 'JaneDoe' }), 'gitlab.auth').status).toBe('pass');
  });

  describe('scope', () => {
    it('read_api only -> fail', async () => {
      const cs = await run({ self: [200, { active: true, scopes: ['read_api'] }] });
      expect(by(cs, 'gitlab.scope')).toMatchObject({ status: 'fail' });
      expect(by(cs, 'gitlab.scope').message).toContain('read_api');
    });
    it('no scopes listed -> fail', async () => {
      expect(
        by(await run({ self: [200, { active: true, scopes: [] }] }), 'gitlab.scope').status,
      ).toBe('fail');
    });
    it('revoked / inactive -> fail', async () => {
      expect(
        by(await run({ self: [200, { revoked: true, scopes: ['api'] }] }), 'gitlab.scope').status,
      ).toBe('fail');
      expect(
        by(await run({ self: [200, { active: false, scopes: ['api'] }] }), 'gitlab.scope').status,
      ).toBe('fail');
    });
    it('endpoint missing (old GitLab) or forbidden -> warn', async () => {
      expect(by(await run({ self: [404, {}] }), 'gitlab.scope').status).toBe('warn');
      expect(by(await run({ self: [403, {}] }), 'gitlab.scope').status).toBe('warn');
      expect(by(await run({ self: [500, {}] }), 'gitlab.scope').status).toBe('warn');
    });
    it('expiring within 14 days -> warn; expired -> fail; later -> pass', async () => {
      const w = by(
        await run({ self: [200, { scopes: ['api'], expires_at: '2026-11-05' }] }),
        'gitlab.scope',
      );
      expect(w.status).toBe('warn');
      expect(w.message).toMatch(/expires in \d+ day/);
      expect(
        by(
          await run({ self: [200, { scopes: ['api'], expires_at: '2026-10-30' }] }),
          'gitlab.scope',
        ).status,
      ).toBe('fail');
      expect(
        by(
          await run({ self: [200, { scopes: ['api'], expires_at: '2027-06-01' }] }),
          'gitlab.scope',
        ).status,
      ).toBe('pass');
      // the expiry day itself still counts as valid
      expect(
        by(
          await run({ self: [200, { scopes: ['api'], expires_at: '2026-11-01' }] }),
          'gitlab.scope',
        ).status,
      ).toBe('warn');
    });
  });

  describe('project + access', () => {
    it('404 -> fail, access and approvals skipped', async () => {
      const cs = await run({ project: [404, {}] });
      expect(statuses(cs)).toMatchObject({
        'gitlab.project': 'fail',
        'gitlab.access': 'skip',
        'gitlab.approvals': 'skip',
      });
      expect(by(cs, 'gitlab.project').hint).toMatch(/project id/i);
    });
    it('403 -> fail', async () => {
      expect(by(await run({ project: [403, {}] }), 'gitlab.project').status).toBe('fail');
    });
    it('network error on project -> fail', async () => {
      const cs = await run({ netErrorOn: 'project' });
      expect(statuses(cs)).toMatchObject({ 'gitlab.project': 'fail', 'gitlab.access': 'skip' });
    });
    it('archived or MRs disabled -> warn', async () => {
      const a = by(
        await run({ project: [200, project(40, { archived: true })] }),
        'gitlab.project',
      );
      expect(a.status).toBe('warn');
      expect(a.message).toContain('archived');
      const b = by(
        await run({ project: [200, project(40, { merge_requests_enabled: false })] }),
        'gitlab.project',
      );
      expect(b.status).toBe('warn');
    });
    it.each([
      [50, 'pass'],
      [40, 'pass'],
      [30, 'pass'],
      [20, 'warn'],
      [10, 'fail'],
    ])('access level %i -> %s', async (level, status) => {
      expect(by(await run({ project: [200, project(level)] }), 'gitlab.access').status).toBe(
        status,
      );
    });
    it('no access level reported -> warn; group access counts, highest wins', async () => {
      expect(by(await run({ project: [200, project(null)] }), 'gitlab.access').status).toBe('warn');
      const p = {
        ...project(10),
        permissions: { project_access: { access_level: 10 }, group_access: { access_level: 40 } },
      };
      expect(by(await run({ project: [200, p] }), 'gitlab.access').status).toBe('pass');
    });
  });

  describe('approvals', () => {
    it.each(['award_emoji', 'note_keyword'] as const)(
      'mode %s -> skip (not needed)',
      async (approvalMode) => {
        const c = by(await run({}, { approvalMode }), 'gitlab.approvals');
        expect(c.status).toBe('skip');
        expect(c.message).toContain(approvalMode);
      },
    );
    it('no MR at all -> warn', async () => {
      const cs = await run({ mrOpened: [200, []], mrAll: [200, []] });
      expect(by(cs, 'gitlab.approvals').status).toBe('warn');
    });
    it('falls back to the latest MR of any state', async () => {
      const cs = await run({ mrOpened: [200, []], mrAll: [200, [{ iid: 7 }]] });
      expect(by(cs, 'gitlab.approvals').status).toBe('pass');
    });
    it('approvals endpoint 404/403 -> fail with a mode hint', async () => {
      for (const code of [404, 403]) {
        const c = by(await run({ approvals: [code, {}] }), 'gitlab.approvals');
        expect(c.status).toBe('fail');
        expect(c.hint).toMatch(/award_emoji|note_keyword/);
      }
    });
    it('200 without approved_by -> warn', async () => {
      expect(by(await run({ approvals: [200, { foo: 1 }] }), 'gitlab.approvals').status).toBe(
        'warn',
      );
    });
    it('other statuses / list failure -> warn', async () => {
      expect(by(await run({ approvals: [500, {}] }), 'gitlab.approvals').status).toBe('warn');
      expect(by(await run({ mrOpened: [500, {}] }), 'gitlab.approvals').status).toBe('warn');
    });
  });

  it('only issues GETs (read-only)', async () => {
    const cs = await run();
    expect(cs.length).toBeGreaterThan(0);
    // a non-GET would have been unmatched by the mock (disableNetConnect) and failed a check
    expect(cs.every((c) => c.status === 'pass')).toBe(true);
  });
});
