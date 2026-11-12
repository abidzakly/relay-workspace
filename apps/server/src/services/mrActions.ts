import {
  type MrApproveRequest,
  type MrApproveResult,
  type MergeBlockedDetails,
  type MergeGate,
  type MrDraftEvent,
  type MrDraftResult,
  type MrMergeResult,
  type MrNoteRequest,
  type MrNoteResult,
  type MrUploadRequest,
  type MrUploadResult,
  UPLOAD_IMAGE_MAX_BYTES,
  type MrReplyRequest,
  type MrReplyResult,
  type MrResolveRequest,
  type MrResolveResult,
  type MrStateChangeResult,
  type MrStateEvent,
  type ReviewCommentRequest,
  type ReviewCommentResult,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { guardedWrite } from './dryRun';
import { GitlabApproveApi } from './gitlabApprove';
import { GitlabDiscussionsApi, type LiveDiscussion } from './gitlabDiscussions';
import {
  GitlabMergeApi,
  mergeConfirmingLostAnswer,
  readLiveMergeGate,
  type MergeOutcome,
} from './gitlabMerge';
import { titleWithDraft } from './gitlabMr';
import { GitlabApiError, GitlabService } from './gitlabService';
import type { HttpClient } from './httpClient';
import { sniffImage } from './imageSniff';
import type { UndoHandler } from './undoEngine';
import { extRepoConfig, isExtRepo, repoOrExt, reviewerIdentity } from './reviewTarget';
import {
  applyDiscussionNotes,
  getCachedDiscussionNotes,
  getCachedMr,
  insertOwnNote,
  upsertMrSummaries,
} from './mrStore';

/**
 * MR discussion writes: reply and resolve/unresolve, plus the undo of a resolve.
 *
 * Every GitLab WRITE goes through `guardedWrite` (explicit user click -> `confirmed: true`, global
 * dry-run honoured, audit row with before/after). Dry-run makes NO network call at all (not even a
 * read): the "before" state then comes from the local cache and the row is flagged `dryRun`.
 *  - `mr.reply`   : audited, NOT undoable (a posted comment cannot be taken back from here).
 *  - `mr.resolve` : audited, undoable (`undo` restores the previous resolved state).
 * The UI is cosmetic: nothing here trusts the browser's idea of the thread state when live.
 */

export class MrActionError extends ActionError {
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'MrActionError';
  }
}

export interface MrActionsDeps {
  config: ConfigStore;
  audit: AuditWriter;
  /** Local cache DB. */
  store: AppDb;
  http: HttpClient;
  log: Logger;
  bus?: EventBus;
  now?: () => number;
  /** Pushed branches without MR (`branch_pushes`) for the stack check. */
  branchHeads?: (repoId: string) => Promise<readonly { branch: string; sha: string }[]>;
}

/** Audited text is user content: clipped (the full text lives in GitLab). */
const AUDIT_BODY_MAX = 2000;

const TARGET_RE = /^([a-z0-9][a-z0-9-]{0,62})!(\d+)$/;
export const mrTargetId = (repoId: string, iid: number): string => `${repoId}!${iid}`;

export function mapGitlabError(e: unknown): never {
  if (e instanceof GitlabApiError) {
    const status =
      e.kind === 'not_found'
        ? 404
        : e.kind === 'rate_limited'
          ? 429
          : e.kind === 'bad_request'
            ? 422
            : 502;
    // The message carries kind/status/path only (never token, headers or bodies).
    throw new MrActionError(status, `gitlab_${e.kind}`, e.message);
  }
  throw e;
}

/** 409 `merge_blocked`: the live gate refused. `details.gate` carries the machine-readable reasons. */
export function mergeBlockedError(gate: MergeGate): MrActionError {
  return new MrActionError(409, 'merge_blocked', gate.reasons.map((r) => r.message).join(' '), {
    gate,
  } satisfies MergeBlockedDetails);
}

/**
 * GitLab's refusals of `PUT …/merge` (documented, UNVERIFIED live) become precise codes; everything else
 * goes through `mapGitlabError`. Messages never carry the token, headers or bodies.
 */
