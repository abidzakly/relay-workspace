import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { isSafeBranchName } from '@relay/shared';
import { CockpitHostError } from './host';
import { sessionEnv } from './sessions';
import { git } from './workspaceFs';

/**
 * Workflow helpers on the Mac: the one-tap integrity gate before an MR, the card-start
 * branch, and checking out an MR's branch for a reviewer thread. Fixed programs and argument lists only; branch names are validated.
 */

export interface IntegrityStep {
  name: string;
  ok: boolean;
  /** Last lines of output (for the checklist detail). */
  tail: string;
  durationMs: number;
}

const tail = (s: string, n = 40) => s.split('\n').slice(-n).join('\n').trim();

function run(cwd: string, file: string, args: string[], timeoutMs: number): Promise<IntegrityStep> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env: sessionEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, out, errOut) =>
        resolve({
          name: [file, ...args].join(' '),
          ok: !err,
          tail: tail(`${out}\n${errOut}`),
          durationMs: Date.now() - started,
        }),
    );
  });
}

/** `flutter pub get && dart analyze lib/` (fvm-aware). The second step runs only when the first passed. */
export async function integrityCheck(
  cwd: string,
): Promise<{ ok: boolean; steps: IntegrityStep[] }> {
  if (!existsSync(join(cwd, 'pubspec.yaml'))) {
    throw new CockpitHostError(
      'not_flutter',
      'No pubspec.yaml: the integrity gate is for Flutter projects.',
      422,
    );
  }
  const fvm = existsSync(join(cwd, '.fvmrc')) || existsSync(join(cwd, '.fvm'));
  const steps: IntegrityStep[] = [];
  const pub = fvm
    ? await run(cwd, 'fvm', ['flutter', 'pub', 'get'], 5 * 60_000)
    : await run(cwd, 'flutter', ['pub', 'get'], 5 * 60_000);
  steps.push(pub);
  if (pub.ok) {
    steps.push(
      fvm
        ? await run(cwd, 'fvm', ['dart', 'analyze', 'lib/'], 5 * 60_000)
        : await run(cwd, 'dart', ['analyze', 'lib/'], 5 * 60_000),
    );
  }
  return { ok: steps.every((s) => s.ok) && steps.length === 2, steps };
}

/**
 * What a card start does with a branch that already exists: `replace` resets it to the base (its local commits are
 * dropped), `reuse` checks it out as it is. Unset = refuse with `branch_exists`, so the user can choose.
 * `true` is the older spelling of `replace`.
 */
export type ExistingBranch = 'replace' | 'reuse';

function existingMode(v: ExistingBranch | boolean | undefined): ExistingBranch | null {
  if (v === true) return 'replace';
  return v === 'replace' || v === 'reuse' ? v : null;
}

/**
 * Card start: `git checkout -b <branch> <base>` in a clean working tree. Refuses a dirty tree (nothing of the user's is
 * carried into the wrong card) and an existing branch, unless `existing` says what to do with it.
 */
export async function startBranch(
  cwd: string,
  branch: string,
  base: string,
  existing: ExistingBranch | boolean = false,
): Promise<{ branch: string; base: string; replaced: boolean; reused: boolean }> {
  if (!isSafeBranchName(branch) || !isSafeBranchName(base)) {
    throw new CockpitHostError('validation', 'invalid branch name', 422);
  }
  const dirty = (await git(cwd, ['status', '--porcelain'])).trim();
  if (dirty) {
    throw new CockpitHostError(
      'ws_dirty',
      'The working tree has uncommitted changes: commit or stash them first.',
      409,
    );
  }
  const mode = existingMode(existing);
  const exists = await hasRef(cwd, `refs/heads/${branch}`);
  if (exists && !mode)
    throw new CockpitHostError('branch_exists', `Branch ${branch} already exists.`, 409);
  if (exists) await refuseCheckedOutElsewhere(cwd, branch);
  if (exists && mode === 'reuse') {
    const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current !== branch) await git(cwd, ['checkout', branch]);
    return { branch, base, replaced: false, reused: true };
  }
  const replaced = exists && mode === 'replace';
  await fetchOrigin(cwd);
  // A local base can be behind: start from origin's tip when origin has it. Never track the base (a push must not go there).
  const onOrigin = await hasRef(cwd, `refs/remotes/origin/${base}`);
  await git(cwd, [
    'checkout',
    '--no-track',
    replaced ? '-B' : '-b',
    branch,
    onOrigin ? `origin/${base}` : base,
  ]);
  return { branch, base, replaced, reused: false };
}

/**
 * Git refuses to check out (or reset) a branch another worktree has checked out. Says so in words before git does.
 * The worktree at `cwd` itself does not count.
 */
async function refuseCheckedOutElsewhere(cwd: string, branch: string): Promise<void> {
  const here = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const list = await git(cwd, ['worktree', 'list', '--porcelain']);
  let path = '';
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && path !== here) {
      throw new CockpitHostError(
        'branch_checked_out',
        `Branch ${branch} is checked out in ${path}: switch that tree to another branch first.`,
        409,
      );
    }
  }
}

/**
 * Clears a dirty working tree so a card can start. `stash` keeps everything, untracked files too, as one `git stash`
 * entry; `discard` resets tracked files to HEAD and deletes untracked ones. Ignored files stay in both modes.
 */
