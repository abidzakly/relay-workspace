import { describe, expect, it } from 'vitest';
import {
  AppEventSchema,
  AuditEntrySchema,
  CardSchema,
  FixSchema,
  JOB_STEP_NAMES,
  JobSchema,
  JobStepSchema,
  LinkSchema,
  MrSchema,
  NoteSchema,
  VerdictSchema,
  type Rule,
} from './index';

const CARD_ID = '0123456789abcdef0123456789abcdef';
const NOW = 1_762_000_000_000;

const card = {
  id: CARD_ID,
  title: 'jdoe/feature/login',
  status: 'Complete',
  type: 'New Feature',
  assignees: ['jane.doe'],
  estimationStart: '2026-11-01',
  estimationEnd: null,
  branchName: 'jdoe/feature/login',
  parentId: null,
  url: 'https://www.notion.so/x',
  notionCreatedAt: NOW - 1000,
  lastEditedAt: NOW,
  assignedAtFirstSeen: null,
  archived: false,
  syncedAt: NOW,
};

const mr = {
  repoId: 'app-a',
  iid: 42,
  gitlabId: 9001,
  title: 'jdoe/feature/login',
  state: 'opened',
  draft: false,
  hasConflicts: false,
  sourceBranch: 'jdoe/feature/login',
  targetBranch: 'main',
  author: 'jane.doe',
  webUrl: 'https://gitlab.example/mr/42',
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  descriptionNotionId: CARD_ID,
  approvedBy: ['sam.reviewer'],
  assignees: ['jane.doe'],
  reviewers: ['sam.reviewer'],
  lastNoteAt: null,
  headPipeline: { id: 1, status: 'success', webUrl: null },
  syncedAt: NOW,
};

describe('Card / Mr / Note / Link', () => {
  it('parse valid objects', () => {
    expect(CardSchema.parse(card)).toEqual(card);
    expect(MrSchema.parse(mr)).toEqual(mr);
    expect(
      NoteSchema.safeParse({
        repoId: 'app-a',
        mrIid: 42,
        noteId: 7,
        discussionId: 'abc',
        author: 'sam.reviewer',
        body: 'lgtm',
        system: false,
        resolvable: true,
        resolved: false,
        createdAt: NOW,
        updatedAt: null,
        seen: false,
      }).success,
    ).toBe(true);
    expect(
      LinkSchema.safeParse({
        id: 1,
        cardId: CARD_ID,
        repoId: 'app-a',
        mrIid: 42,
        matchBy: 'both',
        conflict: false,
        createdAt: NOW,
      }).success,
    ).toBe(true);
  });

  it('reject invalid values', () => {
    expect(CardSchema.safeParse({ ...card, id: 'nope' }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, assignees: 'jane.doe' }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, lastEditedAt: -1 }).success).toBe(false);
    expect(MrSchema.safeParse({ ...mr, state: 'open' }).success).toBe(false);
    expect(MrSchema.safeParse({ ...mr, iid: 0 }).success).toBe(false);
    expect(MrSchema.safeParse({ ...mr, repoId: 'Bad Id' }).success).toBe(false);
    expect(MrSchema.safeParse({ ...mr, descriptionNotionId: 'zzz' }).success).toBe(false);
    expect(
      LinkSchema.safeParse({
        id: 1,
        cardId: CARD_ID,
        repoId: 'app-a',
        mrIid: 42,
        matchBy: 'guess',
        conflict: false,
        createdAt: NOW,
      }).success,
    ).toBe(false);
  });

  it('MR states are exactly the documented GitLab values', () => {
    for (const state of ['opened', 'closed', 'locked', 'merged']) {
      expect(MrSchema.safeParse({ ...mr, state }).success).toBe(true);
    }
  });
});

describe('Fix / Verdict / Rule', () => {
  it('Fix is a discriminated union with validated payloads', () => {
    expect(
      FixSchema.safeParse({ type: 'set_card_status', cardId: CARD_ID, to: 'Complete' }).success,
    ).toBe(true);
    expect(FixSchema.safeParse({ type: 'start_release', repoId: 'app-a' }).success).toBe(true);
    expect(FixSchema.safeParse({ type: 'build_and_share', repoId: 'app-a' }).success).toBe(true);
    expect(
      FixSchema.safeParse({ type: 'open_linker', cardId: null, repoId: 'app-a', mrIid: 3 }).success,
    ).toBe(true);
    expect(FixSchema.safeParse({ type: 'set_parent', cardId: CARD_ID }).success).toBe(true);
    expect(
      FixSchema.safeParse({ type: 'rename_mr_title', repoId: 'app-a', mrIid: 3, cardId: CARD_ID })
        .success,
    ).toBe(true);
    expect(
      FixSchema.safeParse({
        type: 'add_notion_link_to_mr',
        repoId: 'app-a',
        mrIid: 3,
        cardId: CARD_ID,
      }).success,
    ).toBe(true);
    // unknown type / bad payload / path-traversing repo id
    expect(FixSchema.safeParse({ type: 'delete_everything' }).success).toBe(false);
    expect(
      FixSchema.safeParse({ type: 'set_card_status', cardId: 'x', to: 'Complete' }).success,
    ).toBe(false);
    expect(FixSchema.safeParse({ type: 'start_release', repoId: '../etc' }).success).toBe(false);
  });

  it('Verdict carries both statuses side by side', () => {
    const v = VerdictSchema.parse({
      ruleId: 'in-progress-merged',
      severity: 'critical',
      message: 'MR merged but card still In Progress',
      cardId: CARD_ID,
      repoId: 'app-a',
      mrIid: 42,
      notionStatus: 'In Progress',
      mrState: 'merged',
      fix: { type: 'set_card_status', cardId: CARD_ID, to: 'Complete' },
    });
    expect(v.notionStatus).toBe('In Progress');
    expect(v.mrState).toBe('merged');
    expect(VerdictSchema.safeParse({ ...v, severity: 'red' }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...v, mrState: 'open_ish' }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...v, fix: null }).success).toBe(true);
  });

  it('Rule contract is expressible (type-level + runtime smoke)', () => {
    const rule: Rule<{ released: boolean }> = {
      id: 'complete-merged-not-released',
      severity: 'action',
      message: 'awaiting release',
      when: (c, m, ctx) => c?.status === 'Complete' && m?.state === 'merged' && !ctx.released,
      fix: (_c, m) => (m ? { type: 'start_release', repoId: m.repoId } : null),
    };
    const merged = MrSchema.parse({ ...mr, state: 'merged' });
    const c = CardSchema.parse(card);
    expect(rule.when(c, merged, { released: false })).toBe(true);
    expect(rule.when(c, merged, { released: true })).toBe(false);
    expect(FixSchema.safeParse(rule.fix?.(c, merged, { released: false })).success).toBe(true);
  });
});

