import type { Check, GlobalConfig, RepoConfig } from '@relay/shared';
import { clip, makeCheck } from './checks';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';

/**
 * GitLab REST v4 (read-only probes for "Test connection").
 * Response shapes follow GitLab's documented API and are UNVERIFIED against the live instance
 * (no sample was available in the sandbox) (no live sample was checked).
 */

/** Developer: can push branches, open MRs and merge. */
export const ACCESS_DEVELOPER = 30;
/** Reporter: can read and comment, cannot merge. */
export const ACCESS_REPORTER = 20;
export const EXPIRY_WARN_DAYS = 14;

export class GitlabClient {
  private readonly base: string;
  constructor(
    host: string,
    private readonly token: string,
    private readonly http: HttpClient,
  ) {
    this.base = `${host.replace(/\/+$/, '')}/api/v4`;
  }

  get(path: string): Promise<HttpResponse> {
    // PRIVATE-TOKEN is the documented header for PATs and project/group access tokens.
    return this.http.send({ url: `${this.base}${path}`, headers: { 'private-token': this.token } });
  }

  /**
   * A file download. GitLab may redirect to object storage: one hop is followed, WITHOUT the token, and only to https.
   */
  async getBytes(path: string): Promise<HttpResponse> {
    const res = await this.http.send({
      url: `${this.base}${path}`,
      headers: { 'private-token': this.token },
      binary: true,
      timeoutMs: 30_000,
    });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && typeof location === 'string') {
      if (!location.startsWith('https://')) return res;
      return this.http.send({ url: location, binary: true, timeoutMs: 30_000 });
    }
    return res;
  }

  /**
   * A WRITE (POST/PUT/DELETE). Only reachable through `guardedWrite` call sites (dry-run + audit).
   * Never retried: a replayed POST could create a duplicate; the user can simply click again.
   */
  /**
   * A WRITE: one file as `multipart/form-data` (field `file`). Same rules as `write`: guardedWrite only, never retried.
   * `filename` must already be a plain name (no quotes or line breaks): it goes into a header line.
   */
  writeFile(path: string, filename: string, type: string, bytes: Buffer): Promise<HttpResponse> {
    const boundary = `----relay-${crypto.randomUUID()}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return this.http.send({
      method: 'POST',
      url: `${this.base}${path}`,
      headers: {
        'private-token': this.token,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat([head, bytes, tail]),
      timeoutMs: 60_000,
      maxRetries: 0,
    });
  }

  write(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<HttpResponse> {
    return this.http.send({
      method,
      url: `${this.base}${path}`,
      headers: { 'private-token': this.token },
      ...(body !== undefined ? { body } : {}),
      maxRetries: 0,
    });
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function describeStatus(status: number): string {
  if (status === 401) return 'HTTP 401 (token invalid, revoked or expired)';
  if (status === 403) return 'HTTP 403 (forbidden)';
  if (status === 404) return 'HTTP 404 (not found)';
  if (status === 429) return 'HTTP 429 (rate limited, retries exhausted)';
  return `HTTP ${status}`;
}

export interface GitlabTestInput {
  global: Pick<GlobalConfig, 'gitlab'>;
  repo: Pick<RepoConfig, 'gitlab' | 'approvalMode'>;
  http: HttpClient;
  now: number;
}

/**
 * Checklist for one repo's GitLab connection:
 *  auth -> scope -> project -> access level -> approvals availability.
 * Dependent checks are `skip`ped (not guessed) when an earlier one fails.
 */
export async function testGitlab(input: GitlabTestInput): Promise<Check[]> {
  const c = makeCheck('gitlab');
  const host = input.global.gitlab.host;
  const out: Check[] = [];
  const ids = ['gitlab.scope', 'gitlab.project', 'gitlab.access', 'gitlab.approvals'] as const;
  const labels: Record<(typeof ids)[number], string> = {
    'gitlab.scope': 'Token scope',
    'gitlab.project': 'Project reachable',
    'gitlab.access': 'Project access level',
    'gitlab.approvals': 'Approvals available',
  };
  const skipRest = (why: string, from: number) => {
    for (const id of ids.slice(from)) out.push(c.skip(id, labels[id], why));
  };

  if (!host) {
    out.push(
      c.fail(
        'gitlab.auth',
        'Authentication',
        'GitLab host is not configured.',
        'Set Settings → GitLab host (e.g. https://gitlab.example.com).',
      ),
    );
    skipRest('Needs the GitLab host.', 0);
    return out;
  }
  const gl = new GitlabClient(host, input.repo.gitlab.token, input.http);

  // 1) auth
  let user: Record<string, unknown>;
  try {
    const res = await gl.get('/user');
    if (res.status !== 200) {
      out.push(
        c.fail(
          'gitlab.auth',
          'Authentication',
          `GET /user failed: ${describeStatus(res.status)}.`,
          res.status === 401
            ? 'Create a new token with the `api` scope and paste it in the repo settings.'
            : `Check the GitLab host (${host}) and that the token can use the API.`,
        ),
      );
      skipRest('Needs a working token.', 0);
      return out;
    }
    user = rec(res.json);
  } catch (e) {
    out.push(networkFail(c, 'gitlab.auth', 'Authentication', e, host));
    skipRest('Needs a reachable GitLab.', 0);
    return out;
  }
  const username = typeof user.username === 'string' ? user.username : undefined;
  const me = input.global.gitlab.myUsername;
  if (me && username && me.toLowerCase() !== username.toLowerCase()) {
    out.push(
      c.warn(
        'gitlab.auth',
        'Authentication',
        `Token belongs to @${clip(username, 80)}, not your configured username @${me}.`,
        'Fine for a bot/project token; otherwise check Settings → GitLab username.',
      ),
    );
  } else {
    out.push(
      c.pass(
        'gitlab.auth',
        'Authentication',
        username ? `Authenticated as @${clip(username, 80)}.` : 'Authenticated.',
      ),
    );
  }

  // 2) scope (GET /personal_access_tokens/self: GitLab >= 15.5)
  out.push(await checkScope(gl, c, input.now));

  // 3) project + 4) access level
  let projectOk = false;
  try {
    const res = await gl.get(`/projects/${input.repo.gitlab.projectId}`);
    if (res.status === 200) {
      projectOk = true;
      const p = rec(res.json);
      const name =
        typeof p.path_with_namespace === 'string' ? clip(p.path_with_namespace, 120) : '';
      const extras: string[] = [];
      if (p.archived === true) extras.push('archived');
      if (p.merge_requests_enabled === false) extras.push('merge requests disabled');
      if (extras.length > 0) {
        out.push(
          c.warn(
            'gitlab.project',
            labels['gitlab.project'],
            `Project ${name || input.repo.gitlab.projectId} is ${extras.join(' and ')}.`,
            'Un-archive the project / enable merge requests, or check the project id.',
          ),
        );
      } else {
        out.push(
          c.pass(
            'gitlab.project',
            labels['gitlab.project'],
            `Project ${name || input.repo.gitlab.projectId} is reachable.`,
          ),
        );
      }
      out.push(accessCheck(c, p));
    } else {
      out.push(
        c.fail(
          'gitlab.project',
          labels['gitlab.project'],
          `GET /projects/${input.repo.gitlab.projectId} failed: ${describeStatus(res.status)}.`,
          res.status === 404
            ? 'Wrong project id, or this token has no access to the project.'
            : 'Check the token scope and project membership.',
        ),
      );
      out.push(c.skip('gitlab.access', labels['gitlab.access'], 'Needs the project.'));
    }
  } catch (e) {
    out.push(networkFail(c, 'gitlab.project', labels['gitlab.project'], e, host));
    out.push(c.skip('gitlab.access', labels['gitlab.access'], 'Needs the project.'));
  }

  // 5) approvals
  if (!projectOk) {
    out.push(c.skip('gitlab.approvals', labels['gitlab.approvals'], 'Needs the project.'));
  } else {
    out.push(await checkApprovals(gl, c, input.repo));
  }
  return out;
}

type Maker = ReturnType<typeof makeCheck>;

function networkFail(c: Maker, id: string, label: string, e: unknown, host: string): Check {
  const kind = e instanceof HttpNetworkError ? e.kind : 'network';
  return c.fail(
    id,
    label,
    kind === 'timeout' ? `Timed out reaching ${host}.` : `Could not reach ${host} (${kind}).`,
    'Check the host URL, your network/VPN, and that the instance is up.',
  );
}

async function checkScope(gl: GitlabClient, c: Maker, now: number): Promise<Check> {
  const id = 'gitlab.scope';
  const label = 'Token scope';
  let res: HttpResponse;
  try {
    res = await gl.get('/personal_access_tokens/self');
  } catch (e) {
    return networkFail(c, id, label, e, 'GitLab');
  }
  if (res.status === 404 || res.status === 403) {
    return c.warn(
      id,
      label,
      'Could not read the token details (GitLab older than 15.5, or not a personal/project/group access token).',
      'Make sure the token has the `api` scope (needed to comment, merge, register webhooks and push branches).',
    );
  }
  if (res.status !== 200) {
    return c.warn(id, label, `Token details unavailable: ${describeStatus(res.status)}.`);
  }
  const t = rec(res.json);
  if (t.active === false || t.revoked === true) {
    return c.fail(
      id,
      label,
      'The token is revoked or inactive.',
      'Create a new token with the `api` scope.',
    );
  }
  const scopes = Array.isArray(t.scopes)
    ? t.scopes.filter((s): s is string => typeof s === 'string')
    : [];
  if (!scopes.includes('api')) {
    const has = scopes.length > 0 ? scopes.join(', ') : 'none';
    return c.fail(
      id,
      label,
      `Token scopes: ${clip(has)}. The \`api\` scope is required.`,
      '`read_api` cannot comment/merge/register webhooks. Create a token with `api`.',
    );
  }
  if (typeof t.expires_at === 'string') {
    const exp = Date.parse(t.expires_at);
    if (!Number.isNaN(exp)) {
      // GitLab expiry is a date (end of that day).
      const endOfDay = exp + 24 * 3600 * 1000;
      const days = Math.floor((endOfDay - now) / (24 * 3600 * 1000));
      if (days < 0) {
        return c.fail(
          id,
          label,
          `The token expired on ${clip(t.expires_at, 10)}.`,
          'Create a new token.',
        );
      }
      if (days <= EXPIRY_WARN_DAYS) {
        return c.warn(
          id,
          label,
          `Scope \`api\` OK, but the token expires in ${days} day(s) (${clip(t.expires_at, 10)}).`,
          'Rotate the token before it expires.',
        );
      }
    }
  }
  return c.pass(id, label, 'Token has the `api` scope.');
}

