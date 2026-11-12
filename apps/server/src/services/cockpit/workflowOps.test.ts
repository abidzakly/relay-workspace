import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cardStartPrompt, extractUploads, threadPrompt } from './threadPrompt';
import { integrityCheck, startBranch } from './workflowOps';

let repo: string;
const sh = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString();

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-wf-')));
  sh('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
});

describe('startBranch', () => {
  it('creates the card branch from the base', async () => {
    expect(await startBranch(repo, 'feat/APP-1-login', 'main')).toEqual({
      branch: 'feat/APP-1-login',
      base: 'main',
      replaced: false,
    });
    expect(sh('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/APP-1-login');
  });
  it('refuses an existing branch, a dirty tree and unsafe names', async () => {
    await expect(startBranch(repo, 'feat/APP-1-login', 'main')).rejects.toMatchObject({
      code: 'branch_exists',
    });
    await expect(startBranch(repo, '-x', 'main')).rejects.toMatchObject({ code: 'validation' });
    writeFileSync(join(repo, 'a.txt'), 'dirty\n');
    await expect(startBranch(repo, 'feat/APP-2', 'main')).rejects.toMatchObject({
      code: 'ws_dirty',
    });
  });
});

describe('startBranch replace', () => {
  it('resets an existing branch to the base', async () => {
    sh('checkout', '-q', '--', '.');
    sh('checkout', '-q', 'feat/APP-1-login');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    sh('add', '.');
    sh('commit', '-q', '-m', 'old work');
    const base = sh('rev-parse', 'main').trim();
    expect(await startBranch(repo, 'feat/APP-1-login', 'main', true)).toEqual({
      branch: 'feat/APP-1-login',
      base: 'main',
      replaced: true,
    });
    expect(sh('rev-parse', 'HEAD').trim()).toBe(base);
  });
});

describe('integrityCheck', () => {
  it('is only for Flutter projects', async () => {
    await expect(integrityCheck(repo)).rejects.toMatchObject({ code: 'not_flutter' });
  });
});

describe('cardStartPrompt', () => {
  it('points at the ruleset files and stops at the push', () => {
    const p = cardStartPrompt({
      title: 'Login',
      url: 'https://notion.so/x',
      branchName: 'feat/APP-1',
      base: 'origin/feat/APP-0',
    });
    expect(p).toContain('feat/APP-1');
    expect(p).toContain('https://notion.so/x');
    expect(p).toContain('origin/feat/APP-0');
    expect(p).toContain('ruleset/ruleset.md');
    expect(p).toContain('ruleset/agent-notion-gitlab-workflow.md');
    expect(p).toContain('git push -u origin feat/APP-1');
    expect(p).toContain('Do NOT create a merge request');
    expect(p).toContain('only after I approve it');
    expect(p).not.toContain('force-with-lease');
  });
  it('force-pushes when the branch was replaced', () => {
    const p = cardStartPrompt({
      title: 'Login',
      url: null,
      branchName: 'feat/APP-1',
      base: 'main',
      replaced: true,
    });
    expect(p).toContain('git push --force-with-lease -u origin feat/APP-1');
  });
});

describe('extractUploads', () => {
  const secret = 'a'.repeat(32);
  it('finds images and files, decodes names and drops duplicates', () => {
    const img = `![shot](/uploads/${secret}/my%20shot.png)`;
    expect(
      extractUploads([`see ${img}`, `again ${img} and [log](/uploads/${secret}/app.log)`]),
    ).toEqual([
      { secret, filename: 'my shot.png', url: `/uploads/${secret}/my%20shot.png` },
      { secret, filename: 'app.log', url: `/uploads/${secret}/app.log` },
    ]);
  });
  it('ignores ordinary links', () => {
    expect(extractUploads(['[docs](https://example.com/uploads/nope.png)'])).toEqual([]);
  });
});

describe('threadPrompt', () => {
  const input = {
    mr: { iid: 7, title: 'Login', sourceBranch: 'feat/a', targetBranch: 'main', webUrl: null },
    discussion: {
      id: 'abcdef12',
      resolvable: true,
      resolved: false,
      position: null,
      notes: [{ id: 1, author: 'rev', body: 'rename\x1b[201~this', createdAt: 0, unread: false }],
    },
    code: {
      path: 'a.dart',
      oldPath: null,
      newLine: 3,
      oldLine: null,
      lines: [{ kind: 'add' as const, oldNo: null, newNo: 3, text: 'var x;' }],
    },
    attachments: ['/w/.git/cockpit-attachments/abcdef12/shot.png'],
    failedAttachments: [],
    branchSynced: true,
  };
  it('fix: carries code and attachments, asks for a new commit and no push', () => {
    const p = threadPrompt({ ...input, mode: 'fix' });
    expect(p).toContain('+var x;');
    expect(p).toContain('shot.png');
    expect(p).toContain('NEW commit');
    expect(p).toContain('Do not push');
  });
  it('review: changes nothing', () => {
    expect(threadPrompt({ ...input, mode: 'review' })).toContain('Do NOT change any file');
  });
  it('strips escape sequences from comment text', () => {
    expect(threadPrompt({ ...input, mode: 'fix' })).not.toContain('\x1b');
  });
});
