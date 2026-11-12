import { describe, expect, it } from 'vitest';
import { readyBranches } from './readyForMr';
import { mrTemplate } from './mrTemplate';

describe('readyBranches (matcher ready_for_mr)', () => {
  const cards = [
    { id: 'c1', branchName: 'feat/APP-1-login' },
    { id: 'c2', branchName: ' feat/APP-2-cart ' },
    { id: 'c3', branchName: null },
  ];
  it('matches exact Branch formula and skips branches with an open MR', () => {
    const r = readyBranches(
      [
        { repoId: 'app', branch: 'feat/APP-1-login' },
        { repoId: 'app', branch: 'feat/APP-2-cart' },
        { repoId: 'app', branch: 'feat/other' },
      ],
      cards,
      new Set(['app:feat/APP-2-cart']),
    );
    expect(r).toEqual([{ repoId: 'app', branch: 'feat/APP-1-login', cardId: 'c1' }]);
  });
  it('is case-sensitive like MR title matching', () => {
    expect(
      readyBranches([{ repoId: 'app', branch: 'FEAT/APP-1-LOGIN' }], cards, new Set()),
    ).toEqual([]);
  });
});

describe('mrTemplate', () => {
  it('title = branch, description = Notion URL, target main, no squash, not draft', () => {
    const t = mrTemplate({
      branch: 'feat/APP-1-login',
      targetBranch: 'main',
      notionUrl: 'https://www.notion.so/team/APP-1-abc',
      assignee: 'jane.doe',
      reviewers: ['sam.reviewer'],
    });
    expect(t).toEqual({
      sourceBranch: 'feat/APP-1-login',
      targetBranch: 'main',
      title: 'feat/APP-1-login',
      description: 'https://www.notion.so/team/APP-1-abc',
      assignee: 'jane.doe',
      reviewers: ['sam.reviewer'],
      removeSourceBranch: true,
      squash: false,
      draft: false,
    });
  });
  it('never carries a Draft: prefix', () => {
    expect(
      mrTemplate({
        branch: 'Draft: x',
        targetBranch: 'main',
        notionUrl: null,
        assignee: null,
        reviewers: [],
      }).title,
    ).toBe('x');
  });
});
