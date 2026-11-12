import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isSafeVersion,
  type Job,
  type JobStepName,
  type MergeGate,
  type RepoConfig,
} from '@relay/shared';
import { ActionError } from './actionError';
import type { CloneManager } from './cloneManager';
import type { GitExecOptions, GitExecResult } from './gitExec';
import { buildMrPayload, mrTemplate } from './mrTemplate';
import { mergeConfirmingLostAnswer, readLiveMergeGate, type GitlabMergeApi } from './gitlabMerge';
import type { MrFields } from './gitlabMr';
import type { GitlabReleaseApi } from './gitlabRelease';
import { GitlabApiError, type GitlabService } from './gitlabService';
import type { StepResult } from './jobStore';
import { mapGitlabError, mapMergeError, mergeBlockedError, mrTargetId } from './mrActions';
import {
  bumpPubspecText,
  previewVersion,
  readPubspecVersion,
  versionFromBranch,
  versionTagName,
  type ReleaseMode,
} from './versionCalc';

/**
 * Steps of the release state machine, a port of `vu` + `mrc`: PREFLIGHT .. CREATE_MR, MERGE .. TAG. AWAIT_REVIEW
 * has no handler (the runner pauses there), and BUILD .. DONE are hooks.
 *
 * Any step may run again after a crash at any point, so each one first looks at what is already true (clone, branch,
 * commit, remote ref, open MR) and only then acts. History is never rewritten, and every remote write goes through
 * `ctx.write` (guardedWrite). In a dry-run the clone is not touched at all: GitLab is only read, and the pubspec comes
 * from GitLab too.
 */

const PUBSPEC = 'pubspec.yaml';
const NETWORK_TIMEOUT_MS = 5 * 60 * 1000;
/** GitLab may answer a merge before it has finished. The tag must not be placed until it has. */
const MERGE_CONFIRM_MS = 30_000;
const MERGE_POLL_MS = 2_000;
/** Everything FIND_OPEN_MR skips when an unfinished MR exists. */
const CREATE_STEPS: readonly JobStepName[] = [
  'SYNC_BASE',
  'COMPUTE_VERSION',
  'CREATE_BRANCH',
  'BUMP_PUBSPEC',
  'COMMIT',
  'PUSH',
  'CREATE_MR',
];

export class ReleaseError extends ActionError {
  constructor(code: string, message: string) {
    super(409, code, message);
    this.name = 'ReleaseError';
  }
}

export interface ReleaseWrite<T> {
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  afterResult?: (result: T) => unknown;
  run: () => Promise<T>;
}

export interface StepContext {
  job: Job;
  repo: RepoConfig;
  dryRun: boolean;
  gitlab: GitlabService;
  api: GitlabReleaseApi;
  mergeApi: GitlabMergeApi;
  clones: CloneManager;
  clonePath: string;
  now: () => number;
  /** Aborted by a cancel. `git` and clone operations already stop on it; a step checks it before a write it cannot take back. */
  signal: AbortSignal;
  log(line: string): void;
  git(args: readonly string[], opts?: GitExecOptions): Promise<GitExecResult>;
  /** `undefined` when simulated. */
  write<T>(op: ReleaseWrite<T>): Promise<T | undefined>;
  /** Tells the local cache and the UI what GitLab now says about the MR. */
  mrChanged(mr: MrFields): void;
}

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

/** A value an earlier step stored. Missing means the job row was altered: stop, do not guess. */
function stateString(job: Job, key: string): string {
  const value = job.state[key];
  if (typeof value !== 'string' || value === '') {
    throw new ReleaseError('job_state_invalid', `Job state has no ${key}`);
  }
  return value;
}

function versionBranch(job: Job): string {
  if (!job.branch) throw new ReleaseError('job_state_invalid', 'Job has no version branch');
  return job.branch;
}

export function assigneeOf(repo: RepoConfig, myUsername: string | undefined): string | undefined {
  return repo.assignee ?? myUsername;
}

// ───────────────────────────── Git helpers ─────────────────────────────

async function rev(ctx: StepContext, name: string): Promise<string | null> {
  const r = await ctx.git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
    allowFailure: true,
  });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** The exact ref, not `vu`'s pattern: `jdoe/x` would also match `other/jdoe/x`. Null when it is not on origin. */
