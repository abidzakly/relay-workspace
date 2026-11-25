import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FetchFailure, RunBranchBody, RunBranchResult } from '@relay/shared';
import { ApiError, describeError, post } from './api';
import { cockpitKeys } from './cockpitApi';
import { testBenchKeys } from './testBenchApi';

/**
 * "Run this branch": put the repo's workspace on the Mac on a branch (fetched and tracked when it is not local yet),
 * then run the app on a test device from the Test Bench.
 */

/** The Test Bench for a branch. `run` checks the branch out as soon as the bench opens. */
export function testBenchPath(repo: string, branch: string, opts: { run?: boolean } = {}): string {
  const q = new URLSearchParams({ branch });
  if (opts.run) q.set('run', '1');
  return `/test-bench/${encodeURIComponent(repo)}?${q.toString()}`;
}

/** External review projects (`~<projectId>`) have no workspace on the Mac, so they cannot run. */
export const canRunRepo = (repo: string) => !repo.startsWith('~');

export function usePrepareRunBranch() {
  const qc = useQueryClient();
  return useMutation<RunBranchResult, Error, RunBranchBody>({
    mutationFn: (b) => post('/api/test-bench/branch', b),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: cockpitKeys.status(r.workspaceId) });
      void qc.invalidateQueries({ queryKey: cockpitKeys.tree(r.workspaceId) });
      void qc.invalidateQueries({ queryKey: testBenchKeys.branch(v.repo, v.branch) });
    },
  });
}

export type RunBranchIssueKind =
  | 'network'
  | 'auth'
  | 'fetch'
  | 'missing'
  | 'agent'
  | 'busy'
  | 'held'
  | 'dirty'
  | 'workspace'
  | 'stale'
  | 'git';

/** What the alert dialog shows for one failure (or for a stale local copy). */
export interface RunBranchIssue {
  kind: RunBranchIssueKind;
  tone: 'danger' | 'warn';
  title: string;
  body: string;
  steps: string[];
  /** Raw output for the "details" disclosure. */
  raw: string | null;
  /** Where the route from this Mac to the branch broke, for the hero diagram. */
  broken: 'agent' | 'network' | 'origin' | 'workspace';
}

function fetchFailureOf(details: unknown): FetchFailure | null {
  if (typeof details !== 'object' || details === null) return null;
  const d = details as Record<string, unknown>;
  if (d.reason !== 'network' && d.reason !== 'auth' && d.reason !== 'unknown') return null;
  return { reason: d.reason, message: typeof d.message === 'string' ? d.message : '' };
}

function fromFetch(f: FetchFailure, branch: string, stale: boolean): RunBranchIssue {
  const tail = stale
    ? `The local copy of ${branch} is still there, but it may be behind what was pushed.`
    : `${branch} is not on this Mac yet, so there is nothing to run until it can be fetched.`;
  if (f.reason === 'network') {
    return {
      kind: stale ? 'stale' : 'network',
      tone: stale ? 'warn' : 'danger',
      title: 'Can’t reach GitLab',
      body: `git fetch could not connect to origin. ${tail}`,
      steps: [
        'Turn on the VPN (GitLab is only reachable through it).',
        'Check that this Mac is online.',
        'Retry — it also retries by itself when the connection comes back.',
      ],
      raw: f.message,
      broken: 'network',
    };
  }
  if (f.reason === 'auth') {
    return {
      kind: stale ? 'stale' : 'auth',
      tone: stale ? 'warn' : 'danger',
      title: 'GitLab refused the fetch',
      body: `origin answered, but did not accept this Mac's git credentials. ${tail}`,
      steps: [
        'Run git fetch in the repository on the Mac to see the prompt.',
        'Refresh the token or SSH key the repository uses.',
        'Retry.',
      ],
      raw: f.message,
      broken: 'origin',
    };
  }
  return {
    kind: stale ? 'stale' : 'fetch',
    tone: stale ? 'warn' : 'danger',
    title: 'Fetch from origin failed',
    body: `git fetch did not finish. ${tail}`,
    steps: ['Read the git output below.', 'Fix it on the Mac, then retry.'],
    raw: f.message,
    broken: 'origin',
  };
}

/** Maps a prep failure to what the dialog says. */
export function describeRunBranchError(e: unknown, branch: string): RunBranchIssue {
  const code = e instanceof ApiError ? e.code : '';
  const raw = describeError(e);
  switch (code) {
    case 'fetch_failed': {
      const f = fetchFailureOf(e instanceof ApiError ? e.details : null);
      return fromFetch(f ?? { reason: 'unknown', message: raw }, branch, false);
    }
    case 'branch_not_on_remote':
      return {
        kind: 'missing',
        tone: 'danger',
        title: 'Branch not on origin',
        body: `${branch} is neither on this Mac nor on origin. It was probably merged and deleted, or renamed.`,
        steps: ['Check the MR in GitLab.', 'Pick the branch it was merged into instead.'],
        raw,
        broken: 'origin',
      };
    case 'agent_unreachable':
      return {
        kind: 'agent',
        tone: 'danger',
        title: 'The Mac is not answering',
        body: 'Relay reaches the repository and devices through the host agent, and it is not running.',
        steps: [
          'On the Mac, run pnpm agent in the Relay folder.',
          'Retry once it says it is listening.',
        ],
        raw,
        broken: 'agent',
      };
    case 'agent_running':
      return {
        kind: 'busy',
        tone: 'warn',
        title: 'An agent is working there',
        body: 'An AI session is still running in this workspace. Switching branch would change its files mid-task.',
        steps: ['Open the Cockpit and stop the session (or let it finish).', 'Retry.'],
        raw,
        broken: 'workspace',
      };
    case 'branch_checked_out':
      return {
        kind: 'held',
        tone: 'warn',
        title: 'Branch held by another worktree',
        body: `${branch} is checked out in a worktree Relay does not know about, and git keeps a branch in one place only.`,
        steps: [
          'Add that worktree under Settings → Workspaces, or remove it with git worktree remove.',
          'Retry.',
        ],
        raw,
        broken: 'workspace',
      };
    case 'ws_dirty':
      return {
        kind: 'dirty',
        tone: 'warn',
        title: 'Uncommitted changes in the way',
        body: `The workspace has changes on its current branch. Keep or set them aside, and ${branch} is checked out right after.`,
        steps: [],
        raw: null,
        broken: 'workspace',
      };
    case 'no_workspace':
      return {
        kind: 'workspace',
        tone: 'warn',
        title: 'No local copy of this repo',
        body: 'Relay runs the app from a workspace on this Mac, and none holds this repository yet.',
        steps: ['Open Settings → Workspaces.', 'Add the folder where the repository is cloned.'],
        raw: null,
        broken: 'workspace',
      };
    default:
      return {
        kind: 'git',
        tone: 'danger',
        title: 'Could not switch branch',
        body: `Checking out ${branch} failed on the Mac.`,
        steps: ['Read the output below.', 'Fix it in the repository, then retry.'],
        raw,
        broken: 'workspace',
      };
  }
}

/** The stale-copy warning for a prep that worked without reaching origin. */
export const staleIssue = (f: FetchFailure, branch: string) => fromFetch(f, branch, true);