function accessCheck(c: Maker, project: Record<string, unknown>): Check {
  const id = 'gitlab.access';
  const label = 'Project access level';
  const perms = rec(project.permissions);
  const levels = [
    rec(perms.project_access).access_level,
    rec(perms.group_access).access_level,
  ].filter((n): n is number => typeof n === 'number');
  if (levels.length === 0) {
    return c.warn(
      id,
      label,
      'GitLab did not report an access level for this token on the project.',
      'Make sure the token user is a project member with at least Developer.',
    );
  }
  const level = Math.max(...levels);
  const name =
    level >= 50
      ? 'Owner'
      : level >= 40
        ? 'Maintainer'
        : level >= 30
          ? 'Developer'
          : level >= ACCESS_REPORTER
            ? 'Reporter'
            : 'Guest';
  if (level >= ACCESS_DEVELOPER)
    return c.pass(id, label, `${name} (${level}): can merge and push.`);
  if (level >= ACCESS_REPORTER) {
    return c.warn(
      id,
      label,
      `${name} (${level}): can read and comment but not merge or push.`,
      'Give the token user at least Developer for merge / version MRs.',
    );
  }
  return c.fail(
    id,
    label,
    `${name} (${level}): too low.`,
    'Give the token user at least Developer.',
  );
}