async function remoteSha(ctx: StepContext, branch: string): Promise<string | null> {
  const r = await ctx.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  return r.stdout.trim().split(/\s+/, 1)[0] || null;
}

async function assertOnVersionBranch(ctx: StepContext): Promise<string> {
  const branch = versionBranch(ctx.job);
  const current = await ctx.git(['symbolic-ref', '--short', 'HEAD'], { allowFailure: true });
  if (current.exitCode !== 0 || current.stdout.trim() !== branch) {
    throw new ReleaseError('clone_state_mismatch', `The clone is not on ${branch}`);
  }
  return branch;
}

/** A symlink committed to the repo must not make this server read or overwrite a file outside the clone. */
async function pubspecPath(ctx: StepContext): Promise<string> {
  const path = join(ctx.clonePath, PUBSPEC);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile()) {
    throw new ReleaseError('pubspec_missing', `Cannot find ${PUBSPEC} in the clone`);
  }
  return path;
}

async function basePubspecFromGitlab(ctx: StepContext): Promise<string> {
  try {
    return await ctx.gitlab.readRawFile(PUBSPEC, ctx.repo.baseBranch);
  } catch (e) {
    if (e instanceof GitlabApiError && e.kind === 'not_found') {
      throw new ReleaseError('pubspec_missing', `Cannot find ${PUBSPEC} on the base branch`);
    }
    throw e;
  }
}

// ───────────────────────────── MR look-ups ─────────────────────────────

/** Open MRs from `query`. An incomplete answer cannot prove anything is absent, so it counts as a failed look-up. */
async function listOpenMrs(
  ctx: StepContext,
  query: { targetBranch?: string; sourceBranch?: string; assigneeUsername?: string },
): Promise<MrFields[]> {
  let result;
  try {
    result = await ctx.gitlab.listMrs({ state: 'opened', ...query });
  } catch (e) {
    throw new ReleaseError(
      'mr_lookup_failed',
      `Could not query open merge requests, so an unfinished version update cannot be ruled out. Refusing to continue. ${(e as Error).message}`,
    );
  }
  if (result.truncated || result.skipped.length > 0) {
    throw new ReleaseError(
      'mr_lookup_failed',
      'The open merge request list was incomplete, so an unfinished version update cannot be ruled out. Refusing to continue.',
    );
  }
  return result.mrs;
}

/** The node engine commits as this identity. The PTY engine does not read it: `vu` has its own. */
export function requireCommitIdentity(
  repo: Pick<RepoConfig, 'commitIdentity'>,
): NonNullable<RepoConfig['commitIdentity']> {
  if (!repo.commitIdentity) {
    throw new ReleaseError(
      'commit_identity_missing',
      'Set a commit identity for this repo under Settings → Repositories first',
    );
  }
  return repo.commitIdentity;
}

// ───────────────────────────── Steps ─────────────────────────────

const preflight: StepHandler = async (ctx): Promise<StepResult> => {
  const { repo } = ctx;
  requireCommitIdentity(repo);
  // Proves the token, the project and the base branch in one read.
  let head;
  try {
    head = await ctx.gitlab.getHeadCommit(repo.baseBranch);
  } catch (e) {
    if (!(e instanceof GitlabApiError && e.kind === 'not_found')) throw e;
    head = null;
  }
  if (!head) {
    throw new ReleaseError('base_missing', `Base branch ${repo.baseBranch} does not exist`);
  }
  ctx.log(`GitLab token works; ${repo.baseBranch} is at ${head.sha}`);
  if (ctx.dryRun) {
    ctx.log('dry-run: the clone is neither created nor touched');
    return { output: { dryRun: true } };
  }
  const clone = await ctx.clones.ensureClone(repo, { signal: ctx.signal });
  ctx.log(clone.created ? 'Clone created' : 'Existing clone reused');
  return { output: { cloneCreated: clone.created } };
};