export function mapMergeError(e: unknown): never {
  if (e instanceof GitlabApiError && e.path.endsWith('/merge')) {
    const s = e.status;
    if (s === 401 || s === 403) {
      throw new MrActionError(
        403,
        'gitlab_forbidden',
        `GitLab refused: this repo's token may not merge this MR (needs Developer+ and "api" scope). ${e.message}`,
      );
    }
    if (s === 405 || s === 422) {
      throw new MrActionError(
        409,
        'gitlab_not_mergeable',
        `GitLab refused the merge by its own project rules (pipeline must succeed, approval rules, branch protection…). Open the MR in GitLab to see why. ${e.message}`,
      );
    }
    if (s === 406) {
      throw new MrActionError(
        409,
        'gitlab_conflicts',
        `GitLab refused: merge conflicts. ${e.message}`,
      );
    }
    if (s === 409) {
      throw new MrActionError(
        409,
        'gitlab_sha_changed',
        'A new commit landed on the source branch after the check. Review it, then merge again.',
      );
    }
    if (e.kind === 'network') {
      throw new MrActionError(
        502,
        'gitlab_network',
        'GitLab did not answer the merge and a re-read could not confirm it. Refresh before trying again.',
      );
    }
  }
  return mapGitlabError(e);
}

/**
 * GitLab's refusals of an approval write. `POST …/approve` answers 401 when the user already approved or may not
 * approve (self-approval off, not an eligible approver): that is a refusal, not a broken token.
 */
export function mapApproveError(e: unknown): never {
  if (e instanceof GitlabApiError && e.status !== undefined && [401, 403, 405].includes(e.status)) {
    throw new MrActionError(
      403,
      'gitlab_refused',
      `GitLab refused the approval: this account may not approve this MR (already approved, author, or not an eligible approver). ${e.message}`,
    );
  }
  return mapGitlabError(e);
}

/** GitLab's refusals of a close / reopen. Reopening can also be refused because of the source branch. */
export function mapStateChangeError(e: unknown, event: MrStateEvent): never {
  if (e instanceof GitlabApiError && e.status !== undefined) {
    if (e.status === 401 || e.status === 403) {
      throw new MrActionError(
        403,
        'gitlab_forbidden',
        `GitLab refused: this repo's token may not ${event} this MR. ${e.message}`,
      );
    }
    if (e.status === 405 || e.status === 409 || e.status === 422) {
      throw new MrActionError(
        409,
        'gitlab_refused',
        event === 'reopen'
          ? `GitLab refused to reopen this MR: its source branch may be gone, or another open MR may use it. ${e.message}`
          : `GitLab refused to close this MR. ${e.message}`,
      );
    }
  }
  return mapGitlabError(e);
}

export class MrActions {
  /** `<repo>!<iid>` of merges in flight: a double click or a second tab must not send two merges. */
  private readonly merging = new Set<string>();

  constructor(private readonly d: MrActionsDeps) {}

  private context(repoId: string, iid: number) {
    // `~<projectId>` (Reviews): nothing is cached for such a project, GitLab itself is the source.
    if (isExtRepo(repoId)) {
      const ext = extRepoConfig(this.d.config, repoId);
      if (!ext) {
        throw new MrActionError(
          409,
          'reviewer_token_missing',
          'Save a personal GitLab token in Settings > Connections > Reviewer access first.',
        );
      }
      return ext;
    }
    const repo = this.d.config.getRepo(repoId);
    if (!repo) throw new MrActionError(404, 'repo_not_found', 'Unknown repository');
    if (!getCachedMr(this.d.store, repoId, iid)) {
      throw new MrActionError(
        404,
        'mr_not_found',
        'This MR is not in the local cache (not synced yet)',
      );
    }
    return repo;
  }

