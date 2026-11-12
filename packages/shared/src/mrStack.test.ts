import { describe, expect, it } from 'vitest';
import { ancestorsOf, buildStackForest, stacksOf, type StackInputNode } from './mrStack';
import { evaluateMergeGate, type MergeGateInput } from './mergeGate';

const sha = (c: string) => c.repeat(40);
// main ← A ← B ← C (linear, 3 levels). Commit lists are `main...X`, newest first.
const A: StackInputNode = {
  key: '!1',
  iid: 1,
  branch: 'a',
  headSha: sha('a'),
  commits: [sha('a')],
};
const B: StackInputNode = {
  key: '!2',
  iid: 2,
  branch: 'b',
  headSha: sha('b'),
  commits: [sha('b'), sha('a')],
};
const C: StackInputNode = {
  key: '!3',
  iid: 3,
  branch: 'c',
  headSha: sha('c'),
  commits: [sha('c'), sha('b'), sha('a')],
};

describe('buildStackForest', () => {
  it('linear 3 levels: parent at position 1, direct parent is the nearest ancestor', () => {
    const p = buildStackForest([C, A, B]);
    const by = new Map(p.map((x) => [x.key, x]));
    expect(by.get('!1')).toMatchObject({ parentKey: null, position: 1, rootKey: '!1' });
    expect(by.get('!2')).toMatchObject({ parentKey: '!1', position: 2, rootKey: '!1' });
    expect(by.get('!3')).toMatchObject({ parentKey: '!2', position: 3, rootKey: '!1' });
    const stacks = stacksOf('app', [A, B, C], p);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.nodes.map((n) => n.iid)).toEqual([1, 2, 3]);
  });

  it('branching: two children of one parent share the root', () => {
    const D: StackInputNode = {
      key: '!4',
      iid: 4,
      branch: 'd',
      headSha: sha('d'),
      commits: [sha('d'), sha('a')],
    };
    const p = buildStackForest([A, B, D]);
    const by = new Map(p.map((x) => [x.key, x]));
    expect(by.get('!2')!.parentKey).toBe('!1');
    expect(by.get('!4')!.parentKey).toBe('!1');
    expect(by.get('!4')!.position).toBe(2);
    expect(stacksOf('app', [A, B, D], p)[0]!.nodes).toHaveLength(3);
  });

  it('merged parent is not a parent any more (not in the open set; commits no longer include it)', () => {
    const B2 = { ...B, commits: [sha('b')] };
    const p = buildStackForest([B2]);
    expect(p[0]).toMatchObject({ parentKey: null, position: 1 });
  });

  it('parent without MR (pushed branch) is still an ancestor', () => {
    const branchA: StackInputNode = { ...A, key: 'branch:a', iid: null };
    const anc = ancestorsOf({ key: '!2', headSha: B.headSha, commits: B.commits! }, [branchA]);
    expect(anc.map((x) => x.key)).toEqual(['branch:a']);
  });

  it('unknown commits are laid out alone', () => {
    const p = buildStackForest([A, { ...B, commits: null }]);
    expect(p.find((x) => x.key === '!2')!.parentKey).toBeNull();
  });
});

const gateBase = (over: Partial<MergeGateInput> = {}): MergeGateInput => ({
  source: 'live',
  checkedAt: 1,
  state: 'opened',
  draft: false,
  hasConflicts: false,
  approvalMode: 'approvals_api',
  approvals: { status: 'ok', approvedBy: ['sam.reviewer'] },
  reviewers: ['sam.reviewer'],
  gitlabMergeStatus: 'mergeable',
  stack: { status: 'ok', openParents: [], commitCount: 1 },
  squash: { mr: false, project: 'default_off' },
  ...over,
});

describe('evaluateMergeGate: stack + squash', () => {
  it('passes for an approved, unstacked, one-commit MR', () => {
    expect(evaluateMergeGate(gateBase()).allowed).toBe(true);
  });
  it('blocks a child while its parent is open, even when approved', () => {
    const g = evaluateMergeGate(
      gateBase({ stack: { status: 'ok', openParents: [{ iid: 7, branch: 'a' }], commitCount: 2 } }),
    );
    expect(g.allowed).toBe(false);
    expect(g.reasons.map((r) => r.code)).toContain('stack_parent_open');
    expect(g.stackParents).toEqual([{ iid: 7, branch: 'a' }]);
  });
  it('blocks when the parent branch has no MR yet', () => {
    const g = evaluateMergeGate(
      gateBase({
        stack: { status: 'ok', openParents: [{ iid: null, branch: 'a' }], commitCount: 2 },
      }),
    );
    expect(g.reasons[0]!.message).toContain('no MR yet');
  });
  it('passes once the parent is merged (no open parents)', () => {
    expect(
      evaluateMergeGate(gateBase({ stack: { status: 'ok', openParents: [], commitCount: 1 } }))
        .allowed,
    ).toBe(true);
  });
  it('fails closed when the stack is unknown', () => {
    const g = evaluateMergeGate(
      gateBase({ stack: { status: 'error', openParents: [], commitCount: null, message: 'x' } }),
    );
    expect(g.reasons.map((r) => r.code)).toEqual(['stack_unknown']);
  });
  it('blocks squash on the MR and project "always"', () => {
    expect(
      evaluateMergeGate(gateBase({ squash: { mr: true, project: null } })).reasons.map(
        (r) => r.code,
      ),
    ).toEqual(['squash_enabled']);
    expect(evaluateMergeGate(gateBase({ squash: { mr: false, project: 'always' } })).allowed).toBe(
      false,
    );
  });
  it('neither blocks nor warns when the MR has more than one commit (review fixes add commits)', () => {
    const g = evaluateMergeGate(
      gateBase({ stack: { status: 'ok', openParents: [], commitCount: 3 } }),
    );
    expect(g.allowed).toBe(true);
    expect(g.warnings).toEqual([]);
  });
});
