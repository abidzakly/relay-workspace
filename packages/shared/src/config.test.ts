import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CARD_STATUSES,
  GlobalConfigPublicSchema,
  GlobalConfigSchema,
  GlobalConfigStoredSchema,
  RepoConfigPublicSchema,
  RepoConfigSchema,
  RepoConfigStoredSchema,
  toPublicGlobalConfig,
  toPublicRepoConfig,
  toStoredGlobalConfig,
  toStoredRepoConfig,
} from './config';

const TOKEN = 'glpat-SUPER-SECRET-123';
const HOOK = 'whsec-SUPER-SECRET-456';
const NOTION = 'ntn_SUPER-SECRET-789';

const minimalRepo = {
  id: 'app-a',
  name: 'App A',
  gitlab: { projectId: 123, token: TOKEN },
  cloneUrl: 'git@gitlab.example.com:team/app-a.git',
};

describe('GlobalConfigSchema', () => {
  it('parses {} into the PLAN §3.1 defaults', () => {
    const cfg = GlobalConfigSchema.parse({});
    expect(cfg.dryRun).toBe(false);
    expect(cfg.engine).toBe('node');
    expect(cfg.notion.version).toBe('2025-09-03');
    expect(cfg.notion.statuses).toEqual([...DEFAULT_CARD_STATUSES]);
    expect(cfg.notion.readyStatus).toBe('Ready to Test');
    expect(cfg.notion.props).toEqual({
      title: 'auto',
      status: 'auto',
      type: 'Type',
      assignee: 'Assignee',
      estimation: 'Estimation',
      branchName: 'Branch name',
      parent: 'Parent item',
      assignedAt: 'Assigned at',
    });
    expect(cfg.sla).toEqual({
      rules: { Issues: 3, Feedback: 3, 'New Feature': 5, Improvement: 3 },
      unit: 'calendar',
      bugRatioMax: 0.3,
      bugRatioDenominator: 'all',
      bugType: 'Issues',
      researchType: 'Research',
      researchMinPerMonth: 1,
      assignedAtSource: 'firstSeen',
    });
    expect(cfg.notifications.ignoreOwn).toBe(true);
    expect(cfg.notifications.events).toHaveLength(9);
    expect(cfg.drive.anyoneWithLink).toBe(true);
    expect(cfg.notion.token).toBeUndefined();
  });

  it('defaults are not shared between parses', () => {
    const a = GlobalConfigSchema.parse({});
    const b = GlobalConfigSchema.parse({});
    a.notion.statuses.push('X');
    expect(b.notion.statuses).not.toContain('X');
  });

  it('rejects readyStatus not in statuses, but matches case/space-insensitively', () => {
    expect(
      GlobalConfigSchema.safeParse({ notion: { statuses: ['A', 'B'], readyStatus: 'C' } }).success,
    ).toBe(false);
    expect(
      GlobalConfigSchema.safeParse({
        notion: { statuses: ['Ready To Test'], readyStatus: ' ready to test ' },
      }).success,
    ).toBe(true);
  });

  it('validates urls, ranges and enums', () => {
    expect(GlobalConfigSchema.safeParse({ publicBaseUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(
      GlobalConfigSchema.safeParse({ publicBaseUrl: 'https://x.ngrok-free.app' }).success,
    ).toBe(true);
    expect(GlobalConfigSchema.safeParse({ gitlab: { host: 'not a url' } }).success).toBe(false);
    expect(GlobalConfigSchema.safeParse({ sla: { bugRatioMax: 1.5 } }).success).toBe(false);
    expect(GlobalConfigSchema.safeParse({ sla: { unit: 'weekly' } }).success).toBe(false);
    expect(GlobalConfigSchema.safeParse({ engine: 'ruby' }).success).toBe(false);
    expect(GlobalConfigSchema.safeParse({ sla: { rules: { Bug: 0 } } }).success).toBe(false);
    expect(GlobalConfigSchema.safeParse({ notifications: { events: ['nope'] } }).success).toBe(
      false,
    );
  });
});

describe('global config: secret handling', () => {
  const full = GlobalConfigSchema.parse({
    notion: { token: NOTION, dataSourceId: 'a'.repeat(32) },
  });

  it('public view never contains the token and reports tokenSet', () => {
    const pub = toPublicGlobalConfig(full);
    expect(pub.notion.tokenSet).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(NOTION);
    expect('token' in pub.notion).toBe(false);
    expect(GlobalConfigPublicSchema.safeParse(pub).success).toBe(true);
    expect(toPublicGlobalConfig(GlobalConfigSchema.parse({})).notion.tokenSet).toBe(false);
  });

  it('stored view never contains the token', () => {
    const stored = toStoredGlobalConfig(full);
    expect(JSON.stringify(stored)).not.toContain(NOTION);
    expect(GlobalConfigStoredSchema.safeParse(stored).success).toBe(true);
  });

  it('stored/public schemas strip a smuggled token', () => {
    const parsed = GlobalConfigStoredSchema.parse({ notion: { token: NOTION } });
    expect(JSON.stringify(parsed)).not.toContain(NOTION);
  });
});

describe('RepoConfigSchema', () => {
  it('parses a minimal repo into the PLAN §3.2 defaults', () => {
    const r = RepoConfigSchema.parse(minimalRepo);
    expect(r.baseBranch).toBe('main');
    expect(r.reviewers).toEqual(['sam.reviewer']);
    expect(r.approvalMode).toBe('approvals_api');
    expect(r.versionBranchPrefix).toBe('release/v');
    expect(r.tagFormat).toBe('v{commitVersion}');
    expect(r.partialClone).toBe(true);
    expect(r.flutter).toEqual({
      useFvm: false,
      stagingFlavor: 'auto',
      appName: null,
      cleanAfterUpload: false,
    });
    expect(r.qa.template).toContain('{drive}');
    expect(r.gitlab.webhookSecret).toBeUndefined();
    expect(r.localPath).toBeUndefined();
  });

  it('accepts a fully specified repo', () => {
    const r = RepoConfigSchema.safeParse({
      ...minimalRepo,
      baseBranch: 'develop',
      reviewers: ['sam.reviewer', 'second.reviewer'],
      approvalMode: 'award_emoji',
      assignee: 'jane.doe',
      localPath: '~/.relay/clones/app-a',
      commitIdentity: { name: 'Bot', email: 'bot@example.com' },
      flutter: { useFvm: true, stagingFlavor: 'staging', appName: 'Amru', cleanAfterUpload: true },
      drive: { folderId: '1AbCdEfGhIjKlMnOp' },
      qa: { name: 'QA', whatsapp: '62812345678' },
      gitlab: { projectId: 123, token: TOKEN, webhookSecret: HOOK },
    });
    expect(r.success).toBe(true);
  });

  it.each(['App', 'a/b', '..', 'a b', '', 'a_b', '-a'])('rejects repo id %j', (id) => {
    expect(RepoConfigSchema.safeParse({ ...minimalRepo, id }).success).toBe(false);
  });

  it.each(['-rf', '--force', 'a..b', 'a b', '$(id)', 'a;b', ''])('rejects baseBranch %j', (b) => {
    expect(RepoConfigSchema.safeParse({ ...minimalRepo, baseBranch: b }).success).toBe(false);
  });

  it.each(['', '/abs', 'a b', 'a;b', 'a..b'])('rejects versionBranchPrefix %j', (p) => {
    expect(RepoConfigSchema.safeParse({ ...minimalRepo, versionBranchPrefix: p }).success).toBe(
      false,
    );
  });

  it.each([
    '--upload-pack=touch /tmp/x',
    '-oProxyCommand=id',
    'ext::sh -c id',
    'fd::17',
    'git@host:team/app a.git',
    'https://host/a\nb',
    '',
    'relative/path',
    'ftp://host/x',
    'javascript:alert(1)',
  ])('rejects cloneUrl %j', (cloneUrl) => {
    expect(RepoConfigSchema.safeParse({ ...minimalRepo, cloneUrl }).success).toBe(false);
  });

  it.each([
    'https://gitlab.example.com/team/app-a.git',
    'ssh://git@gitlab.example.com/team/app-a.git',
    'git@gitlab.example.com:team/app-a.git',
    'file:///tmp/remote.git',
    '/tmp/remote.git',
  ])('accepts cloneUrl %s', (cloneUrl) => {
    expect(RepoConfigSchema.safeParse({ ...minimalRepo, cloneUrl }).success).toBe(true);
  });

  it('validates tagFormat, whatsapp, flavor, reviewers, projectId, secrets', () => {
    const bad = (patch: Record<string, unknown>) =>
      RepoConfigSchema.safeParse({ ...minimalRepo, ...patch }).success;
    expect(bad({ tagFormat: 'release' })).toBe(false);
    expect(bad({ tagFormat: 'v{commitVersion};x' })).toBe(false);
    expect(bad({ tagFormat: 'rel-{commitVersion}' })).toBe(true);
    expect(bad({ qa: { whatsapp: '+62 812' } })).toBe(false);
    expect(bad({ qa: { whatsapp: '12' } })).toBe(false);
    expect(bad({ flutter: { stagingFlavor: 'Staging;rm' } })).toBe(false);
    expect(bad({ flutter: { stagingFlavor: 'staging' } })).toBe(true);
    expect(bad({ reviewers: [] })).toBe(false);
    expect(bad({ reviewers: ['a b'] })).toBe(false);
    expect(bad({ gitlab: { projectId: 0, token: TOKEN } })).toBe(false);
    expect(bad({ gitlab: { projectId: 1.5, token: TOKEN } })).toBe(false);
    expect(bad({ gitlab: { projectId: 1, token: '' } })).toBe(false);
    expect(bad({ gitlab: { projectId: 1 } })).toBe(false);
    expect(bad({ commitIdentity: { name: 'x', email: 'nope' } })).toBe(false);
    expect(bad({ drive: { folderId: 'a b' } })).toBe(false);
    expect(bad({ localPath: '-x' })).toBe(false);
  });
});

describe('repo config: secret handling', () => {
  const full = RepoConfigSchema.parse({
    ...minimalRepo,
    gitlab: { projectId: 123, token: TOKEN, webhookSecret: HOOK },
  });

  it('public view never contains secrets and exposes only *Set flags', () => {
    const pub = toPublicRepoConfig(full);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(HOOK);
    expect(pub.gitlab).toEqual({ projectId: 123, tokenSet: true, webhookSecretSet: true });
    expect(RepoConfigPublicSchema.safeParse(pub).success).toBe(true);
  });

  it('webhookSecretSet is false until generated', () => {
    const noHook = RepoConfigSchema.parse(minimalRepo);
    expect(toPublicRepoConfig(noHook).gitlab.webhookSecretSet).toBe(false);
  });

  it('stored view never contains secrets', () => {
    const stored = toStoredRepoConfig(full);
    const json = JSON.stringify(stored);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(HOOK);
    expect(RepoConfigStoredSchema.safeParse(stored).success).toBe(true);
  });

  it('stored schema strips smuggled secrets', () => {
    const parsed = RepoConfigStoredSchema.parse({
      ...minimalRepo,
      gitlab: { projectId: 1, token: TOKEN, webhookSecret: HOOK },
    });
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
    expect(JSON.stringify(parsed)).not.toContain(HOOK);
  });
});
