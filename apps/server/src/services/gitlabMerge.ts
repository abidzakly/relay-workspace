import {
  evaluateMergeGate,
  type MergeGate,
  type MrStateEvent,
  type RepoConfig,
} from '@relay/shared';
import { GitlabClient } from './gitlab';
import { kindOf } from './gitlabDiscussions';
import { GIT_SHA_RE, mapRawMr, mrMergeCommitSha, type MrFields } from './gitlabMr';
import { GitlabApiError, type GitlabService } from './gitlabService';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';
import { readLiveStack, type BranchHeadsReader } from './mrStack';
import type { AppDb } from '../db';

/**
 * GitLab "Merge a merge request" (Merge button):
 *   `PUT /projects/:id/merge_requests/:iid/merge`  { sha? }
 * A WRITE: call only through `guardedWrite` (dry-run + audit), and only after the live merge gate passed.
 * Never retried (`GitlabClient.write`). Documented refusals (UNVERIFIED against the live instance):
 *   401/403 cannot merge · 405 (older) / 422 (newer) not mergeable (draft, closed, pipeline rule, …)
 *   406 conflicts · 409 `sha` does not match the source branch HEAD.
 * Errors carry kind + status + path only (never the token, headers or bodies).
 */

export interface MergeOutcome {
  /** The MR as GitLab returned it; null when the answer could not be mapped (the merge DID go through). */
  fields: MrFields | null;
  mergeCommitSha: string | null;
}

export class GitlabMergeApi {
  private readonly client: GitlabClient;

  constructor(
    host: string,
    token: string,
    private readonly projectId: number,
    http: HttpClient,
  ) {
    this.client = new GitlabClient(host, token, http);
  }

  /**
   * Merges with EXPLICIT options: never squash (commits stay cherry-pickable),
   * always delete the source branch. Project defaults are never relied on. `sha` pins the source HEAD that the gate
   * was evaluated on; it is sent only when it is a well-formed SHA.
   */
  async merge(iid: number, sha: string | null): Promise<MergeOutcome> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}/merge`;
    const body = {
      ...(sha && GIT_SHA_RE.test(sha) ? { sha } : {}),
      squash: false,
      should_remove_source_branch: true,
    };
    let res: HttpResponse;
    try {
      res = await this.client.write('PUT', path, body);
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new GitlabApiError(kindOf(res.status), res.status, path);
    }
    // A 2xx is a merge (or a merge GitLab accepted and is finishing): never turned into an error here.
    const m = mapRawMr(res.json);
    return { fields: m.ok ? m.value : null, mergeCommitSha: mrMergeCommitSha(res.json) };
  }

  /** `PUT …/merge_requests/:iid { squash: false }` ("Turn off squash"). A WRITE: only through `guardedWrite`. */
  async disableSquash(iid: number): Promise<MrFields | null> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}`;
    let res: HttpResponse;
    try {
      res = await this.client.write('PUT', path, { squash: false });
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new GitlabApiError(kindOf(res.status), res.status, path);
    }
    const m = mapRawMr(res.json);
    return m.ok ? m.value : null;
  }

  /** `PUT …/merge_requests/:iid { title }` (draft toggle via the `Draft:` prefix). A WRITE: only through `guardedWrite`. */
  async setTitle(iid: number, title: string): Promise<MrFields | null> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}`;
    let res: HttpResponse;
    try {
      res = await this.client.write('PUT', path, { title });
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new GitlabApiError(kindOf(res.status), res.status, path);
    }
    const m = mapRawMr(res.json);
    return m.ok ? m.value : null;
  }

  /**
   * `PUT …/merge_requests/:iid { state_event }`. A WRITE: only through `guardedWrite`. Returns the MR as GitLab reports
   * it afterwards: the caller must read its state, because a 2xx does not prove the event took effect.
   */
  async setOpenState(iid: number, event: MrStateEvent): Promise<MrFields | null> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}`;
    let res: HttpResponse;
    try {
      res = await this.client.write('PUT', path, { state_event: event });
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new GitlabApiError(kindOf(res.status), res.status, path);
    }
    const m = mapRawMr(res.json);
    return m.ok ? m.value : null;
  }
}

export interface LiveMergeGate {
  detail: { fields: MrFields; sha: string | null };
  gate: MergeGate;
}

/**
 * The server's merge gate: re-reads the MR and its approvals (per `approvalMode`, notes only where they are the source)
 * and applies the shared rule. Failing reads of approvals fail closed inside the gate; a failing MR read throws.
 */
export interface LiveGateOptions {
  /** Pushed branches without MR: their heads count as ancestors. */
  branchHeads?: BranchHeadsReader;
  /** Refreshes the cosmetic `mr_commits` cache with what was read. */
  store?: AppDb;
  repoId?: string;
}

export async function readLiveMergeGate(
  svc: GitlabService,
  repo: Pick<RepoConfig, 'approvalMode' | 'reviewers'>,
  iid: number,
  now: () => number,
  opts: LiveGateOptions = {},
): Promise<LiveMergeGate> {
  const detail = await svc.getMrDetailWithDescription(iid);
  const f = detail.fields;
  // Stack + squash, LIVE. Stack failures fail closed inside `readLiveStack`.
  const [stack, squashProject] = await Promise.all([
    readLiveStack(
      svc,
      { ...f, headSha: detail.sha ?? f.headSha ?? null },
      {
        ...(opts.branchHeads ? { branchHeads: opts.branchHeads } : {}),
        ...(opts.store && opts.repoId ? { store: opts.store, repoId: opts.repoId } : {}),
        now: now(),
      },
    ),
    svc.getProjectSquashOption().catch(() => null),
  ]);
  let notesError: string | null = null;
  let notes: Awaited<ReturnType<GitlabService['getNotes']>>['notes'] | undefined;
  if (repo.approvalMode === 'note_keyword') {
    try {
      notes = (await svc.getNotes(iid)).notes;
    } catch (e) {
      if (!(e instanceof GitlabApiError)) throw e;
      notesError = e.message;
    }
  }
  const approvals = await svc.getApprovals(iid, notes);
  const gate = evaluateMergeGate({
    source: 'live',
    checkedAt: now(),
    state: f.state,
    draft: f.draft,
    hasConflicts: f.hasConflicts,
    approvalMode: repo.approvalMode,
    approvals: {
      status: approvals.status,
      approvedBy: approvals.approvedBy,
      ...(notesError
        ? { message: `comments could not be read: ${notesError}` }
        : approvals.message
          ? { message: approvals.message }
          : {}),
    },
    reviewers: repo.reviewers,
    gitlabMergeStatus: f.mergeStatus,
    stack,
    squash: { mr: f.squash ?? null, project: squashProject },
  });
  return { detail, gate };
}

/** Lost answer: the merge may have happened. Re-reads once so a real merge is still treated (and audited) as one. */
export async function mergeConfirmingLostAnswer(
  api: GitlabMergeApi,
  svc: GitlabService,
  iid: number,
  sha: string | null,
): Promise<MergeOutcome> {
  try {
    return await api.merge(iid, sha);
  } catch (e) {
    if (!(e instanceof GitlabApiError) || e.kind !== 'network') throw e;
    const again = await svc.getMrDetail(iid).catch(() => null);
    if (again?.state === 'merged') return { fields: again, mergeCommitSha: null };
    throw e;
  }
}
