import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigSchema, type Check } from '@relay/shared';
import { testNotion } from './notion';
import { JSON_HEADERS, mockHttp } from '../testing/mockHttp';

const TOKEN = 'ntn_SUPERSECRET-4242';
const STATUSES = [
  'Backlog',
  'Next Up',
  'In Progress',
  'Complete',
  'Ready to Test',
  'On Feedback',
  'Issues',
];
const opts = (names: string[]) => names.map((n) => ({ id: `id-${n}`, name: n, color: 'default' }));

/** Documented 2025-09-03 data source shape (UNVERIFIED against a live sample). */
function schema(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'data_source',
    id: 'ds1',
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title', title: {} },
      Status: {
        id: 's1',
        name: 'Status',
        type: 'status',
        status: { options: opts(STATUSES), groups: [] },
      },
      Type: {
        id: 't1',
        name: 'Type',
        type: 'select',
        select: {
          options: opts(['Bug', 'New Feature', 'Improvement', 'Research', 'Issues', 'Feedback']),
        },
      },
      Assignee: { id: 'a1', name: 'Assignee', type: 'people', people: {} },
      Estimation: { id: 'e1', name: 'Estimation', type: 'date', date: {} },
      'Branch name': { id: 'b1', name: 'Branch name', type: 'rich_text', rich_text: {} },
      'Parent item': {
        id: 'p1',
        name: 'Parent item',
        type: 'relation',
        relation: { data_source_id: 'ds1' },
      },
    },
    ...over,
  };
}
type Props = Record<string, unknown>;
const withProps = (patch: Props, remove: string[] = []) => {
  const s = schema();
  const props = { ...(s.properties as Props), ...patch };
  for (const r of remove) delete props[r];
  return { ...s, properties: props };
};

let m: ReturnType<typeof mockHttp>;
afterEach(async () => {
  await m.close();
});

async function run(
  reply: [number, unknown] | 'neterr' | 'timeout' = [200, schema()],
  notion: Record<string, unknown> = {},
  sla?: string[],
) {
  m = mockHttp({ maxRetries: 0, timeoutMs: 30 });
  const g = GlobalConfigSchema.parse({ notion: { token: TOKEN, dataSourceId: 'ds1', ...notion } });
  const i = m.agent.get('https://api.notion.com').intercept({
    path: '/v1/data_sources/ds1',
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'notion-version': g.notion.version },
  });
  if (reply === 'neterr') i.replyWithError(new Error('boom'));
  else if (reply === 'timeout') i.reply(200, {}).delay(300);
  else i.reply(reply[0], reply[1] as object, { headers: JSON_HEADERS });
  return testNotion({
    notion: g.notion,
    slaTypeNames: sla ?? Object.keys(g.sla.rules),
    http: m.http,
  });
}
const by = (cs: Check[], id: string) => cs.find((c) => c.id === id)!;
const st = (cs: Check[]) => Object.fromEntries(cs.map((c) => [c.id, c.status]));