async function checkApprovals(
  gl: GitlabClient,
  c: Maker,
  repo: Pick<RepoConfig, 'gitlab' | 'approvalMode'>,
): Promise<Check> {
  const id = 'gitlab.approvals';
  const label = 'Approvals available';
  if (repo.approvalMode !== 'approvals_api') {
    return c.skip(id, label, `Not needed: approvalMode is "${repo.approvalMode}".`);
  }
  const pid = repo.gitlab.projectId;
  try {
    // Probe on a real MR: prefer an open one, else the most recent of any state.
    let iid: number | undefined;
    for (const state of ['opened', 'all']) {
      const list = await gl.get(`/projects/${pid}/merge_requests?state=${state}&per_page=1`);
      if (list.status !== 200) {
        return c.warn(id, label, `Could not list merge requests: ${describeStatus(list.status)}.`);
      }
      const first = Array.isArray(list.json) ? rec(list.json[0]) : {};
      if (typeof first.iid === 'number') {
        iid = first.iid;
        break;
      }
    }
    if (iid === undefined) {
      return c.warn(
        id,
        label,
        'No merge request exists yet, so the Approvals API cannot be probed.',
        'Re-run the test once the project has an MR.',
      );
    }
    const res = await gl.get(`/projects/${pid}/merge_requests/${iid}/approvals`);
    if (res.status === 200) {
      const body = rec(res.json);
      if (Array.isArray(body.approved_by)) {
        return c.pass(id, label, `Approvals API answers (probed on !${iid}).`);
      }
      return c.warn(
        id,
        label,
        `Approvals API answered for !${iid} but without \`approved_by\`.`,
        'The response shape is unexpected; the merge gate may not see approvals.',
      );
    }
    if (res.status === 404 || res.status === 403) {
      return c.fail(
        id,
        label,
        `Approvals API is not available (${describeStatus(res.status)}).`,
        'Likely a GitLab tier/feature limit. Switch this repo\'s approvalMode to "award_emoji" or "note_keyword".',
      );
    }
    return c.warn(id, label, `Approvals probe failed: ${describeStatus(res.status)}.`);
  } catch (e) {
    return networkFail(c, id, label, e, 'GitLab');
  }
}
