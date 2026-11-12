import { describe, expect, it } from 'vitest';
import { ExplainThreadOutputSchema, type ReviewDiscussion } from '@relay/shared';
import { renderTemplate } from '../ai/templates';
import { explainThreadVars } from './threadPrompt';

const discussion = {
  id: 'd1',
  notes: [{ author: 'rev', createdAt: 0, body: 'why null check here?' }],
  position: null,
} as unknown as ReviewDiscussion;

describe('explainThreadVars', () => {
  const mr = { iid: 3, title: 'Login', sourceBranch: 'feat/x', targetBranch: 'main' };
  const files = [
    { path: 'a.dart', diff: '@@ -1 +1 @@\n-a\n+b' },
    { path: 'b.dart', diff: '@@ -1 +1 @@\n-c\n+d' },
  ];

  it('uses the commented file diff when the thread is on code', () => {
    const vars = explainThreadVars({
      mr,
      discussion,
      code: { path: 'b.dart', newLine: 1, oldLine: null, lines: [] } as never,
      commits: [{ id: 'abcdef1234', message: 'fix: null\n\nbody' }],
      files,
    });
    expect(vars.changes!.indexOf('### b.dart (the commented file)')).toBe(0);
    expect(vars.changes).toContain('### a.dart');
    expect(vars.commits).toBe('abcdef12 fix: null');
    expect(vars.thread).toContain('@rev');
  });

  it('falls back to every file for a general comment, and fills the template', () => {
    const vars = explainThreadVars({ mr, discussion, code: null, commits: [], files });
    expect(vars.changes).toContain('a.dart');
    expect(vars.commits).toBe('(no commits found)');
    const text = renderTemplate('explain-thread', vars);
    expect(text).toContain('!3 "Login"');
    expect(text).not.toContain('{{');
  });

  it('adds the other comments, the user context and the opened links', () => {
    const other = {
      id: 'd2',
      resolved: true,
      notes: [{ author: 'qa', createdAt: 0, body: 'rename this' }],
      position: { path: 'a.dart', newLine: 4, oldLine: null },
    } as unknown as ReviewDiscussion;
    const vars = explainThreadVars({
      mr,
      discussion,
      code: null,
      commits: [],
      files,
      discussions: [discussion, other],
      context: 'We drop the null check on purpose.',
      links: [
        { url: 'https://x.test/a', ok: true, text: 'Spec text' },
        { url: 'https://x.test/b', ok: false, text: 'Could not open: HTTP 404' },
      ],
    });
    expect(vars.comments).toContain('resolved on a.dart:4');
    expect(vars.comments).not.toContain('why null check');
    expect(vars.context).toBe('We drop the null check on purpose.');
    expect(vars.links).toContain('### https://x.test/a\nSpec text');
    expect(vars.links).toContain('Could not open');
    expect(explainThreadVars({ mr, discussion, code: null, commits: [], files }).context).toBe(
      '(none)',
    );
  });
});

describe('ExplainThreadOutputSchema', () => {
  it('rejects an unknown verdict', () => {
    const ok = { verdict: 'valid', summary: 's', whatChanged: '', suggestedReply: 'r' };
    expect(ExplainThreadOutputSchema.safeParse(ok).success).toBe(true);
    expect(ExplainThreadOutputSchema.safeParse({ ...ok, verdict: 'maybe' }).success).toBe(false);
  });
});
