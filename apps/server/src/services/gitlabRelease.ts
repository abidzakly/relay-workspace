import { GitlabClient } from './gitlab';
import { kindOf } from './gitlabDiscussions';
import { mapRawMr, type MrFields } from './gitlabMr';
import { GitlabApiError } from './gitlabService';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';

/**
 * GitLab calls only the release engine makes. Documented REST v4 shapes, UNVERIFIED against the live instance:
 *   `GET  /users?username=`                    [{ id, username }]
 *   `POST /projects/:id/merge_requests`        { source_branch, target_branch, title, description, assignee_id,
 *                                                reviewer_ids, remove_source_branch, squash }; 409 = one already exists
 * Every MR is created with `squash: false` + `remove_source_branch: true`, never a draft, no milestone/labels
 *.
 * The POST is a WRITE: call it only through `guardedWrite`. Never retried (`GitlabClient.write`).
 */

export interface CreateMrInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  assigneeId: number;
  reviewerIds: number[];
}

export class GitlabReleaseApi {
  private readonly client: GitlabClient;

  constructor(
    host: string,
    token: string,
    private readonly projectId: number,
    http: HttpClient,
  ) {
    this.client = new GitlabClient(host, token, http);
  }

  private async checked(path: string, send: () => Promise<HttpResponse>): Promise<HttpResponse> {
    let res: HttpResponse;
    try {
      res = await send();
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new GitlabApiError(kindOf(res.status), res.status, path);
    }
    return res;
  }

  /** Null when no user has exactly this username (GitLab compares case-insensitively). */
  async findUserId(username: string): Promise<number | null> {
    const qs = new URLSearchParams({ username });
    const res = await this.checked('/users', () => this.client.get(`/users?${qs.toString()}`));
    if (!Array.isArray(res.json)) throw new GitlabApiError('bad_response', res.status, '/users');
    for (const raw of res.json as unknown[]) {
      const user = raw as { id?: unknown; username?: unknown };
      if (
        typeof user.id === 'number' &&
        typeof user.username === 'string' &&
        user.username.toLowerCase() === username.toLowerCase()
      ) {
        return user.id;
      }
    }
    return null;
  }

  /** Null when the MR was created but the answer could not be mapped: a look-up by source branch finds it. */
  async createMr(input: CreateMrInput): Promise<MrFields | null> {
    const path = `/projects/${this.projectId}/merge_requests`;
    const res = await this.checked(path, () =>
      this.client.write('POST', path, {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        assignee_id: input.assigneeId,
        reviewer_ids: input.reviewerIds,
        remove_source_branch: true,
        squash: false,
      }),
    );
    const mapped = mapRawMr(res.json);
    return mapped.ok ? mapped.value : null;
  }
}
