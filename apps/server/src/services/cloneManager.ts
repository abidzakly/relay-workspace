import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CloneUrlSchema, isSafeBranchName, type RepoConfig } from '@relay/shared';
import { ActionError } from './actionError';
import type { GitExec } from './gitExec';
import { expandHome as expandHomePath } from '../util/platform';

/**
 * One persistent bot clone per repo: cloned once, then only ever synced. Nothing here deletes
 * or re-clones a clone: a directory that is not what it should be stops with an error for the human to look at.
 * Local to the bot clone, so no dry-run guard applies (no remote is written).
 */

const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

export type CloneRepo = Pick<
  RepoConfig,
  'id' | 'baseBranch' | 'cloneUrl' | 'partialClone' | 'localPath'
>;

export class CloneError extends ActionError {
  constructor(code: string, message: string) {
    super(409, code, message);
    this.name = 'CloneError';
  }
}

export interface EnsureCloneResult {
  path: string;
  created: boolean;
}

export interface SyncResult {
  path: string;
  baseBranch: string;
  head: string;
}

/** Stops the long network part of an operation (clone, fetch). The local steps after it are quick. */
export interface CloneOpOptions {
  signal?: AbortSignal;
}

export class CloneManager {
  /** Per-repo queue: two operations must never share one working tree. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly git: GitExec) {}

  /** Clones only when the directory is missing or empty; otherwise verifies and reuses it. */
  ensureClone(repo: CloneRepo, opts: CloneOpOptions = {}): Promise<EnsureCloneResult> {
    return this.queued(repo.id, async () => {
      const path = this.managedPath(repo);
      const created = await this.isMissingOrEmpty(path);
      if (created) await this.clone(repo, path, opts);
      await this.verify(repo, path);
      return { path, created };
    });
  }

  /** fetch --prune -> checkout base -> reset --hard origin/base -> clean -fd -> assert local == origin. */
  sync(repo: CloneRepo, opts: CloneOpOptions = {}): Promise<SyncResult> {
    return this.queued(repo.id, async () => {
      const path = this.managedPath(repo);
      const base = repo.baseBranch;
      if (!isSafeBranchName(base)) throw new CloneError('unsafe_base_branch', 'Unsafe base branch');
      if (await this.isMissingOrEmpty(path)) {
        throw new CloneError('clone_missing', `${repo.id} has no clone yet`);
      }
      await this.verify(repo, path);

      const originRef = `refs/remotes/origin/${base}`;
      await this.git.run(repo.id, 'git', ['fetch', '--prune', 'origin'], {
        timeoutMs: FETCH_TIMEOUT_MS,
        ...opts,
      });
      const origin = await this.revParse(repo.id, originRef);
      if (origin === null) {
        throw new CloneError('base_missing_on_origin', `${base} does not exist on origin`);
      }
      // -f and -B: a crash may have left edits or a missing local branch; both are replaced by origin's state anyway.
      await this.git.run(repo.id, 'git', ['checkout', '-f', '--no-track', '-B', base, originRef]);
      await this.git.run(repo.id, 'git', ['reset', '--hard', originRef]);
      await this.git.run(repo.id, 'git', ['clean', '-fd']);

      const head = await this.revParse(repo.id, 'HEAD');
      const branch = await this.git.run(repo.id, 'git', ['symbolic-ref', '--short', 'HEAD']);
      const status = await this.git.run(repo.id, 'git', ['status', '--porcelain']);
      if (head !== origin || branch.stdout.trim() !== base) {
        throw new CloneError(
          'clone_out_of_sync',
          `Local ${base} does not match origin/${base} after sync`,
        );
      }
      if (status.stdout.trim() !== '') {
        throw new CloneError('clone_not_clean', `The clone of ${repo.id} is not clean after sync`);
      }
      return { path, baseBranch: base, head };
    });
  }

  /** The clone always lives under the root: `reset --hard` and `clean` must never reach a human's working copy. */
  private managedPath(repo: CloneRepo): string {
    const path = this.git.clonePath(repo.id);
    if (repo.localPath !== undefined && expandHome(repo.localPath) !== path) {
      throw new CloneError(
        'clone_path_not_managed',
        `localPath of ${repo.id} points outside the managed clone directory`,
      );
    }
    return path;
  }

  private async isMissingOrEmpty(path: string): Promise<boolean> {
    try {
      return (await readdir(path)).length === 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw new CloneError('clone_invalid', 'The clone directory cannot be read');
    }
  }

  private async clone(repo: CloneRepo, path: string, opts: CloneOpOptions): Promise<void> {
    if (!CloneUrlSchema.safeParse(repo.cloneUrl).success) {
      throw new CloneError('unsafe_clone_url', 'Unsupported clone URL');
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const filter = repo.partialClone ? ['--filter=blob:none'] : [];
    await this.git.run(repo.id, 'git', ['clone', ...filter, '--', repo.cloneUrl, '.'], {
      timeoutMs: CLONE_TIMEOUT_MS,
      ...opts,
    });
  }

  private async verify(repo: CloneRepo, path: string): Promise<void> {
    const invalid = () =>
      new CloneError(
        'clone_invalid',
        `${path} is not a usable clone. It was left untouched; fix or remove it by hand.`,
      );
    const gitDir = await lstat(join(path, '.git')).catch(() => null);
    if (!gitDir?.isDirectory()) throw invalid();
    const top = await this.git.run(repo.id, 'git', ['rev-parse', '--show-toplevel'], {
      allowFailure: true,
    });
    if (top.exitCode !== 0 || top.stdout.trim() === '') throw invalid();
    const [topPath, ownPath] = await Promise.all([realpath(top.stdout.trim()), realpath(path)]);
    if (topPath !== ownPath) throw invalid();

    // Stored value: `git remote get-url` would apply the user's insteadOf rewrites.
    const origin = await this.git.run(repo.id, 'git', ['config', '--get', 'remote.origin.url'], {
      allowFailure: true,
    });
    if (origin.exitCode !== 0 || origin.stdout.trim() !== repo.cloneUrl) {
      throw new CloneError(
        'clone_origin_mismatch',
        `The origin of the ${repo.id} clone differs from the configured clone URL`,
      );
    }
  }

  private async revParse(repoId: string, rev: string): Promise<string | null> {
    const r = await this.git.run(
      repoId,
      'git',
      ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
      { allowFailure: true },
    );
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  private queued<T>(repoId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(repoId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(repoId, settled);
    void settled.then(() => {
      if (this.queues.get(repoId) === settled) this.queues.delete(repoId);
    });
    return run;
  }
}

function expandHome(p: string): string {
  return resolve(expandHomePath(p));
}
