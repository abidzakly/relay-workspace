import { describe, expect, it } from 'vitest';
import type { DiffFile, MrReview, ReviewDiscussion } from '@relay/shared';
import {
  backLabel,
  confirmedApproval,
  reviewLink,
  reviewOrigin,
  safeBackPath,
  withBack,
} from '@/lib/reviewApi';
import { filterMrs } from '@/views/CodeReview';
import { groupThreads, lineKey, positionFor } from './anchor';
import { chunkHunks } from './DiffFile';
import { buildTree, compareTreePaths, sortForTree } from './fileTree';
import { intraline, segments } from './intraline';
import { languageFor } from './languageFor';
import { pairChanges, parseDiff, sides, splitRows } from './parseDiff';

const DIFF = [
  '@@ -1,4 +1,5 @@ function main()',
  ' keep',
  '-old one',
  '-old two',
  '+new one',
  '+new two',
  '+new three',
  ' tail',
  '\\ No newline at end of file',
  '@@ -20,2 +21,2 @@',
  '-a = 1',
  '+a = 2',
  ' end',
  '',
].join('\n');

const file = (path: string, over: Partial<DiffFile> = {}): DiffFile =>
  ({
    path,
    oldPath: null,
    kind: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    tooLarge: false,
    collapsed: false,
    diff: DIFF,
    ...over,
  }) as DiffFile;

describe('parseDiff', () => {
  const hunks = parseDiff(DIFF);
  it('numbers old and new lines per hunk', () => {
    expect(hunks).toHaveLength(2);
    const [h] = hunks;
    expect(h!.section).toBe('function main()');
    expect(h!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['del', 3, null],
      ['add', null, 2],
      ['add', null, 3],
      ['add', null, 4],
      ['ctx', 4, 5],
    ]);
  });
  it('marks the missing final newline on the line before it', () => {
    expect(hunks[0]!.lines.at(-1)!.noNewline).toBe(true);
    expect(hunks[0]!.lines[0]!.noNewline).toBe(false);
  });
  it('counts the unchanged lines hidden between hunks', () => {
    expect(hunks[0]!.hiddenBefore).toBe(0);
    expect(hunks[1]!.hiddenBefore).toBeGreaterThan(0);
  });
  it('reads nothing from an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('split view rows', () => {
  const lines = parseDiff(DIFF)[0]!.lines;
  it('pairs removals with additions, padding the shorter side', () => {
    const rows = splitRows(lines);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.left).toBe(rows[0]!.right);
    expect(rows[3]!.left).toBeNull();
    expect(rows[3]!.right!.text).toBe('new three');
  });
  it('pairs changes both ways for word highlights', () => {
    const pairs = pairChanges(lines);
    const del = lines[1]!;
    expect(pairs.get(del)!.text).toBe('new one');
    expect(pairs.get(pairs.get(del)!)).toBe(del);
  });
  it('rebuilds each side for highlighting', () => {
    const s = sides(parseDiff(DIFF));
    expect(s.oldLines.every((l) => l.kind !== 'add')).toBe(true);
    expect(s.newText.split('\n')).toContain('new three');
  });
});

describe('intraline', () => {
  it('marks only the changed words', () => {
    const r = intraline('a = 1', 'a = 2');
    expect(r.old).toEqual([[4, 5]]);
    expect(r.new).toEqual([[4, 5]]);
  });
  it('skips rewritten lines and identical ones', () => {
    expect(intraline('completely different', 'nothing alike here')).toEqual({ old: [], new: [] });
    expect(intraline('same', 'same')).toEqual({ old: [], new: [] });
  });
  it('cuts syntax tokens at the change edges', () => {
    const segs = segments([{ content: 'a = ' }, { content: '12' }], [[4, 5]]);
    expect(segs.map((s) => [s.content, s.mark])).toEqual([
      ['a = ', false],
      ['1', true],
      ['2', false],
    ]);
  });
});

describe('languageFor', () => {
  it('knows files by extension and by name', () => {
    expect(languageFor('src/a.ts')).toBe('typescript');
    expect(languageFor('Dockerfile.prod')).toBe('dockerfile');
    expect(languageFor('README')).toBeNull();
  });
});