describe('AuditEntry', () => {
  const base = {
    id: 1,
    at: NOW,
    actor: 'user',
    action: 'card.status',
    targetType: 'card',
    targetId: CARD_ID,
    before: { status: 'Complete' },
    after: { status: 'Ready to Test' },
    dryRun: false,
    undoToken: 'tok',
    undoneAt: null,
    batchId: null,
    undoOf: null,
  };
  it('parses and rejects', () => {
    expect(AuditEntrySchema.safeParse(base).success).toBe(true);
    expect(
      AuditEntrySchema.safeParse({ ...base, before: null, after: null, undoToken: null }).success,
    ).toBe(true);
    expect(AuditEntrySchema.safeParse({ ...base, actor: 'root' }).success).toBe(false);
    expect(AuditEntrySchema.safeParse({ ...base, action: '' }).success).toBe(false);
  });
});

describe('Job / JobStep', () => {
  const job = {
    id: 'job-1',
    repoId: 'app-a',
    kind: 'release',
    engine: 'node',
    mode: 'staging',
    status: 'running',
    currentStep: 'COMPUTE_VERSION',
    version: '1.0.16-alpha-8',
    prevVersion: '1.0.16-alpha-7+1',
    branch: 'release/v1.0.16-alpha-8',
    mrIid: null,
    flavor: 'staging',
    dryRun: false,
    state: { commitSha: 'abc', nested: { a: [1, 2] } },
    error: null,
    parentJobId: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    updatedAt: NOW,
  };
  it('Job parses', () => {
    expect(JobSchema.safeParse(job).success).toBe(true);
  });
  it('Job rejects values that would reach argv unsafely', () => {
    expect(JobSchema.safeParse({ ...job, version: '1.0.0;rm -rf /' }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, branch: '--upload-pack=x' }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, flavor: '../x' }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, status: 'exploded' }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, mode: 'yolo' }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, currentStep: 'FLY' }).success).toBe(false);
  });
  it('step names follow PLAN §8 order', () => {
    expect(JOB_STEP_NAMES[0]).toBe('PREFLIGHT');
    expect(JOB_STEP_NAMES.indexOf('AWAIT_REVIEW')).toBeLessThan(JOB_STEP_NAMES.indexOf('MERGE'));
    expect(JOB_STEP_NAMES.indexOf('UPLOAD')).toBeLessThan(JOB_STEP_NAMES.indexOf('SHARE'));
    expect(JOB_STEP_NAMES.at(-1)).toBe('DONE');
    expect(new Set(JOB_STEP_NAMES).size).toBe(JOB_STEP_NAMES.length);
  });
  it('JobStep parses', () => {
    expect(
      JobStepSchema.safeParse({
        id: 1,
        jobId: 'job-1',
        seq: 0,
        name: 'PREFLIGHT',
        status: 'succeeded',
        startedAt: NOW,
        finishedAt: NOW,
        log: 'ok',
        output: { cloneExisted: true },
        error: null,
      }).success,
    ).toBe(true);
  });
});

describe('AppEvent (SSE)', () => {
  it('parses every variant', () => {
    const events = [
      { type: 'ping', at: NOW },
      { type: 'cards.changed', cardIds: [CARD_ID] },
      { type: 'mrs.changed', repoId: 'app-a', iids: [1, 2] },
      { type: 'health.changed' },
      { type: 'settings.changed' },
      { type: 'audit.added', auditId: 5 },
      { type: 'webhook.received', repoId: 'app-a', kind: 'merge_request', at: NOW },
      { type: 'job.updated', jobId: 'j', status: 'running', currentStep: 'BUILD' },
      { type: 'job.log', jobId: 'j', step: null, line: 'hello', at: NOW },
      {
        type: 'notification',
        event: 'buildDone',
        title: 't',
        body: 'b',
        repoId: null,
        url: null,
      },
    ];
    for (const e of events) expect(AppEventSchema.safeParse(e).success).toBe(true);
  });
  it('rejects unknown / malformed events', () => {
    expect(AppEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(AppEventSchema.safeParse({ type: 'cards.changed', cardIds: ['x'] }).success).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: 'webhook.received', repoId: 'a', kind: 'tag_push', at: NOW })
        .success,
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({
        type: 'notification',
        event: 'spam',
        title: 't',
        body: 'b',
        repoId: null,
        url: null,
      }).success,
    ).toBe(false);
  });
});