  /** Only called when a network call is actually about to happen (never in dry-run). */
  private api(repoId: string): GitlabDiscussionsApi {
    const repo = repoOrExt(this.d.config, repoId);
    const host = this.d.config.getGlobal().gitlab.host;
    if (!repo || !host) {
      throw new MrActionError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
    return new GitlabDiscussionsApi(
      host,
      repo.gitlab.token,
      repo.gitlab.projectId,
      repoId,
      this.d.http,
    );
  }

  /** Cached thread state, or null when the thread is not cached. */
  private cachedThread(
    repoId: string,
    iid: number,
    discussionId: string,
  ): { resolvable: boolean; resolved: boolean; noteCount: number } | null {
    const notes = getCachedDiscussionNotes(this.d.store, repoId, iid, discussionId);
    if (notes.length === 0) return null;
    const resolvable = notes.filter((n) => n.resolvable);
    return {
      resolvable: resolvable.length > 0,
      resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
      noteCount: notes.length,
    };
  }

  private changed(repoId: string, iid: number): void {
    try {
      this.d.bus?.emit({ type: 'mrs.changed', repoId, iids: [iid] });
    } catch {
      /* a bus problem must never fail an audited write */
    }
  }

  async reply(repoId: string, iid: number, req: MrReplyRequest): Promise<MrReplyResult> {
    this.context(repoId, iid);
    const dry = this.d.config.isDryRun();
    const api = dry ? null : this.api(repoId);
    const cached = this.cachedThread(repoId, iid, req.discussionId);
    const body = req.body.trim();

    try {
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.reply',
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          // Reached only from the user's click on "Reply".
          confirmed: true,
          before: { discussionId: req.discussionId, notes: cached?.noteCount ?? null },
          after: {
            discussionId: req.discussionId,
            noteId: null,
            body: body.slice(0, AUDIT_BODY_MAX),
          },
          // A posted comment is not undone from here.
          reversible: false,
          afterResult: (note) => ({
            discussionId: req.discussionId,
            noteId: note?.noteId ?? null,
            body: body.slice(0, AUDIT_BODY_MAX),
          }),
          run: () => api!.reply(iid, req.discussionId, body),
        },
      );
      const note = out.result ?? null;
      if (!out.dryRun) {
        if (note && !isExtRepo(repoId)) insertOwnNote(this.d.store, note);
        this.changed(repoId, iid);
      }
      return {
        dryRun: out.dryRun,
        auditId: out.audit.id,
        discussionId: req.discussionId,
        note: note
          ? {
              id: note.noteId,
              author: note.author,
              body: note.body,
              createdAt: note.createdAt,
              unread: false,
            }
          : null,
      };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  /**
   * A new thread on a diff line (Code Reviewer). Audited, NOT undoable. Live: the MR's `diff_refs` are read right
   * before the write so the comment lands on the current version; dry-run makes no network call.
   */
  async comment(
    repoId: string,
    iid: number,
    req: ReviewCommentRequest,
  ): Promise<ReviewCommentResult> {
    this.context(repoId, iid);
    const dry = this.d.config.isDryRun();
    const api = dry ? null : this.api(repoId);
    const body = req.body.trim();
    const pos = req.position;
    const refs = api ? await api.diffRefs(iid).catch(mapGitlabError) : null;
    // The reviewer read an older version: its line numbers may now point at other code.
    if (refs && req.headSha && refs.headSha.toLowerCase() !== req.headSha.toLowerCase()) {
      throw new MrActionError(
        409,
        'diff_changed',
        'This MR changed since you opened it. Reload the review to comment on the current version.',
      );
    }
    try {
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.comment',
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          // Reached only from the user's click on "Comment" in the Code Reviewer.
          confirmed: true,
          before: { discussionId: null },
          after: {
            discussionId: null,
            path: pos.path,
            newLine: pos.newLine,
            oldLine: pos.oldLine,
            headSha: refs?.headSha ?? null,
            body: body.slice(0, AUDIT_BODY_MAX),
          },
          reversible: false,
          afterResult: (d) => ({
            discussionId: d?.id ?? null,
            path: pos.path,
            newLine: pos.newLine,
            oldLine: pos.oldLine,
            headSha: refs?.headSha ?? null,
            body: body.slice(0, AUDIT_BODY_MAX),
          }),
          run: () => api!.createDiffThread(iid, refs!, pos, body),
        },
      );
      if (!out.dryRun) this.changed(repoId, iid);
      return { dryRun: out.dryRun, auditId: out.audit.id, discussion: out.result ?? null };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  /** A new top-level comment on the MR. Audited, NOT undoable. */
  async note(repoId: string, iid: number, req: MrNoteRequest): Promise<MrNoteResult> {
    this.context(repoId, iid);
    const dry = this.d.config.isDryRun();
    const api = dry ? null : this.api(repoId);
    const body = req.body.trim();
    try {
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.note',
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          // Reached only from the user's click on "Comment" in the MR drawer.
          confirmed: true,
          before: { discussionId: null },
          after: { discussionId: null, body: body.slice(0, AUDIT_BODY_MAX) },
          reversible: false,
          afterResult: (d) => ({
            discussionId: d?.id ?? null,
            body: body.slice(0, AUDIT_BODY_MAX),
          }),
          run: () => api!.createNote(iid, body),
        },
      );
      const d = out.result ?? null;
      const n = d?.notes[0] ?? null;
      if (!out.dryRun) {
        if (n && !isExtRepo(repoId)) insertOwnNote(this.d.store, n);
        this.changed(repoId, iid);
      }
      return {
        dryRun: out.dryRun,
        auditId: out.audit.id,
        discussionId: d?.id ?? null,
        note: n
          ? { id: n.noteId, author: n.author, body: n.body, createdAt: n.createdAt, unread: false }
          : null,
      };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  /**
   * An image for a comment, uploaded to the MR's project. Audited (name, type and size only), NOT undoable. The
   * bytes must really be the declared image type: a renamed file is refused before anything is sent.
   */
  async upload(repoId: string, iid: number, req: MrUploadRequest): Promise<MrUploadResult> {
    this.context(repoId, iid);
    const bytes = Buffer.from(req.data, 'base64');
    if (bytes.length === 0 || bytes.length > UPLOAD_IMAGE_MAX_BYTES) {
      throw new MrActionError(400, 'invalid_image', 'The image is empty or larger than 5 MB');
    }
    if (sniffImage(bytes) !== req.type) {
      throw new MrActionError(
        400,
        'invalid_image',
        'The file is not a PNG, JPEG, GIF or WebP image',
      );
    }
    const dry = this.d.config.isDryRun();
    const api = dry ? null : this.api(repoId);
    const info = { filename: req.filename, type: req.type, bytes: bytes.length };
    try {
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.upload',
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          // Reached only from the user attaching an image in a comment box.
          confirmed: true,
          before: null,
          after: info,
          reversible: false,
          afterResult: (md) => ({ ...info, markdown: md }),
          run: () => api!.upload(req.filename, req.type, bytes),
        },
      );
      return { dryRun: out.dryRun, auditId: out.audit.id, markdown: out.result ?? null };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  async resolve(repoId: string, iid: number, req: MrResolveRequest): Promise<MrResolveResult> {
    this.context(repoId, iid);
    return this.setResolved(repoId, iid, req.discussionId, req.resolved, {
      action: 'mr.resolve',
      // The undo handler finds threads in the cache; a Reviews project has none.
      reversible: !isExtRepo(repoId),
      undoOf: null,
    });
  }

  /**
   * One resolve/unresolve write. `before` is read LIVE when the write is real (the browser's view may be
   * stale) and from the cache in dry-run (no network call).
   */
  private async setResolved(
    repoId: string,
    iid: number,
    discussionId: string,
    resolved: boolean,
    o: { action: string; reversible: boolean; undoOf: number | null },
  ): Promise<MrResolveResult> {
    const dry = this.d.config.isDryRun();
    const api = dry ? null : this.api(repoId);
    try {
      let beforeState: { resolvable: boolean; resolved: boolean } | null;
      if (api) {
        const live: LiveDiscussion = await api.get(iid, discussionId);
        beforeState = { resolvable: live.resolvable, resolved: live.resolved };
      } else {
        beforeState = this.cachedThread(repoId, iid, discussionId);
      }
      if (beforeState && !beforeState.resolvable) {
        throw new MrActionError(409, 'not_resolvable', 'This thread cannot be resolved');
      }
      if (beforeState && beforeState.resolved === resolved) {
        throw new MrActionError(
          409,
          'no_change',
          `The thread is already ${resolved ? 'resolved' : 'unresolved'}`,
        );
      }

      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: o.action,
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          confirmed: true,
          before: { discussionId, resolved: beforeState?.resolved ?? null },
          after: { discussionId, resolved },
          reversible: o.reversible,
          undoOf: o.undoOf,
          afterResult: (live) => ({ discussionId, resolved: live?.resolved ?? resolved }),
          run: () => api!.setResolved(iid, discussionId, resolved),
        },
      );
      const live = out.result ?? null;
      if (!out.dryRun) {
        if (live && !isExtRepo(repoId)) applyDiscussionNotes(this.d.store, live.notes);
        this.changed(repoId, iid);
      }
      return {
        dryRun: out.dryRun,
        auditId: out.audit.id,
        discussionId,
        resolved: live?.resolved ?? resolved,
        undoable: out.audit.undoToken !== null,
      };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  /**
   * Approve / revoke my approval (Code Reviewer), the way the repo counts approvals (`approvalMode`), so the merge gate
   * reads back exactly what was written. Audited (`mr.approve` / `mr.unapprove`), NOT undoable from the audit log
   * (the opposite action is one click away in the reviewer). Live: the current approvers are re-read first, so a stale
   * page cannot approve twice; dry-run makes no network call and trusts the cache.
   */
  async approve(repoId: string, iid: number, req: MrApproveRequest): Promise<MrApproveResult> {
    const repo = this.context(repoId, iid);
    const ext = isExtRepo(repoId);
    // On a Reviews project "me" is the reviewer token's user.
    const me =
      (ext ? reviewerIdentity(this.d.config)?.username : undefined) ??
      this.d.config.getGlobal().gitlab.myUsername;
    if (!me) {
      throw new MrActionError(
        409,
        'identity_missing',
        'Set your GitLab username in Settings to approve from here.',
      );
    }
    const cached = ext
      ? await this.liveSummary(repoId, iid)
      : getCachedMr(this.d.store, repoId, iid)!;
    const same = (u: string | null | undefined) => !!u && u.toLowerCase() === me.toLowerCase();
    if (same(cached.author)) {
      throw new MrActionError(403, 'own_mr', 'You cannot approve your own MR.');
    }
    if (cached.state !== 'opened') {
      throw new MrActionError(409, 'mr_not_open', 'Only an open MR can be approved.');
    }
    const mode = repo.approvalMode;
    if (!req.approved && mode === 'note_keyword') {
      throw new MrActionError(
        409,
        'not_revocable',
        'This repo counts "Approved" notes as approvals: delete the note in GitLab to take it back.',
      );
    }

    const dry = this.d.config.isDryRun();
    const host = this.d.config.getGlobal().gitlab.host;
    if (!dry && !host) {
      throw new MrActionError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
    const api = dry
      ? null
      : new GitlabApproveApi(host!, repo.gitlab.token, repo.gitlab.projectId, this.d.http);
    let svc: GitlabService | null = null;
    try {
      // ── before: live approvers when the write is real (the browser's view may be stale).
      let approvedBefore = cached.approvedBy.some(same);
      if (!dry) {
        svc = GitlabService.forRepo(this.d.config, repoId, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
        if (mode !== 'note_keyword') {
          const live = await svc.getApprovals(iid);
          if (live.status === 'ok') approvedBefore = live.approvedBy.some(same);
        }
      }
      if (approvedBefore === req.approved) {
        throw new MrActionError(
          409,
          'no_change',
          req.approved ? 'You already approved this MR.' : 'You have not approved this MR.',
        );
      }
      const awardId =
        api && !req.approved && mode === 'award_emoji' ? await api.myAward(iid, me) : null;
      if (api && !req.approved && mode === 'award_emoji' && awardId === null) {
        throw new MrActionError(409, 'no_change', 'You have not approved this MR.');
      }

      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: req.approved ? 'mr.approve' : 'mr.unapprove',
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          // Reached only from the user's confirmed click in the Code Reviewer.
          confirmed: true,
          before: { approvedByMe: approvedBefore, mode },
          after: { approvedByMe: req.approved, mode },
          reversible: false,
          run: () => (req.approved ? api!.approve(iid, mode) : api!.revoke(iid, mode, awardId)),
        },
      );
      if (!out.dryRun) {
        this.changed(repoId, iid);
        // Approvers are re-read in the background so the inbox, the gate and the reviewer agree.
        // A Reviews project is never cached: the desk re-reads it instead.
        void (ext ? null : svc)
          ?.syncMr(iid)
          .then(() => this.changed(repoId, iid))
          .catch((e: unknown) =>
            this.d.log.warn(
              { repo: repoId, iid, err: e instanceof GitlabApiError ? e.message : 'error' },
              'post-approval refresh failed (the next sync will catch up)',
            ),
          );
      }
      return { dryRun: out.dryRun, auditId: out.audit.id, approved: req.approved, mode };
    } catch (e) {
      if (e instanceof MrActionError) throw e;
      return mapApproveError(e);
    }
  }

  /** Author, state and approvers read live: a Reviews project has no cache row. GETs only, so dry-run reads too. */
  private async liveSummary(
    repoId: string,
    iid: number,
  ): Promise<{ author: string | null; state: string; approvedBy: string[] }> {
    try {
      const svc = GitlabService.forRepo(this.d.config, repoId, {
        http: this.d.http,
        store: this.d.store,
        log: this.d.log,
      });
      const [f, approvals] = await Promise.all([svc.getMrDetail(iid), svc.getApprovals(iid)]);
      return {
        author: f.author,
        state: f.state,
        approvedBy: approvals.status === 'ok' ? approvals.approvedBy : [],
      };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  /**
   * Merge. SERVER-AUTHORITATIVE: whatever the browser showed,
   * the MR and its approvals are re-fetched LIVE here, at click time, and the shared `evaluateMergeGate`
   * decides. Refused -> 409 `merge_blocked` with `details.gate` (machine-readable reasons).
   *
   * Reads happen in dry-run too (they are GETs, not writes) so the gate can be tried safely; only the merge
   * PUT is simulated. The PUT pins the source HEAD the gate saw (`sha`), so a commit pushed in between
   * makes GitLab refuse (`gitlab_sha_changed`). Audited as `mr.merge`, NOT undoable (a merge is reverted
   * with a revert commit/MR, not from here).
   */
  async merge(repoId: string, iid: number): Promise<MrMergeResult> {
    const repo = this.context(repoId, iid);
    const key = mrTargetId(repoId, iid);
    if (this.merging.has(key)) {
      throw new MrActionError(409, 'merge_in_progress', 'A merge of this MR is already running');
    }
    this.merging.add(key);
    try {
      const now = this.d.now ?? Date.now;
      let svc: GitlabService;
      try {
        svc = GitlabService.forRepo(this.d.config, repoId, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
      } catch {
        // forRepo only fails for an unknown repo (checked above) or a missing host.
        throw new MrActionError(409, 'gitlab_not_configured', 'GitLab host is not configured');
      }

      // ── live re-fetch: MR detail, then approvals per approvalMode.
      const { detail, gate } = await readLiveMergeGate(svc, repo, iid, now, {
        store: this.d.store,
        repoId,
        ...(this.d.branchHeads ? { branchHeads: () => this.d.branchHeads!(repoId) } : {}),
      }).catch(mapGitlabError);
      const f = detail.fields;
      if (!gate.allowed) {
        this.d.log.info(
          { repo: repoId, iid, reasons: gate.reasons.map((r) => r.code) },
          'merge refused by the live merge gate',
        );
        throw mergeBlockedError(gate);
      }

      // ── the write. Built lazily: in dry-run no write client is even constructed.
      const host = this.d.config.getGlobal().gitlab.host!;
      const run = (): Promise<MergeOutcome> =>
        mergeConfirmingLostAnswer(
          new GitlabMergeApi(host, repo.gitlab.token, repo.gitlab.projectId, this.d.http),
          svc,
          iid,
          detail.sha,
        );

      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.merge',
          targetType: 'mr',
          targetId: key,
          // Reached only from the user's confirmed click on "Merge".
          confirmed: true,
          before: {
            state: f.state,
            draft: f.draft,
            hasConflicts: f.hasConflicts,
            sha: detail.sha,
            approvalMode: gate.approvalMode,
            approvedBy: gate.approvedBy,
            approvingReviewers: gate.approvingReviewers,
            gitlabMergeStatus: gate.gitlabMergeStatus,
          },
          after: { state: 'merged', mergeCommitSha: null },
          reversible: false,
          afterResult: (r) => ({
            state: r.fields?.state ?? null,
            mergedAt: r.fields?.mergedAt ?? null,
            mergeCommitSha: r.mergeCommitSha,
          }),
          run,
        },
      ).catch(mapMergeError);

      const res = out.dryRun ? null : out.result;
      if (res) {
        if (res.fields) upsertMrSummaries(this.d.store, repoId, [res.fields], now());
        this.changed(repoId, iid);
        // The cache now says merged, so GitLab's webhook for this merge will not qualify as news.
        if (res.fields?.state === 'merged') {
          try {
            this.d.bus?.emit({ type: 'mr.activity', repoId, iid, activity: 'merge' });
          } catch {
            /* a bus problem must never fail an audited write */
          }
        }
        // Full refresh (approvals, notes, pipeline) in the background; the merge result does not wait.
        void svc
          .syncMr(iid)
          .then(() => this.changed(repoId, iid))
          .catch((e: unknown) =>
            this.d.log.warn(
              { repo: repoId, iid, err: e instanceof GitlabApiError ? e.message : 'error' },
              'post-merge refresh failed (the next sync will catch up)',
            ),
          );
      }
      return {
        dryRun: out.dryRun,
        auditId: out.audit.id,
        gate,
        merged: res?.fields?.state === 'merged',
        state: res?.fields?.state ?? null,
        mergeCommitSha: res?.mergeCommitSha ?? null,
      };
    } finally {
      this.merging.delete(key);
    }
  }

  /**
   * Close / reopen, like GitLab's own buttons. The state is re-read live first (in dry-run too, like the merge gate),
   * and a state that already moved refuses with 409 `mr_state_changed`. Audited as `mr.close` / `mr.reopen`, not
   * undoable: the opposite action is one click away. GitLab can answer 2xx without applying the event, so `applied`
   * comes from the state it reports back.
   */
  async setOpenState(
    repoId: string,
    iid: number,
    event: MrStateEvent,
  ): Promise<MrStateChangeResult> {
    const repo = this.context(repoId, iid);
    const key = mrTargetId(repoId, iid);
    if (this.merging.has(key)) {
      throw new MrActionError(409, 'mr_action_in_progress', 'Another action on this MR is running');
    }
    this.merging.add(key);
    try {
      const now = this.d.now ?? Date.now;
      let svc: GitlabService;
      try {
        svc = GitlabService.forRepo(this.d.config, repoId, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
      } catch {
        throw new MrActionError(409, 'gitlab_not_configured', 'GitLab host is not configured');
      }
      const live = await svc.getMrDetail(iid).catch(mapGitlabError);
      const from = event === 'close' ? 'opened' : 'closed';
      const to = event === 'close' ? 'closed' : 'opened';
      if (live.state !== from) {
        upsertMrSummaries(this.d.store, repoId, [live], now());
        this.changed(repoId, iid);
        throw new MrActionError(
          409,
          'mr_state_changed',
          `This MR is ${live.state} in GitLab, so it cannot be ${event === 'close' ? 'closed' : 'reopened'}. The page has been refreshed.`,
        );
      }
      const host = this.d.config.getGlobal().gitlab.host!;
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: `mr.${event}`,
          targetType: 'mr',
          targetId: key,
          // Reached only from the user's confirmed click.
          confirmed: true,
          before: { state: live.state },
          after: { state: to },
          reversible: false,
          afterResult: (r) => ({ state: r?.state ?? null }),
          run: () =>
            new GitlabMergeApi(
              host,
              repo.gitlab.token,
              repo.gitlab.projectId,
              this.d.http,
            ).setOpenState(iid, event),
        },
      ).catch((e: unknown) => mapStateChangeError(e, event));

      if (out.dryRun) {
        return { dryRun: true, auditId: out.audit.id, event, applied: false };
      }
      const fields = out.result;
      if (fields) upsertMrSummaries(this.d.store, repoId, [fields], now());
      this.changed(repoId, iid);
      void svc
        .syncMr(iid)
        .then(() => this.changed(repoId, iid))
        .catch((e: unknown) =>
          this.d.log.warn(
            { repo: repoId, iid, err: e instanceof GitlabApiError ? e.message : 'error' },
            'post-state-change refresh failed (the next sync will catch up)',
          ),
        );
      return { dryRun: false, auditId: out.audit.id, event, applied: fields?.state === to };
    } finally {
      this.merging.delete(key);
    }
  }

  /**
   * Set draft / mark ready: rewrites the `Draft:` title prefix (GitLab's own mechanism). Live re-read first; 409
   * `mr_state_changed` when the MR is not open or already in the requested draft state. Audited `mr.draft` / `mr.ready`.
   */
  async setDraft(repoId: string, iid: number, event: MrDraftEvent): Promise<MrDraftResult> {
    const repo = this.context(repoId, iid);
    const key = mrTargetId(repoId, iid);
    if (this.merging.has(key)) {
      throw new MrActionError(409, 'mr_action_in_progress', 'Another action on this MR is running');
    }
    this.merging.add(key);
    try {
      const now = this.d.now ?? Date.now;
      let svc: GitlabService;
      try {
        svc = GitlabService.forRepo(this.d.config, repoId, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
      } catch {
        throw new MrActionError(409, 'gitlab_not_configured', 'GitLab host is not configured');
      }
      const live = await svc.getMrDetail(iid).catch(mapGitlabError);
      const wantDraft = event === 'draft';
      if (live.state !== 'opened' || live.draft === wantDraft) {
        upsertMrSummaries(this.d.store, repoId, [live], now());
        this.changed(repoId, iid);
        throw new MrActionError(
          409,
          'mr_state_changed',
          live.state !== 'opened'
            ? `This MR is ${live.state} in GitLab, so its draft state cannot change. The page has been refreshed.`
            : `This MR is already ${live.draft ? 'a draft' : 'ready for review'} in GitLab. The page has been refreshed.`,
        );
      }
      const title = titleWithDraft(live.title, wantDraft);
      const host = this.d.config.getGlobal().gitlab.host!;
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: `mr.${event}`,
          targetType: 'mr',
          targetId: key,
          confirmed: true,
          before: { draft: live.draft, title: live.title },
          after: { draft: wantDraft, title },
          reversible: false,
          afterResult: (r) => ({ draft: r?.draft ?? null }),
          run: () =>
            new GitlabMergeApi(
              host,
              repo.gitlab.token,
              repo.gitlab.projectId,
              this.d.http,
            ).setTitle(iid, title),
        },
      ).catch(mapGitlabError);

      if (out.dryRun) return { dryRun: true, auditId: out.audit.id, event, applied: false };
      const fields = out.result;
      if (fields) upsertMrSummaries(this.d.store, repoId, [fields], now());
      this.changed(repoId, iid);
      void svc
        .syncMr(iid)
        .then(() => this.changed(repoId, iid))
        .catch((e: unknown) =>
          this.d.log.warn(
            { repo: repoId, iid, err: e instanceof GitlabApiError ? e.message : 'error' },
            'post-draft refresh failed (the next sync will catch up)',
          ),
        );
      return { dryRun: false, auditId: out.audit.id, event, applied: fields?.draft === wantDraft };
    } finally {
      this.merging.delete(key);
    }
  }

