import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkpoint,
  guardFile,
  guardWorkspace,
  parseGitDiff,
  parseStatus,
  readWsFile,
  writeWsFile,
  wsDiff,
} from './workspaceFs';

let root: string;
let repo: string;
let outside: string;
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-ws-')));
  root = join(base, 'Work');
  outside = join(base, 'secret');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'key.txt'), 'nope');
  repo = join(root, 'app');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.dart'), 'void a() {}\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'key.txt'), join(repo, 'link.txt'));
});

describe('workspace path guard', () => {
  it('accepts a directory under a root', async () => {
    expect(await guardWorkspace(repo, [root])).toBe(repo);
  });
  it('refuses a symlink that leads out of the root, and paths outside', async () => {
    await expect(guardWorkspace(join(root, 'escape'), [root])).rejects.toMatchObject({
      code: 'ws_not_allowed',
    });
    await expect(guardWorkspace(outside, [root])).rejects.toMatchObject({ code: 'ws_not_allowed' });
  });
  it('refuses a relative path with a clear error (e.g. missing leading slash)', async () => {
    await expect(guardWorkspace(repo.slice(1), [root])).rejects.toMatchObject({
      code: 'ws_path_not_absolute',
      status: 400,
      message: expect.stringContaining(`"${repo}"`),
    });
  });
  it('refuses ../, absolute, .git and symlinked files out of the workspace', async () => {
    await expect(guardFile(repo, '../secret/key.txt', true)).rejects.toMatchObject({
      code: 'path_not_allowed',
    });
    await expect(guardFile(repo, '/etc/passwd', true)).rejects.toMatchObject({
      code: 'path_not_allowed',
    });
    await expect(guardFile(repo, '.git/config', true)).rejects.toMatchObject({
      code: 'path_not_allowed',
    });
    await expect(guardFile(repo, 'link.txt', true)).rejects.toMatchObject({
      code: 'path_not_allowed',
    });
  });
});

describe('files, diffs, checkpoints', () => {
  it('writes with hash protection and diffs working tree incl. untracked', async () => {
    const f = await readWsFile(repo, 'a.dart');
    await writeWsFile(repo, 'a.dart', 'void a() { b(); }\n', f.hash);
    await expect(writeWsFile(repo, 'a.dart', 'x', f.hash)).rejects.toMatchObject({
      code: 'file_changed',
    });
    await writeWsFile(repo, 'new.dart', 'n\n', null);
    const d = await wsDiff(repo, 'app', 'working', undefined);
    expect(d.files.map((x) => [x.path, x.kind]).sort()).toEqual(
      [
        ['a.dart', 'modified'],
        ['link.txt', 'added'],
        ['new.dart', 'added'],
      ].sort(),
    );
  });
  it('turn diff = only what changed after the checkpoint', async () => {
    const n = await checkpoint(repo, 'app');
    writeFileSync(join(repo, 'turn.dart'), 't\n');
    const d = await wsDiff(repo, 'app', 'turn', undefined);
    expect(d.label).toContain(`#${n}`);
    expect(d.files.map((x) => x.path)).toEqual(['turn.dart']);
  });
});

describe('parsers', () => {
  it('parseGitDiff handles rename / new / binary', () => {
    const files = parseGitDiff(
      'diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n@@ -1 +1 @@\n-a\n+b\n' +
        'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n' +
        'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n',
    );
    expect(files.map((f) => [f.path, f.kind, f.binary])).toEqual([
      ['y', 'renamed', false],
      ['n.txt', 'added', false],
      ['i.png', 'modified', true],
    ]);
    expect(files[0]!.diff).toBe('@@ -1 +1 @@\n-a\n+b');
  });
  it('parseStatus reads branch, ahead/behind and dirty files', () => {
    const s = parseStatus(
      '# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b lib/a.dart\n? new.dart\n',
    );
    expect(s).toMatchObject({ branch: 'feat/x', ahead: 2, behind: 1 });
    expect(s.dirty).toEqual([
      { code: '.M', path: 'lib/a.dart' },
      { code: '??', path: 'new.dart' },
    ]);
  });
});
