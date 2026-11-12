import type { DiffRefs, Note, ReviewDiscussion, ReviewPosition } from '@relay/shared';
import { DISCUSSION_ID_RE } from '@relay/shared';
import { GitlabClient } from './gitlab';
import { mapDiscussions } from './gitlabMr';
import { mapReviewDiscussion, mrDiffRefs } from './gitlabReview';
import { GitlabApiError, type GitlabErrorKind } from './gitlabService';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';

/**
 * GitLab MR Discussions API:
 *  - `GET  /projects/:id/merge_requests/:iid/discussions/:discussion_id`               (read)
 *  - `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes` {body}  (WRITE: reply)
 *  - `PUT  /projects/:id/merge_requests/:iid/discussions/:discussion_id` {resolved}    (WRITE: resolve)
 * Shapes follow GitLab's documented REST v4 and are UNVERIFIED against the live instance (no sample was
 * attached) (no live sample was checked). Writes are never retried (`GitlabClient.write`) and must only be called from a
 * `guardedWrite` (dry-run + audit). Errors never carry the token, headers or bodies.
 */

const pathOnly = (p: string) => p.split('?')[0] ?? p;

export function kindOf(status: number): GitlabErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'bad_response';
}

/** One discussion mapped to our notes, plus its thread-level resolve state. */
export interface LiveDiscussion {
  id: string;
  notes: Note[];
  /** A thread is resolvable when any of its notes is. */
  resolvable: boolean;
  /** Resolved when every resolvable note is resolved (GitLab's own definition). */
  resolved: boolean;
}

function toLiveDiscussion(id: string, notes: Note[]): LiveDiscussion {
  const resolvable = notes.filter((n) => n.resolvable);
  return {
    id,
    notes,
    resolvable: resolvable.length > 0,
    resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
  };
}

export class GitlabDiscussionsApi {
  private readonly client: GitlabClient;

  constructor(
    host: string,
    token: string,
    private readonly projectId: number,
    private readonly repoId: string,
    http: HttpClient,
  ) {
    this.client = new GitlabClient(host, token, http);
  }

  private base(iid: number, discussionId: string): string {
    // Defence in depth: the route already validated both, but a path segment must never be free text.
    if (!Number.isInteger(iid) || iid <= 0 || !DISCUSSION_ID_RE.test(discussionId)) {
      throw new Error('invalid MR iid or discussion id');
    }
    return `/projects/${this.projectId}/merge_requests/${iid}/discussions/${discussionId}`;
  }

  private async call(fn: () => Promise<HttpResponse>, path: string): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await fn();
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
    if (res.status >= 200 && res.status < 300) return res;
    throw new GitlabApiError(kindOf(res.status), res.status, path);
  }

  private mapOne(iid: number, discussionId: string, raw: unknown, path: string): LiveDiscussion {
    const mapped = mapDiscussions(this.repoId, iid, [raw]);
    const id = (raw as { id?: unknown } | null)?.id;
    if (!mapped || id !== discussionId) throw new GitlabApiError('bad_response', 200, path);
    return toLiveDiscussion(discussionId, mapped.notes);
  }

  /** Current state of one thread (read). */
  async get(iid: number, discussionId: string): Promise<LiveDiscussion> {
    const path = this.base(iid, discussionId);
    const res = await this.call(() => this.client.get(path), path);
    return this.mapOne(iid, discussionId, res.json, path);
  }

  /**
   * Adds a note to an existing thread. A WRITE: call only through `guardedWrite`.
   * Returns the created note, or null when GitLab's answer could not be mapped (the note WAS created).
   */
  async reply(iid: number, discussionId: string, body: string): Promise<Note | null> {
    const path = `${this.base(iid, discussionId)}/notes`;
    const res = await this.call(() => this.client.write('POST', path, { body }), path);
    const mapped = mapDiscussions(this.repoId, iid, [{ id: discussionId, notes: [res.json] }]);
    return mapped?.notes[0] ?? null;
  }

  /**
   * A new top-level comment (`POST …/discussions {body}`). A WRITE: call only through `guardedWrite`.
   * Returns the new thread, or null when GitLab's answer could not be mapped (the comment WAS created).
   */
  async createNote(iid: number, body: string): Promise<LiveDiscussion | null> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}/discussions`;
    const res = await this.call(() => this.client.write('POST', path, { body }), path);
    const id = (res.json as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return null;
    try {
      return this.mapOne(iid, id, res.json, path);
    } catch {
      return null;
    }
  }

  /**
   * Uploads a file to the project (`POST /projects/:id/uploads`) for use in a comment. A WRITE: call only through
   * `guardedWrite`. Returns GitLab's markdown for it, or null when the answer had none (the file WAS uploaded).
   */
  async upload(filename: string, type: string, bytes: Buffer): Promise<string | null> {
    const path = `/projects/${this.projectId}/uploads`;
    const res = await this.call(() => this.client.writeFile(path, filename, type, bytes), path);
    const markdown = (res.json as { markdown?: unknown } | null)?.markdown;
    return typeof markdown === 'string' && markdown.length <= 1000 ? markdown : null;
  }

  /**
   * Resolves / unresolves a thread. A WRITE: call only through `guardedWrite`.
   * Returns the thread as GitLab reports it afterwards, or null when that answer could not be mapped
   * (the write DID succeed: a 2xx must never surface as an error, or it would escape the audit log).
   */
  async setResolved(
    iid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<LiveDiscussion | null> {
    const base = this.base(iid, discussionId);
    const path = `${base}?resolved=${resolved ? 'true' : 'false'}`;
    const res = await this.call(() => this.client.write('PUT', path), pathOnly(path));
    try {
      return this.mapOne(iid, discussionId, res.json, pathOnly(path));
    } catch {
      return null;
    }
  }
  /** The MR's current `diff_refs` (read). Throws `bad_response` when GitLab does not report them. */
  async diffRefs(iid: number): Promise<DiffRefs> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}`;
    const res = await this.call(() => this.client.get(path), path);
    const refs = mrDiffRefs(res.json);
    if (!refs) throw new GitlabApiError('bad_response', res.status, path);
    return refs;
  }

  /**
   * Starts a new thread on a diff line. A WRITE: call only through `guardedWrite`.
   * Returns the created thread, or null when GitLab's answer could not be mapped (the thread WAS created).
   */
  async createDiffThread(
    iid: number,
    refs: DiffRefs,
    pos: ReviewPosition,
    body: string,
  ): Promise<ReviewDiscussion | null> {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    const path = `/projects/${this.projectId}/merge_requests/${iid}/discussions`;
    const position: Record<string, unknown> = {
      position_type: 'text',
      base_sha: refs.baseSha,
      start_sha: refs.startSha,
      head_sha: refs.headSha,
      new_path: pos.path,
      old_path: pos.oldPath,
    };
    if (pos.newLine !== null) position.new_line = pos.newLine;
    if (pos.oldLine !== null) position.old_line = pos.oldLine;
    const res = await this.call(() => this.client.write('POST', path, { body, position }), path);
    try {
      return mapReviewDiscussion(res.json);
    } catch {
      return null;
    }
  }
}