  /**
   * "Turn off squash": `PUT …/merge_requests/:iid { squash: false }`. Audited (`mr.squash_off`), not undoable
   * from here (turning squash back on is exactly what we never want).
   */
  async disableSquash(repoId: string, iid: number): Promise<{ dryRun: boolean; auditId: number }> {
    const repo = this.context(repoId, iid);
    const host = this.d.config.getGlobal().gitlab.host;
    const dry = this.d.config.isDryRun();
    if (!dry && !host) {
      throw new MrActionError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
    try {
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.squash_off',
          targetType: 'mr',
          targetId: mrTargetId(repoId, iid),
          confirmed: true,
          before: { squash: true },
          after: { squash: false },
          reversible: false,
          run: () =>
            new GitlabMergeApi(
              host!,
              repo.gitlab.token,
              repo.gitlab.projectId,
              this.d.http,
            ).disableSquash(iid),
        },
      );
      if (!out.dryRun) this.changed(repoId, iid);
      return { dryRun: out.dryRun, auditId: out.audit.id };
    } catch (e) {
      return mapGitlabError(e);
    }
  }

  /**
   * Undo handler for `mr.resolve` (registered with the `UndoEngine`, which owns the shared checks and the
   * `undone_at` stamp). Re-applies `before.resolved` through `guardedWrite`; its own `undo` audit row carries
   * `undoOf`. A simulated undo changes nothing, so the original stays undoable.
   */
  readonly resolveUndoHandler: UndoHandler = {
    action: 'mr.resolve',
    undo: async (entry) => {
      const target = TARGET_RE.exec(entry.targetId);
      const before = entry.before as { discussionId?: unknown; resolved?: unknown } | null;
      if (
        !target ||
        !before ||
        typeof before.discussionId !== 'string' ||
        typeof before.resolved !== 'boolean'
      ) {
        throw new MrActionError(409, 'undo_unsupported', 'The audit entry has no restorable state');
      }
      const repoId = target[1]!;
      const iid = Number(target[2]);
      this.context(repoId, iid);

      const res = await this.setResolved(repoId, iid, before.discussionId, before.resolved, {
        action: 'undo',
        reversible: false,
        undoOf: entry.id,
      });
      return { dryRun: res.dryRun, auditId: res.auditId };
    },
  };
}