const findOpenMr: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const mrs = await listOpenMrs(ctx, {
    targetBranch: repo.baseBranch,
    assigneeUsername: stateString(job, 'assignee'),
  });
  const matches = mrs
    .flatMap((mr) => {
      const parsed = versionFromBranch(mr.sourceBranch, repo.versionBranchPrefix);
      // `vu`'s full rule, on top of the query's state, target and assignee. Title is compared exactly.
      return parsed &&
        mr.title === mr.sourceBranch &&
        mr.targetBranch === repo.baseBranch &&
        isSafeVersion(parsed.newVersion)
        ? [{ mr, parsed }]
        : [];
    })
    .sort((a, b) => b.mr.createdAt - a.mr.createdAt);
  const newest = matches[0];
  if (!newest) {
    ctx.log('No unfinished version update');
    return { output: { found: false } };
  }

  const { mr, parsed } = newest;
  const asked = stateString(job, 'releaseMode');
  if (parsed.mode !== asked) {
    throw new ReleaseError(
      'open_mr_mode_conflict',
      `There is an unfinished ${parsed.mode} update (MR !${mr.iid}, v${parsed.newVersion}), but you asked for ${asked}. Finish that one first, or close the MR.`,
    );
  }
  if (matches.length > 1) ctx.log('Several matching open MRs found; using the newest');
  ctx.log(`Resuming MR !${mr.iid} (${mr.sourceBranch}): nothing will be created`);
  // Also in dry-run: the MR is real and only the local cache is written, so its preview can load.
  ctx.mrChanged(mr);
  if (typeof job.state.override === 'string') {
    ctx.log(`The requested version ${job.state.override} is ignored: the open MR decides`);
  }
  return {
    output: { found: true, mrIid: mr.iid, branch: mr.sourceBranch },
    state: {
      resumed: true,
      newVersion: parsed.newVersion,
      commitVersion: parsed.commitVersion,
      mrUrl: mr.webUrl,
    },
    job: { version: parsed.newVersion, branch: mr.sourceBranch, mrIid: mr.iid },
    skip: CREATE_STEPS,
  };
};

const syncBase: StepHandler = async (ctx): Promise<StepResult> => {
  if (ctx.dryRun) {
    ctx.log(`dry-run: would sync the clone to origin/${ctx.repo.baseBranch}`);
    return { output: { dryRun: true } };
  }
  const { head } = await ctx.clones.sync(ctx.repo, { signal: ctx.signal });
  ctx.log(`${ctx.repo.baseBranch} is up to date with origin (${head})`);
  return { output: { head }, state: { baseHead: head } };
};

const computeVersion: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const pubspecText = ctx.dryRun
    ? await basePubspecFromGitlab(ctx)
    : await readFile(await pubspecPath(ctx), 'utf8');
  const override = job.state.override;
  const preview = previewVersion({
    mode: stateString(job, 'releaseMode') as ReleaseMode,
    pubspecText,
    versionBranchPrefix: repo.versionBranchPrefix,
    tagFormat: repo.tagFormat,
    override: typeof override === 'string' ? override : null,
    now: new Date(ctx.now()),
  });
  if (preview.branch === repo.baseBranch) {
    throw new ReleaseError('branch_is_base', 'The version branch would be the base branch');
  }
  ctx.log(
    `${preview.current} -> ${preview.newVersion}${preview.overridden ? ` (override, computed ${preview.proposed})` : ''}`,
  );
  const plan = {
    currentVersion: preview.current,
    newVersion: preview.newVersion,
    proposedVersion: preview.proposed,
    commitVersion: preview.commitVersion,
    commitMessage: preview.commitMessage,
    tag: preview.tag,
  };
  return {
    output: plan,
    state: plan,
    job: { version: preview.newVersion, prevVersion: preview.current, branch: preview.branch },
  };
};