describe('thread anchoring', () => {
  const f = file('src/a.ts');
  const parsed = [{ file: f, hunks: parseDiff(DIFF) }];
  const thread = (id: string, newLine: number | null, oldLine: number | null, headSha?: string) =>
    ({
      id,
      resolvable: true,
      resolved: false,
      notes: [],
      position: { path: 'src/a.ts', oldPath: 'src/a.ts', newLine, oldLine, headSha },
    }) as ReviewDiscussion;

  it('puts threads under their line, and the rest aside', () => {
    const g = groupThreads(
      [thread('a', 2, null), thread('b', null, 2), thread('c', 99, null)],
      parsed,
    );
    const ft = g.byFile.get('src/a.ts')!;
    expect(ft.byLine.get('n2')!.map((t) => t.id)).toEqual(['a']);
    expect(ft.byLine.get('o2')!.map((t) => t.id)).toEqual(['b']);
    expect(ft.outdated.map((t) => t.id)).toEqual(['c']);
    expect(ft.unresolved).toBe(3);
  });
  it('treats a thread left on an older head as outdated, even if its line number exists', () => {
    const g = groupThreads(
      [thread('old', 2, null, 'aaaaaaa'), thread('cur', 3, null, 'bbbbbbb')],
      parsed,
      'BBBBBBB',
    );
    const ft = g.byFile.get('src/a.ts')!;
    expect(ft.outdated.map((t) => t.id)).toEqual(['old']);
    expect(ft.byLine.get('n3')!.map((t) => t.id)).toEqual(['cur']);
  });
  it('sends GitLab positions for new comments', () => {
    const [h] = parseDiff(DIFF);
    expect(positionFor(f, h!.lines[1]!)).toMatchObject({ newLine: null, oldLine: 2 });
    expect(positionFor(f, h!.lines[3]!)).toMatchObject({ newLine: 2, oldLine: null });
    expect(positionFor(f, h!.lines[0]!)).toMatchObject({ newLine: 1, oldLine: 1 });
    expect(lineKey(h!.lines[1]!)).toBe('o2');
  });
});

describe('file tree', () => {
  it('orders folders before files at each level', () => {
    expect(['z.ts', 'a/x.ts', 'a/b/c.ts', 'b.ts'].sort(compareTreePaths)).toEqual([
      'a/b/c.ts',
      'a/x.ts',
      'b.ts',
      'z.ts',
    ]);
    expect(sortForTree([file('b.ts'), file('a/c.ts')]).map((f) => f.path)).toEqual([
      'a/c.ts',
      'b.ts',
    ]);
  });
  it('merges single-folder chains and keeps files at their level', () => {
    const t = buildTree([file('src/auth/session.ts'), file('src/auth/mw.ts'), file('README.md')]);
    expect(t.files.map((f) => f.path)).toEqual(['README.md']);
    expect(t.dirs).toHaveLength(1);
    expect(t.dirs[0]!.name).toBe('src/auth');
    expect(t.dirs[0]!.path).toBe('src/auth');
    expect(t.dirs[0]!.files.map((f) => f.path)).toEqual(['src/auth/mw.ts', 'src/auth/session.ts']);
  });
});