export async function cleanTree(
  cwd: string,
  mode: 'stash' | 'discard',
): Promise<{ mode: 'stash' | 'discard'; stash: string | null }> {
  if (!(await git(cwd, ['status', '--porcelain'])).trim()) return { mode, stash: null };
  if (mode === 'stash') {
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await git(cwd, [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      `cockpit: set aside on ${branch || 'detached HEAD'} before a card start (${at} UTC)`,
    ]);
    return { mode, stash: (await git(cwd, ['rev-parse', 'stash@{0}'])).trim() };
  }
  await git(cwd, ['reset', '--hard', 'HEAD']);
  await git(cwd, ['clean', '-fd']);
  return { mode, stash: null };
}

/**
 * Puts an MR's source branch in the working tree and fast-forwards it to origin. Switching refuses a dirty tree; staying
 * on the branch keeps local work, and `synced: false` then says a fast-forward was not possible.
 */
export async function checkoutBranch(
  cwd: string,
  branch: string,
): Promise<{ branch: string; synced: boolean }> {
  if (!isSafeBranchName(branch)) {
    throw new CockpitHostError('validation', 'invalid branch name', 422);
  }
  await fetchOrigin(cwd);
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (current !== branch) {
    if ((await git(cwd, ['status', '--porcelain'])).trim()) {
      throw new CockpitHostError(
        'ws_dirty',
        `The working tree has uncommitted changes on ${current}: commit or stash them before switching to ${branch}.`,
        409,
      );
    }
    if (await hasRef(cwd, `refs/heads/${branch}`)) await git(cwd, ['checkout', branch]);
    else await git(cwd, ['checkout', '--track', '-b', branch, `origin/${branch}`]);
  }
  if (!(await hasRef(cwd, `refs/remotes/origin/${branch}`))) return { branch, synced: false };
  try {
    await git(cwd, ['merge', '--ff-only', `origin/${branch}`]);
    return { branch, synced: true };
  } catch {
    return { branch, synced: false };
  }
}

/** Offline or no remote: the last fetched state is still usable, so a failed fetch does not stop the work. */
async function fetchOrigin(cwd: string): Promise<void> {
  await git(cwd, ['fetch', 'origin']).catch(() => undefined);
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  const out = await git(cwd, ['rev-parse', '--verify', '--quiet', ref], { allowExit: [1] });
  return out.trim().length > 0;
}

/** Where a workspace's worktrees live: `<parent dir>/.cockpit-worktrees/<repo folder>/<branch slug>`. */
export function worktreeDir(parentReal: string, branch: string): string {
  const slug =
    branch
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'branch';
  return join(dirname(parentReal), WORKTREES_DIR, basename(parentReal), slug);
}

export const WORKTREES_DIR = '.cockpit-worktrees';

/**
 * Bulk card start: a new branch from `<base>` checked out in its own git worktree, so another agent can work on it while
 * the parent workspace keeps its own branch. Refuses an existing directory, and an existing branch unless `existing`
 * says what to do with it (as in `startBranch`). `--no-track`, like `startBranch`.
 */
export async function addWorktree(
  parentReal: string,
  branch: string,
  base: string,
  existing?: ExistingBranch,
): Promise<{ path: string; replaced: boolean; reused: boolean }> {
  if (!isSafeBranchName(branch) || !isSafeBranchName(base)) {
    throw new CockpitHostError('validation', 'invalid branch name', 422);
  }
  const mode = existingMode(existing);
  const exists = await hasRef(parentReal, `refs/heads/${branch}`);
  if (exists && !mode) {
    throw new CockpitHostError('branch_exists', `Branch ${branch} already exists.`, 409);
  }
  const dir = worktreeDir(parentReal, branch);
  if (existsSync(dir)) {
    throw new CockpitHostError('worktree_exists', `A worktree for ${branch} already exists.`, 409);
  }
  // A worktree cannot hold a branch that is checked out anywhere else, the parent included.
  if (exists) await refuseCheckedOutElsewhere(parentReal, branch);
  await mkdir(dirname(dir), { recursive: true });
  if (exists && mode === 'reuse') {
    await git(parentReal, ['worktree', 'add', dir, branch]);
    await copyRuleset(parentReal, dir);
    return { path: dir, replaced: false, reused: true };
  }
  await fetchOrigin(parentReal);
  const onOrigin = await hasRef(parentReal, `refs/remotes/origin/${base}`);
  await git(parentReal, [
    'worktree',
    'add',
    '--no-track',
    exists ? '-B' : '-b',
    branch,
    dir,
    onOrigin ? `origin/${base}` : base,
  ]);
  await copyRuleset(parentReal, dir);
  return { path: dir, replaced: exists, reused: false };
}

/**
 * The agent prompt points at `ruleset/` (threadPrompt RULESET_FILES). Projects often keep that folder untracked or
 * ignored, so `git worktree add` leaves it out: copy it from the parent. Best effort, a failed copy never fails the start.
 */
async function copyRuleset(parentReal: string, dir: string): Promise<void> {
  const src = join(parentReal, 'ruleset');
  const dest = join(dir, 'ruleset');
  if (!existsSync(src) || existsSync(dest)) return;
  await cp(src, dest, { recursive: true }).catch(() => undefined);
}

/**
 * Removes a worktree made by `addWorktree` (its branch stays: commits are never lost). Only paths under the parent's
 * `.cockpit-worktrees` folder are touched.
 */
export async function removeWorktree(parentReal: string, dir: string): Promise<void> {
  const root = join(dirname(parentReal), WORKTREES_DIR, basename(parentReal)) + sep;
  if (!dir.startsWith(root) || dir.includes('\0')) {
    throw new CockpitHostError(
      'path_not_allowed',
      'Not a cockpit worktree of this workspace.',
      403,
    );
  }
  if (existsSync(dir)) await git(parentReal, ['worktree', 'remove', '--force', dir]);
  await git(parentReal, ['worktree', 'prune']);
}