const createBranch: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const branch = versionBranch(job);
  if (ctx.dryRun) {
    ctx.log(`dry-run: would delete any stale ${branch}, local and on origin, then create it`);
    return { output: { dryRun: true } };
  }
  const baseHead = stateString(job, 'baseHead');
  // A crash may have left the clone on the branch, which could not be deleted then.
  await ctx.git(['checkout', '-f', repo.baseBranch, '--']);
  if ((await rev(ctx, 'HEAD')) !== baseHead) {
    throw new ReleaseError(
      'clone_state_mismatch',
      `${repo.baseBranch} moved in the clone after it was synced`,
    );
  }

  const local = await ctx.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowFailure: true,
  });
  const staleLocal = local.exitCode === 0;
  if (staleLocal) {
    await ctx.git(['branch', '-D', branch]);
    ctx.log(`Stale local branch deleted: ${branch}`);
  }

  const staleSha = await remoteSha(ctx, branch);
  if (staleSha) {
    // FIND_OPEN_MR only covers MRs assigned to this user; deleting the branch would close anyone else's.
    const open = await listOpenMrs(ctx, { sourceBranch: branch });
    const first = open[0];
    if (first) {
      throw new ReleaseError(
        'open_mr_on_stale_branch',
        `${branch} already exists on origin with an open MR (!${first.iid}) that does not match the resume rule. Deleting the branch would close it, so close or finish that MR first.`,
      );
    }
    await ctx.write({
      action: 'release.delete_remote_branch',
      targetType: 'branch',
      targetId: `${repo.id}:${branch}`,
      before: { sha: staleSha },
      after: { sha: null },
      run: async () => {
        const r = await ctx.git(['push', 'origin', '--delete', branch], {
          timeoutMs: NETWORK_TIMEOUT_MS,
          allowFailure: true,
        });
        // `vu`: the goal is only that the branch is gone from origin.
        if (r.exitCode !== 0 && !r.stderr.includes('remote ref does not exist')) {
          throw new ReleaseError(
            'remote_branch_delete_failed',
            `Could not delete ${branch} on origin: ${r.stderr.trim().slice(-500)}`,
          );
        }
      },
    });
    ctx.log(`Stale remote branch deleted: ${branch} (was ${staleSha})`);
  }

  await ctx.git(['checkout', '-b', branch]);
  ctx.log(`Created ${branch} at ${baseHead}`);
  return { output: { staleLocal, staleRemoteSha: staleSha } };
};

const bumpPubspec: StepHandler = async (ctx): Promise<StepResult> => {
  const { job } = ctx;
  const current = stateString(job, 'currentVersion');
  const next = stateString(job, 'newVersion');
  if (ctx.dryRun) {
    // Proves the replacement would work on today's file; nothing is written.
    bumpPubspecText(await basePubspecFromGitlab(ctx), current, next);
    ctx.log(`dry-run: would write ${next} to ${PUBSPEC}`);
    return { output: { dryRun: true } };
  }
  await assertOnVersionBranch(ctx);
  if ((await rev(ctx, 'HEAD')) !== stateString(job, 'baseHead')) {
    throw new ReleaseError('clone_state_mismatch', 'The version branch is not at the synced base');
  }
  // Restored first: an earlier run may have died mid-write. What comes out is then always the same.
  await ctx.git(['checkout', '--', PUBSPEC]);
  const path = await pubspecPath(ctx);
  const text = await readFile(path, 'utf8');
  if (readPubspecVersion(text) !== current) {
    throw new ReleaseError('clone_state_mismatch', `${PUBSPEC} no longer has version ${current}`);
  }
  await writeFile(path, bumpPubspecText(text, current, next));
  const actual = readPubspecVersion(await readFile(path, 'utf8'));
  if (actual !== next) {
    throw new ReleaseError(
      'pubspec_verify_failed',
      `Version verification failed. Expected ${next}, actual ${actual ?? '(none)'}.`,
    );
  }
  ctx.log(`${PUBSPEC} now has version ${next}`);
  return { output: { version: next } };
};

const commit: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const message = stateString(job, 'commitMessage');
  if (ctx.dryRun) {
    ctx.log(`dry-run: would commit "${message}"`);
    return { output: { dryRun: true } };
  }
  await assertOnVersionBranch(ctx);
  const baseHead = stateString(job, 'baseHead');
  const head = await rev(ctx, 'HEAD');
  if (head !== baseHead) {
    // Crash after the commit: this branch was created at baseHead, so its one commit is the one to keep.
    if (head === null || (await rev(ctx, 'HEAD^')) !== baseHead) {
      throw new ReleaseError('clone_state_mismatch', 'Unexpected commits on the version branch');
    }
    ctx.log(`Already committed (${head})`);
    return { output: { sha: head, reused: true }, state: { commitSha: head } };
  }

  const identity = requireCommitIdentity(repo);
  const status = await ctx.git(['status', '--porcelain']);
  const changed = status.stdout.split('\n').filter((l) => l !== '');
  if (changed.length !== 1 || changed[0]?.slice(3) !== PUBSPEC) {
    throw new ReleaseError(
      'clone_state_mismatch',
      `Expected only ${PUBSPEC} to have changed in the clone`,
    );
  }
  await ctx.git(['config', '--local', 'user.name', identity.name]);
  await ctx.git(['config', '--local', 'user.email', identity.email]);
  await ctx.git(['add', '--', PUBSPEC]);
  await ctx.git(['commit', '-m', message]);
  const sha = await rev(ctx, 'HEAD');
  if (!sha) throw new ReleaseError('commit_failed', 'The commit could not be read back');
  ctx.log(`Committed "${message}" (${sha})`);
  return { output: { sha }, state: { commitSha: sha } };
};