describe('testNotion', () => {
  it('healthy database: all pass and detection is reported', async () => {
    const { checks, detected } = await run();
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.map((c) => c.id)).toEqual([
      'notion.auth',
      'notion.version',
      'notion.prop.title',
      'notion.prop.status',
      'notion.status.ready',
      'notion.status.options',
      'notion.prop.type',
      'notion.prop.assignee',
      'notion.prop.estimation',
      'notion.prop.branchName',
      'notion.prop.parent',
      'notion.sla.types',
    ]);
    expect(detected?.titleProp).toEqual({ name: 'Name', id: 'title' });
    expect(detected?.statusProp).toEqual({ name: 'Status', id: 's1', type: 'status' });
    expect(detected?.statusOptions).toHaveLength(7);
    expect(detected?.statusOptions.find((o) => o.configured === 'Ready to Test')).toEqual({
      configured: 'Ready to Test',
      name: 'Ready to Test',
      id: 'id-Ready to Test',
    });
  });

  it('never leaks the token', async () => {
    const { checks } = await run([
      401,
      { object: 'error', code: 'unauthorized', message: `bad ${TOKEN}` },
    ]);
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });

  describe('connection', () => {
    it('no token -> fail without any request', async () => {
      m = mockHttp();
      const g = GlobalConfigSchema.parse({ notion: { dataSourceId: 'ds1' } });
      const r = await testNotion({ notion: g.notion, slaTypeNames: [], http: m.http });
      expect(r.checks).toHaveLength(1);
      expect(r.checks[0]).toMatchObject({ id: 'notion.auth', status: 'fail' });
    });
    it('no data source id -> fail without any request', async () => {
      m = mockHttp();
      const g = GlobalConfigSchema.parse({ notion: { token: TOKEN } });
      const r = await testNotion({ notion: g.notion, slaTypeNames: [], http: m.http });
      expect(r.checks[0]).toMatchObject({ id: 'notion.auth', status: 'fail' });
      expect(r.checks[0]!.message).toMatch(/data source id/);
    });
    it.each([
      [401, /rejected the token/],
      [403, /not allowed/],
      [404, /not found/],
      [400, /rejected the request/],
      [429, /rate limiting/],
      [500, /HTTP 500/],
    ])('HTTP %i -> single fail', async (code, re) => {
      const { checks, detected } = await run([code, { object: 'error', code: 'x' }]);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ id: 'notion.auth', status: 'fail' });
      expect(checks[0]!.message).toMatch(re);
      expect(checks[0]!.hint).toBeTruthy();
      expect(detected).toBeUndefined();
    });
    it('404 hint mentions sharing the integration and database-vs-data-source id', async () => {
      const { checks } = await run([404, { code: 'object_not_found' }]);
      expect(checks[0]!.hint).toMatch(/Connections/);
      expect(checks[0]!.hint).toMatch(/data source id/);
    });
    it('network error and timeout -> fail', async () => {
      expect((await run('neterr')).checks[0]).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('Could not reach'),
      });
      expect((await run('timeout')).checks[0]).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('Timed out'),
      });
    });
    it('a database object / payload without properties -> fail', async () => {
      expect((await run([200, { object: 'database', id: 'x' }])).checks[0]!.status).toBe('fail');
      expect((await run([200, { object: 'data_source', id: 'x' }])).checks[0]!.status).toBe('fail');
    });
    it('different Notion-Version -> warn only', async () => {
      const { checks } = await run([200, schema()], { version: '2026-01-01' });
      expect(by(checks, 'notion.version').status).toBe('warn');
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    });
  });

  describe('title + status detection (nts rules)', () => {
    it('select named Status is used when there is no status-type property', async () => {
      const s = withProps({
        Status: { id: 's1', name: 'Status', type: 'select', select: { options: opts(STATUSES) } },
      });
      const { checks, detected } = await run([200, s]);
      expect(by(checks, 'notion.prop.status').message).toContain('select named "Status"');
      expect(detected?.statusProp?.type).toBe('select');
      expect(by(checks, 'notion.status.ready').status).toBe('pass');
    });
    it('status-type property wins even when named differently', async () => {
      const s = withProps(
        { Stage: { id: 's9', name: 'Stage', type: 'status', status: { options: opts(STATUSES) } } },
        ['Status'],
      );
      const { detected } = await run([200, s]);
      expect(detected?.statusProp).toEqual({ name: 'Stage', id: 's9', type: 'status' });
    });
    it('no status property -> fail, option checks skipped', async () => {
      const { checks } = await run([200, withProps({}, ['Status'])]);
      expect(st(checks)).toMatchObject({
        'notion.prop.status': 'fail',
        'notion.status.ready': 'skip',
        'notion.status.options': 'skip',
      });
    });
    it('explicit status name: case-insensitive hit, wrong type, missing', async () => {
      expect(
        by(
          (await run([200, schema()], { props: { status: 'status' } })).checks,
          'notion.prop.status',
        ).status,
      ).toBe('pass');
      expect(
        by((await run([200, schema()], { props: { status: 'Name' } })).checks, 'notion.prop.status')
          .status,
      ).toBe('fail');
      expect(
        by((await run([200, schema()], { props: { status: 'Nope' } })).checks, 'notion.prop.status')
          .status,
      ).toBe('fail');
    });
    it('title: missing and wrong type -> fail', async () => {
      expect(
        by((await run([200, withProps({}, ['Name'])])).checks, 'notion.prop.title').status,
      ).toBe('fail');
      expect(
        by((await run([200, schema()], { props: { title: 'Type' } })).checks, 'notion.prop.title')
          .status,
      ).toBe('fail');
      expect(
        by((await run([200, schema()], { props: { title: 'name' } })).checks, 'notion.prop.title')
          .status,
      ).toBe('pass');
    });
  });

  describe('status options', () => {
    it('options match case/whitespace-insensitively', async () => {
      const s = withProps({
        Status: {
          id: 's1',
          name: 'Status',
          type: 'status',
          status: { options: opts(STATUSES.map((x) => x.toUpperCase().replace(' ', '  '))) },
        },
      });
      const { checks, detected } = await run([200, s]);
      expect(by(checks, 'notion.status.options').status).toBe('pass');
      expect(detected?.statusOptions.find((o) => o.configured === 'Next Up')?.name).toBe(
        'NEXT  UP',
      );
    });
    it('readyStatus missing in Notion -> fail (and lists existing options)', async () => {
      const s = withProps({
        Status: {
          id: 's1',
          name: 'Status',
          type: 'status',
          status: { options: opts(STATUSES.filter((x) => x !== 'Ready to Test')) },
        },
      });
      const c = by((await run([200, s])).checks, 'notion.status.ready');
      expect(c.status).toBe('fail');
      expect(c.hint).toContain('"Backlog"');
    });
    it('another configured status missing -> warn, ready still pass', async () => {
      const s = withProps({
        Status: {
          id: 's1',
          name: 'Status',
          type: 'status',
          status: { options: opts(STATUSES.filter((x) => x !== 'On Feedback')) },
        },
      });
      const { checks } = await run([200, s]);
      expect(by(checks, 'notion.status.ready').status).toBe('pass');
      const c = by(checks, 'notion.status.options');
      expect(c.status).toBe('warn');
      expect(c.message).toContain('On Feedback');
    });
    it('Notion options the app does not know -> warn (unmapped)', async () => {
      const s = withProps({
        Status: {
          id: 's1',
          name: 'Status',
          type: 'status',
          status: { options: opts([...STATUSES, 'Parked']) },
        },
      });
      const c = by((await run([200, s])).checks, 'notion.status.unmapped');
      expect(c.status).toBe('warn');
      expect(c.message).toContain('Parked');
    });
    it('options that collide once normalized -> warn', async () => {
      const s = withProps({
        Status: {
          id: 's1',
          name: 'Status',
          type: 'status',
          status: { options: opts([...STATUSES, 'next up']) },
        },
      });
      expect(by((await run([200, s])).checks, 'notion.status.options').status).toBe('warn');
    });
  });

  describe('configured properties', () => {
    it.each([
      ['type', 'Type'],
      ['assignee', 'Assignee'],
      ['estimation', 'Estimation'],
      ['branchName', 'Branch name'],
    ])('required %s: missing -> fail with candidates; wrong type -> fail', async (role, name) => {
      const missing = by((await run([200, withProps({}, [name])])).checks, `notion.prop.${role}`);
      expect(missing.status).toBe('fail');
      const wrong = by(
        (await run([200, withProps({ [name]: { id: 'x', name, type: 'checkbox', checkbox: {} } })]))
          .checks,
        `notion.prop.${role}`,
      );
      expect(wrong.status).toBe('fail');
      expect(wrong.message).toContain('checkbox');
    });
    it('missing parent relation is only a warning', async () => {
      const { checks } = await run([200, withProps({}, ['Parent item'])]);
      expect(by(checks, 'notion.prop.parent').status).toBe('warn');
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    });
    it('a configured name differing by case -> warn with the real name', async () => {
      const { checks } = await run([200, schema()], { props: { branchName: 'branch NAME' } });
      const c = by(checks, 'notion.prop.branchName');
      expect(c.status).toBe('warn');
      expect(c.hint).toContain('"Branch name"');
    });
    it('names that collide once normalized -> fail', async () => {
      const s = withProps({
        'branch name': { id: 'z', name: 'branch name', type: 'rich_text', rich_text: {} },
      });
      const { checks } = await run([200, s], { props: { branchName: 'BRANCH NAME' } });
      expect(by(checks, 'notion.prop.branchName').status).toBe('fail');
    });
    it('a formula branch name property passes', async () => {
      const s = withProps({ Branch: { id: 'f', name: 'Branch', type: 'formula', formula: {} } }, [
        'Branch name',
      ]);
      const { checks } = await run([200, s], { props: { branchName: 'Branch' } });
      expect(by(checks, 'notion.prop.branchName').status).toBe('pass');
    });
    it('a configured custom property name is honoured', async () => {
      const s = withProps({ Owner: { id: 'o', name: 'Owner', type: 'people', people: {} } }, [
        'Assignee',
      ]);
      const { checks } = await run([200, s], { props: { assignee: 'Owner' } });
      expect(by(checks, 'notion.prop.assignee').status).toBe('pass');
    });
  });

  describe('SLA type names', () => {
    it('rule keys missing from Type options -> warn', async () => {
      const c = by((await run([200, schema()], {}, ['Bug', 'Chore'])).checks, 'notion.sla.types');
      expect(c.status).toBe('warn');
      expect(c.message).toContain('Chore');
    });
    it('matches case/whitespace-insensitively', async () => {
      expect(
        by((await run([200, schema()], {}, ['new  feature', 'BUG'])).checks, 'notion.sla.types')
          .status,
      ).toBe('pass');
    });
    it('skipped when the Type property is unusable', async () => {
      expect(
        by((await run([200, withProps({}, ['Type'])])).checks, 'notion.sla.types').status,
      ).toBe('skip');
    });
  });
});