describe('long diffs', () => {
  it('chunks hunks by line count without cutting a hunk', () => {
    expect(chunkHunks([100, 150, 100, 400, 10], 300)).toEqual([
      [0, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(chunkHunks([])).toEqual([]);
  });
});

describe('return path', () => {
  it('accepts same-app paths only', () => {
    expect(safeBackPath('/mrs?state=all')).toBe('/mrs?state=all');
    expect(safeBackPath('//evil.example')).toBeNull();
    expect(safeBackPath('/\\evil.example')).toBeNull();
    expect(safeBackPath('https://evil.example')).toBeNull();
    expect(safeBackPath('/x\nSet-Cookie')).toBeNull();
    expect(safeBackPath(42)).toBeNull();
  });
  it('names where Back goes', () => {
    expect(backLabel('/mrs?repo=a')).toBe('MR Inbox');
    expect(backLabel('/mrs/app-a/12')).toBe('MR detail');
    expect(backLabel('/review')).toBe('Code Review');
    expect(backLabel('/')).toBe('Workspace');
  });
  it('prefers history state, then the URL', () => {
    expect(reviewOrigin({ reviewFrom: '/mrs', reviewFromLabel: 'MR Inbox' })).toEqual({
      from: '/mrs',
      label: 'MR Inbox',
    });
    expect(reviewOrigin(null, '?back=%2Fmrs%2Fapp-a%2F3')).toEqual({
      from: '/mrs/app-a/3',
      label: 'MR detail',
    });
    expect(reviewOrigin({ reviewFrom: '//x' }, '?back=%2F%2Fx')).toBeNull();
  });
  it('builds links that carry their way back in the URL', () => {
    const l = reviewLink('group/app', 7, '/mrs?state=all', 'MR Inbox');
    expect(l.to).toBe('/review/group%2Fapp/mr/7?back=%2Fmrs%3Fstate%3Dall');
    expect(l.state).toEqual({ reviewFrom: '/mrs?state=all', reviewFromLabel: 'MR Inbox' });
    expect(withBack('/review/a/compare?from=main&to=x', '/review')).toBe(
      '/review/a/compare?from=main&to=x&back=%2Freview',
    );
    expect(withBack('/review/a/mr/1', '//evil')).toBe('/review/a/mr/1');
  });
});

describe('approval confirmation', () => {
  const review = {
    approval: {
      mode: 'approvals_api',
      approvedByMe: false,
      canApprove: true,
      canRevoke: false,
      reason: null,
    },
  } as unknown as MrReview;
  it('applies what GitLab confirmed', () => {
    const r = confirmedApproval(review, {
      dryRun: false,
      auditId: 1,
      approved: true,
      mode: 'approvals_api',
    });
    expect(r!.approval).toMatchObject({ approvedByMe: true, canApprove: false, canRevoke: true });
  });
  it('cannot take back a keyword note, and ignores dry-run', () => {
    const r = confirmedApproval(review, {
      dryRun: false,
      auditId: 1,
      approved: true,
      mode: 'note_keyword',
    });
    expect(r!.approval.canRevoke).toBe(false);
    expect(
      confirmedApproval(review, {
        dryRun: true,
        auditId: 1,
        approved: true,
        mode: 'approvals_api',
      }),
    ).toBe(review);
  });
});

describe('MR picker', () => {
  const mrs = [
    {
      title: 'Login fix',
      sourceBranch: 'fix/login',
      iid: 3,
      author: 'ana',
      updatedAt: 30,
      createdAt: 1,
    },
    {
      title: 'New UI',
      sourceBranch: 'feat/ui',
      iid: 12,
      author: 'bo',
      updatedAt: null,
      createdAt: 50,
    },
    { title: 'Docs', sourceBranch: 'docs', iid: 7, author: 'ana', updatedAt: 10, createdAt: 2 },
  ];
  it('keeps the server order for "needs me first"', () => {
    expect(filterMrs(mrs, { q: '', author: '', sort: 'action' }).map((m) => m.iid)).toEqual([
      3, 12, 7,
    ]);
  });
  it('sorts by last activity', () => {
    expect(filterMrs(mrs, { q: '', author: '', sort: 'recent' }).map((m) => m.iid)).toEqual([
      12, 3, 7,
    ]);
    expect(filterMrs(mrs, { q: '', author: '', sort: 'oldest' }).map((m) => m.iid)).toEqual([
      7, 3, 12,
    ]);
  });
  it('filters by author and search', () => {
    expect(filterMrs(mrs, { q: '', author: 'ana', sort: 'action' }).map((m) => m.iid)).toEqual([
      3, 7,
    ]);
    expect(filterMrs(mrs, { q: '!12', author: '', sort: 'action' }).map((m) => m.iid)).toEqual([
      12,
    ]);
    expect(filterMrs(mrs, { q: 'LOGIN', author: '', sort: 'action' }).map((m) => m.iid)).toEqual([
      3,
    ]);
  });
});