const push: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const branch = versionBranch(job);
  const targetId = `${repo.id}:${branch}`;
  if (ctx.dryRun) {
    await ctx.write({
      action: 'release.push',
      targetType: 'branch',
      targetId,
      after: { branch },
      run: () => Promise.resolve(),
    });
    ctx.log(`dry-run: would push ${branch}`);
    return { output: { dryRun: true } };
  }
  await assertOnVersionBranch(ctx);
  const sha = stateString(job, 'commitSha');
  if ((await rev(ctx, 'HEAD')) !== sha) {
    throw new ReleaseError('clone_state_mismatch', 'HEAD is not the release commit');
  }
  const onOrigin = await remoteSha(ctx, branch);
  if (onOrigin === sha) {
    ctx.log(`Already on origin (${sha})`);
    return { output: { sha, reused: true } };
  }
  if (onOrigin) {
    // Someone pushed after CREATE_BRANCH removed the old one. Never forced.
    throw new ReleaseError('remote_branch_diverged', `${branch} on origin is at ${onOrigin}`);
  }
  await ctx.write({
    action: 'release.push',
    targetType: 'branch',
    targetId,
    before: { sha: null },
    after: { sha },
    run: () => ctx.git(['push', '-u', 'origin', branch], { timeoutMs: NETWORK_TIMEOUT_MS }),
  });
  ctx.log(`Pushed ${branch} (${sha})`);
  return { output: { sha } };
};

/** An open MR from the branch that is the one this step would create, or null. Another one stops the run. */
async function ownOpenMr(ctx: StepContext, branch: string): Promise<MrFields | null> {
  const open = await listOpenMrs(ctx, { sourceBranch: branch });
  const own = open.find((m) => m.targetBranch === ctx.repo.baseBranch && m.title === branch);
  if (!own && open[0]) {
    throw new ReleaseError(
      'mr_mismatch',
      `${branch} has an open MR (!${open[0].iid}) with a different target or title`,
    );
  }
  return own ?? null;
}

const createMr: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const branch = versionBranch(job);
  const resultOf = (mr: MrFields, reused: boolean): StepResult => {
    ctx.log(`${reused ? 'Reusing' : 'Created'} MR !${mr.iid}${mr.webUrl ? ` ${mr.webUrl}` : ''}`);
    // Before `mrIid` is stored: the review preview asks for this MR as soon as the job names it.
    ctx.mrChanged(mr);
    return {
      output: { mrIid: mr.iid, reused },
      state: { mrUrl: mr.webUrl },
      job: { mrIid: mr.iid },
    };
  };

  if (!ctx.dryRun) {
    // A crash, or a lost answer, after the POST: the MR exists already. A failed look-up stops here too.
    const existing = await ownOpenMr(ctx, branch);
    if (existing) return resultOf(existing, true);
  }

  // Before the write, so a wrong username leaves nothing half made.
  const assignee = stateString(job, 'assignee');
  const userId = async (username: string): Promise<number> => {
    const id = await ctx.api.findUserId(username);
    if (id === null) {
      throw new ReleaseError('gitlab_user_not_found', `GitLab has no user ${username}`);
    }
    return id;
  };
  const assigneeId = await userId(assignee);
  const reviewerIds = [...new Set(await Promise.all(repo.reviewers.map(userId)))];

  // `mrc`: title = branch, empty description, remove source branch on merge.
  const outcome = await ctx.write({
    action: 'release.create_mr',
    targetType: 'branch',
    targetId: `${repo.id}:${branch}`,
    after: { title: branch, target: repo.baseBranch, assignee, reviewers: repo.reviewers },
    afterResult: (r) => ({ iid: r.mr?.iid ?? null, conflict: r.conflict }),
    run: async () => {
      try {
        // Same template as "Create MR"; a release MR has no Notion card.
        const mr = await ctx.api.createMr(
          buildMrPayload(
            mrTemplate({
              branch,
              targetBranch: repo.baseBranch,
              notionUrl: null,
              assignee,
              reviewers: repo.reviewers,
            }),
            { assigneeId, reviewerIds },
          ),
        );
        return { mr, conflict: false };
      } catch (e) {
        if (e instanceof GitlabApiError && e.status === 409) return { mr: null, conflict: true };
        throw e;
      }
    },
  });
  if (!outcome) {
    ctx.log(`dry-run: would open an MR titled ${branch} into ${repo.baseBranch}`);
    return { output: { dryRun: true }, state: { mrSimulated: true } };
  }
  if (outcome.mr) return resultOf(outcome.mr, false);

  // A 409, or a created MR whose answer could not be read: GitLab now has one, so look for it.
  const found = await ownOpenMr(ctx, branch);
  if (!found) throw new ReleaseError('mr_not_found', `GitLab has no open MR from ${branch}`);
  return resultOf(found, true);
};

