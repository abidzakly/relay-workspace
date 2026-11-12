import type { ApprovalMode } from '@relay/shared';
import { GitlabClient } from './gitlab';
import { kindOf } from './gitlabDiscussions';
import { APPROVAL_EMOJI } from './gitlabMr';
import { GitlabApiError } from './gitlabService';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';

/**
 * Approving an MR the way the repo counts approvals (`approvalMode`), so an approval given here is the same one the
 * merge gate reads back:
 *  - approvals_api: `POST …/merge_requests/:iid/approve` | `POST …/unapprove`
 *  - award_emoji:   `POST …/award_emoji {name: thumbsup}` | `DELETE …/award_emoji/:award_id` (my own award)
 *  - note_keyword:  `POST …/notes {body: "Approved"}` (cannot be revoked from here)
 * WRITES: call only through `guardedWrite`. Never retried (`GitlabClient.write`). Shapes follow GitLab's documented
 * REST v4 (UNVERIFIED live, like the other writes). Errors never carry the token, headers or bodies.
 */

/** The note posted in `note_keyword` mode: must match `APPROVAL_KEYWORD_RE`. */
export const APPROVAL_NOTE = 'Approved';

export class GitlabApproveApi {
  private readonly client: GitlabClient;

  constructor(
    host: string,
    token: string,
    private readonly projectId: number,
    http: HttpClient,
  ) {
    this.client = new GitlabClient(host, token, http);
  }

  private mr(iid: number): string {
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('invalid MR iid');
    return `/projects/${this.projectId}/merge_requests/${iid}`;
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

  /** The id of my own approval award, or null (read). */
  async myAward(iid: number, me: string): Promise<number | null> {
    const path = `${this.mr(iid)}/award_emoji`;
    const res = await this.call(() => this.client.get(`${path}?per_page=100`), path);
    if (!Array.isArray(res.json)) throw new GitlabApiError('bad_response', res.status, path);
    for (const a of res.json as unknown[]) {
      const award = a as { id?: unknown; name?: unknown; user?: { username?: unknown } } | null;
      if (
        award &&
        award.name === APPROVAL_EMOJI &&
        typeof award.id === 'number' &&
        typeof award.user?.username === 'string' &&
        award.user.username.toLowerCase() === me.toLowerCase()
      )
        return award.id;
    }
    return null;
  }

  /** Approves (WRITE). */
  async approve(iid: number, mode: ApprovalMode): Promise<void> {
    if (mode === 'approvals_api') {
      const path = `${this.mr(iid)}/approve`;
      await this.call(() => this.client.write('POST', path, {}), path);
    } else if (mode === 'award_emoji') {
      const path = `${this.mr(iid)}/award_emoji`;
      await this.call(() => this.client.write('POST', path, { name: APPROVAL_EMOJI }), path);
    } else {
      const path = `${this.mr(iid)}/notes`;
      await this.call(() => this.client.write('POST', path, { body: APPROVAL_NOTE }), path);
    }
  }

  /** Takes my approval back (WRITE). `awardId` is required in `award_emoji` mode. */
  async revoke(iid: number, mode: ApprovalMode, awardId: number | null): Promise<void> {
    if (mode === 'approvals_api') {
      const path = `${this.mr(iid)}/unapprove`;
      await this.call(() => this.client.write('POST', path, {}), path);
    } else if (mode === 'award_emoji') {
      if (awardId === null) throw new Error('no award to remove');
      const path = `${this.mr(iid)}/award_emoji/${awardId}`;
      await this.call(() => this.client.write('DELETE', path), path);
    } else {
      throw new Error('note_keyword approvals cannot be revoked');
    }
  }
}
