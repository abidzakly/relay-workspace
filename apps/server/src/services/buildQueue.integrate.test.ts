import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuildQueue } from './buildQueue';
import { GitExec } from './gitExec';

type Integrate = (
  run: unknown,
  repoId: string,
  clonePath: string,
  mrs: { iid: number; branch: string; title: string }[],
  dryRun: boolean,
) => Promise<void>;

let root: string;
let clone: string;
const sh = (args: string[]) =>
  execFileSync('git', args, { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (file: string, text: string, msg: string) => {
  writeFileSync(join(clone, file), text);
  sh(['add', '.']);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', msg]);
};
/** Makes `origin/<branch>` exist in the clone without a remote. */
const remoteBranch = (branch: string, fromBase: string) => {
  sh(['update-ref', `refs/remotes/origin/${branch}`, fromBase]);
};

const queue = () => {
  const q = new BuildQueue({
    config: {} as never,
    jobs: {} as never,
    git: new GitExec({ clonesRoot: root }),
    clones: {} as never,
    log: { info() {}, warn() {}, error() {} } as never,
    apksDir: join(root, 'apks'),
    timeoutMs: 1000,
    passEnv: [],
  });
  const run = {
    abort: new AbortController(),
    lines: [],
    listeners: new Set(),
    seq: 0,
    lineChars: 0,
    unpersisted: '',
  };
  const integrate = (q as unknown as { integrate: Integrate }).integrate.bind(q);
  return (mrs: { iid: number; branch: string; title: string }[], dryRun = false) =>
    integrate(run, 'app', clone, mrs, dryRun);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preview-'));
  clone = join(root, 'app');
  mkdirSync(clone);
  sh(['init', '-b', 'main']);
  commit('pubspec.yaml', 'name: app\nversion: 1.0.0-alpha-4+7\n', 'base');
  commit('shared.txt', 'one\n', 'shared');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const branchFrom = (name: string, edit: () => void) => {
  sh(['checkout', '-q', '-b', name, 'main']);
  edit();
  remoteBranch(name, name);
  sh(['checkout', '-q', 'main']);
};

describe('BuildQueue QA preview merge', () => {
  it('merges the branches in order and bumps the version locally', async () => {
    branchFrom('feat-a', () => commit('a.txt', 'a\n', 'a'));
    branchFrom('feat-b', () => commit('b.txt', 'b\n', 'b'));
    await queue()([
      { iid: 1, branch: 'feat-a', title: 'a' },
      { iid: 2, branch: 'feat-b', title: 'b' },
    ]);
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(clone, 'b.txt'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(clone, 'pubspec.yaml'), 'utf8')).toContain('1.0.0-alpha-5+7');
  });

  it('aborts on a conflict and leaves the tree clean', async () => {
    branchFrom('feat-a', () => commit('shared.txt', 'from a\n', 'a'));
    branchFrom('feat-b', () => commit('shared.txt', 'from b\n', 'b'));
    await expect(
      queue()([
        { iid: 1, branch: 'feat-a', title: 'a' },
        { iid: 2, branch: 'feat-b', title: 'b' },
      ]),
    ).rejects.toMatchObject({ code: 'integration_conflict' });
    expect(sh(['status', '--porcelain']).trim()).toBe('');
  });

  it('fails when a branch is gone from origin', async () => {
    await expect(queue()([{ iid: 1, branch: 'nope', title: 'x' }])).rejects.toMatchObject({
      code: 'integration_branch_missing',
    });
  });

  it('a dry run touches nothing', async () => {
    branchFrom('feat-a', () => commit('a.txt', 'a\n', 'a'));
    await queue()([{ iid: 1, branch: 'feat-a', title: 'a' }], true);
    expect(sh(['status', '--porcelain']).trim()).toBe('');
    expect(readFileSync(join(clone, 'pubspec.yaml'), 'utf8')).toContain('alpha-4');
  });
});