// ───────────────────────────── After the review ─────────────────────────────

/**
 * The optional gate for version MRs. A merged or merging MR passes: there is nothing left to allow,
 * and MERGE adopts it.
 */
export function assertVersionMrGate(gate: MergeGate): void {
  if (gate.allowed || gate.state === 'merged' || gate.state === 'locked') return;
  throw mergeBlockedError(gate);
}

/** Polls until GitLab says merged. Read failures are retried until the deadline: the merge may well have gone through. */
async function awaitMerged(ctx: StepContext, iid: number): Promise<MrFields> {
  const deadline = Date.now() + MERGE_CONFIRM_MS;
  for (;;) {
    const mr = await ctx.gitlab.getMrDetail(iid).catch((e: unknown) => {
      if (e instanceof GitlabApiError) return null;
      throw e;
    });
    if (mr?.state === 'merged') return mr;
    if (mr?.state === 'closed') throw mrClosed(iid);
    if (Date.now() >= deadline) {
      throw new ReleaseError(
        'merge_not_confirmed',
        `GitLab has not confirmed the merge of MR !${iid} yet. Resume once it shows as merged.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, MERGE_POLL_MS));
  }
}

function mrClosed(iid: number): ReleaseError {
  return new ReleaseError(
    'mr_closed',
    `MR !${iid} is closed. Reopen it and resume, or cancel this release.`,
  );
}

const merge: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const branch = versionBranch(job);
  const iid = job.mrIid;
  if (iid === null) {
    // CREATE_MR of a dry-run opens nothing, so there is nothing to read either.
    if (!ctx.dryRun || job.state.mrSimulated !== true) {
      throw new ReleaseError('job_state_invalid', 'Job has no merge request');
    }
    await ctx.write({
      action: 'release.merge',
      targetType: 'branch',
      targetId: `${repo.id}:${branch}`,
      after: { state: 'merged' },
      run: () => Promise.resolve(),
    });
    ctx.log(`dry-run: would merge the MR from ${branch}`);
    return { output: { dryRun: true } };
  }

  const gated = repo.requireVersionMrApproval
    ? await readLiveMergeGate(ctx.gitlab, repo, iid, ctx.now).catch(mapGitlabError)
    : null;
  const detail =
    gated?.detail ?? (await ctx.gitlab.getMrDetailWithDescription(iid).catch(mapGitlabError));
  const { fields, sha } = detail;
  if (fields.sourceBranch !== branch || fields.targetBranch !== repo.baseBranch) {
    throw new ReleaseError(
      'mr_mismatch',
      `MR !${iid} is ${fields.sourceBranch} -> ${fields.targetBranch}, not ${branch} -> ${repo.baseBranch}`,
    );
  }

  // Merged in GitLab during the pause, or by a run whose answer was lost: never sent twice.
  if (fields.state === 'merged') {
    ctx.log(`MR !${iid} is already merged`);
    return { output: { mrIid: iid, reused: true } };
  }
  if (fields.state === 'closed') throw mrClosed(iid);
  if (fields.state === 'locked') {
    ctx.log(`GitLab is already merging MR !${iid}`);
    if (!ctx.dryRun) ctx.mrChanged(await awaitMerged(ctx, iid));
    return { output: { mrIid: iid, reused: true } };
  }
  if (gated) {
    assertVersionMrGate(gated.gate);
    ctx.log(`Merge gate passed: approved by ${gated.gate.approvingReviewers.join(', ')}`);
  }
  const commitSha = job.state.commitSha;
  if (typeof commitSha === 'string' && sha !== null && sha !== commitSha) {
    ctx.log(`Note: ${branch} is at ${sha}, not at the release commit ${commitSha}`);
  }
  // The merge is the one write of this step that cannot be taken back. Once sent, a cancel waits for its result.
  if (ctx.signal.aborted) throw new ReleaseError('job_cancelled', 'Cancelled before the merge');

  let outcome;
  try {
    outcome = await ctx.write({
      action: 'release.merge',
      targetType: 'mr',
      targetId: mrTargetId(repo.id, iid),
      before: { state: fields.state, sha, draft: fields.draft, hasConflicts: fields.hasConflicts },
      after: { state: 'merged', mergeCommitSha: null },
      afterResult: (r) => ({ state: r.fields?.state ?? null, mergeCommitSha: r.mergeCommitSha }),
      // Pins what was just read: a commit pushed in between makes GitLab refuse.
      run: () => mergeConfirmingLostAnswer(ctx.mergeApi, ctx.gitlab, iid, sha),
    });
  } catch (e) {
    ctx.log(`The branch and MR !${iid} are left as they are. Fix the cause, then resume.`);
    return mapMergeError(e);
  }
  if (!outcome) {
    ctx.log(`dry-run: would merge MR !${iid}`);
    return { output: { dryRun: true, mrIid: iid } };
  }
  const merged = outcome.fields?.state === 'merged' ? outcome.fields : await awaitMerged(ctx, iid);
  ctx.mrChanged(merged);
  ctx.log(`Merged MR !${iid}`);
  return {
    output: { mrIid: iid, mergeCommitSha: outcome.mergeCommitSha },
    state: { mergeCommitSha: outcome.mergeCommitSha },
  };
};

const cleanup: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  const branch = versionBranch(job);
  if (ctx.dryRun) {
    ctx.log(`dry-run: would check out ${repo.baseBranch}, delete ${branch} locally and sync`);
    return { output: { dryRun: true } };
  }
  // `vu`'s `|| true`: a resumed MR may never have had this branch in the clone.
  const deleteLocal = async () => {
    const r = await ctx.git(['branch', '-D', branch], { allowFailure: true });
    if (r.exitCode === 0) ctx.log(`Local branch deleted: ${branch}`);
  };
  // Fails only when the clone has no local base yet (a resumed MR, partial clone): sync creates it.
  const onBase = await ctx.git(['checkout', '-f', repo.baseBranch, '--'], { allowFailure: true });
  if (onBase.exitCode === 0) await deleteLocal();
  const { head } = await ctx.clones.sync(repo, { signal: ctx.signal });
  if (onBase.exitCode !== 0) await deleteLocal();

  // The tag goes on this commit, so it has to be the release. Beyond `vu`.
  const onBaseVersion = readPubspecVersion(await readFile(await pubspecPath(ctx), 'utf8'));
  if (onBaseVersion !== job.version) {
    throw new ReleaseError(
      'merge_not_on_base',
      `${repo.baseBranch} has version ${onBaseVersion ?? '(none)'} after the merge, expected ${job.version ?? '(none)'}. Nothing was tagged.`,
    );
  }
  ctx.log(`${repo.baseBranch} is up to date with origin (${head})`);
  return { output: { head }, state: { releaseHead: head } };
};

/** The commit a tag on origin points to, following an annotated tag. Null when origin has no such tag. */
async function remoteTagSha(ctx: StepContext, tag: string): Promise<string | null> {
  const ref = `refs/tags/${tag}`;
  const r = await ctx.git(['ls-remote', '--tags', 'origin', ref, `${ref}^{}`], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  const rows = r.stdout
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(/\s+/));
  const row = rows.find((c) => c[1] === `${ref}^{}`) ?? rows.find((c) => c[1] === ref);
  return row?.[0] ?? null;
}

const tagStep: StepHandler = async (ctx): Promise<StepResult> => {
  const { job, repo } = ctx;
  // A resumed MR skipped COMPUTE_VERSION, the step that stores `tag`.
  const stored = job.state.tag;
  const tag =
    typeof stored === 'string' && stored !== ''
      ? stored
      : versionTagName(repo.tagFormat, stateString(job, 'commitVersion'));
  // Only `staging` is ever shareable, not even a custom alpha.
  const skip: readonly JobStepName[] = job.mode === 'staging' ? [] : NOT_FOR_NON_STAGING;
  const targetId = `${repo.id}:${tag}`;
  if (ctx.dryRun) {
    await ctx.write({
      action: 'release.push_tag',
      targetType: 'tag',
      targetId,
      after: { tag },
      run: () => Promise.resolve(),
    });
    ctx.log(`dry-run: would tag the merged ${repo.baseBranch} as ${tag} and push it`);
    return { output: { dryRun: true, tag }, state: { tag }, skip };
  }

  const sha = stateString(job, 'releaseHead');
  const local = await ctx.git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    allowFailure: true,
  });
  if (local.exitCode === 0) {
    ctx.log(`Local tag already exists, replacing: ${tag}`);
    await ctx.git(['tag', '-d', tag]);
  }
  // By commit, not `vu`'s HEAD: the result is the same on every re-run.
  await ctx.git(['tag', tag, sha]);

  const onOrigin = await remoteTagSha(ctx, tag);
  if (onOrigin === sha) {
    ctx.log(`Tag ${tag} is already on origin (${sha})`);
    return { output: { tag, sha, reused: true }, state: { tag }, skip };
  }
  if (onOrigin) {
    // `vu` fails here as well: the push is refused. Never forced.
    throw new ReleaseError('remote_tag_diverged', `${tag} on origin is at ${onOrigin}, not ${sha}`);
  }
  await ctx.write({
    action: 'release.push_tag',
    targetType: 'tag',
    targetId,
    before: { sha: null },
    after: { sha },
    run: () => ctx.git(['push', 'origin', `refs/tags/${tag}`], { timeoutMs: NETWORK_TIMEOUT_MS }),
  });
  ctx.log(`Pushed tag ${tag} (${sha})`);
  return { output: { tag, sha }, state: { tag }, skip };
};

// ───────────────────────────── Hooks (`releasePipeline.ts`) ─────────────────────────────

export const RELEASE_HOOK_STEPS = ['BUILD', 'UPLOAD', 'SHARE', 'NOTION', 'DONE'] as const;
export type ReleaseHookStep = (typeof RELEASE_HOOK_STEPS)[number];
export type ReleaseHooks = Partial<Record<ReleaseHookStep, StepHandler>>;
const NOT_FOR_NON_STAGING: readonly JobStepName[] = ['UPLOAD', 'SHARE'];

/** Placeholders, then the given hooks. UPLOAD and SHARE refuse any job that is not staging, whatever is plugged in. */
export function hookHandlers(hooks: ReleaseHooks = {}): Record<ReleaseHookStep, StepHandler> {
  const handlerOf = (name: ReleaseHookStep): StepHandler => {
    const hook: StepHandler =
      hooks[name] ??
      ((ctx) => {
        ctx.log(`${name}: nothing plugged in yet`);
        return Promise.resolve({ output: { placeholder: true } });
      });
    if (!NOT_FOR_NON_STAGING.includes(name)) return hook;
    return (ctx) => {
      if (ctx.job.mode !== 'staging') {
        throw new ReleaseError('not_shareable', `${name} is for staging releases only`);
      }
      return hook(ctx);
    };
  };
  return {
    BUILD: handlerOf('BUILD'),
    UPLOAD: handlerOf('UPLOAD'),
    SHARE: handlerOf('SHARE'),
    NOTION: handlerOf('NOTION'),
    DONE: handlerOf('DONE'),
  };
}

export const RELEASE_STEPS: Partial<Record<JobStepName, StepHandler>> = {
  PREFLIGHT: preflight,
  FIND_OPEN_MR: findOpenMr,
  SYNC_BASE: syncBase,
  COMPUTE_VERSION: computeVersion,
  CREATE_BRANCH: createBranch,
  BUMP_PUBSPEC: bumpPubspec,
  COMMIT: commit,
  PUSH: push,
  CREATE_MR: createMr,
  MERGE: merge,
  CLEANUP: cleanup,
  TAG: tagStep,
};
