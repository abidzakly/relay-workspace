import type {
  Branch,
  CommitSummary,
  DiffFile,
  DiffRefs,
  Mr,
  MrFile,
  Note,
  RepoConfig,
  ReviewDiscussion,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { Logger } from '../util/logger';
import { GitlabClient } from './gitlab';
import {
  keywordApprovals,
  lastHumanNote,
  mapApprovals,
  mapAwardApprovals,
  mapDiffFiles,
  mapDiscussions,
  mapRawCommit,
  mapRawMr,
  mapRawTag,
  mrDescription,
  mrHeadSha,
  GIT_SHA_RE,
  type MrFields,
} from './gitlabMr';
import {
  HttpNetworkError,
  type HttpClient,
  type HttpResponse,
  type NetworkErrorKind,
} from './httpClient';
import {
  mapBranches,
  mapCompare,
  mapDiffFilesFull,
  mapReviewDiscussions,
  mrDiffRefs,
} from './gitlabReview';
import { getCachedMr, listCachedOpenIids, persistSyncedMr, upsertMrSummaries } from './mrStore';
import { repoOrExt } from './reviewTarget';
import { refreshMrCommits } from './mrStack';

/**
 * GitLabService — READ-ONLY. Every call is a GET; nothing here writes to GitLab.
 * Per-repo token (via `GitlabClient`), pagination through `X-Next-Page`, rate-limit awareness, and
 * mapping into the shared `Mr` / `Note` types with upserts into `mrs` / `notes_cache`.
 * Response shapes follow GitLab's documented API: UNVERIFIED on the live instance.
 */

export const PER_PAGE = 100;
/** Newest first, per role: this many pages of closed MRs reach the inbox. */
const CLOSED_MAX_PAGES = 2;
export const DEFAULT_MAX_PAGES = 10;
/** Longest we sleep proactively for an exhausted rate-limit window; beyond that we fail fast. */
export const MAX_RATE_WAIT_MS = 30_000;
const SYNC_CONCURRENCY = 3;
/** Changed-file list for the MR drawer. */
const FILES_MAX = 300;
/** Each `/diffs` item carries its diff text: small pages keep a big MR under the 5 MB response cap. */
const FILES_PER_PAGE = 20;

export type GitlabErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'bad_request'
  | 'bad_response'
  | 'network';

/** Never carries the token, headers, query string or response body. */
export class GitlabApiError extends Error {
  constructor(
    readonly kind: GitlabErrorKind,
    readonly status: number | undefined,
    readonly path: string,
    readonly retryAfterMs?: number,
    /** For `network`: what went wrong underneath (timeout, too_large, …). */
    readonly networkKind?: NetworkErrorKind,
  ) {
    super(
      `GitLab ${kind}${networkKind ? ` (${networkKind})` : ''}${status !== undefined ? ` (HTTP ${status})` : ''} on ${path}`,
    );
    this.name = 'GitlabApiError';
  }
}

export interface RateLimitSnapshot {
  limit?: number;
  remaining?: number;
  /** Epoch ms when the window resets. */
  resetAt?: number;
}

export type MrListState = 'opened' | 'closed' | 'locked' | 'merged' | 'all';

export interface ListMrsQuery {
  state: MrListState;
  targetBranch?: string;
  sourceBranch?: string;
  assigneeUsername?: string;
  authorUsername?: string;
  reviewerUsername?: string;
  /** Epoch ms: only MRs updated at/after this instant. */
  updatedAfter?: number;
  maxPages?: number;
  /** Asked after each page (GitLab orders by `updated_at` desc): true = do not fetch further pages. */
  stopWhen?: (page: MrFields[]) => boolean;
}

export interface ListMrsResult {
  mrs: MrFields[];
  /** MRs in the response that could not be mapped (the rest are still returned). */
  skipped: { iid?: number; reason: string }[];
  /** true = more pages existed than `maxPages` allowed. */
  truncated: boolean;
  /** true = `stopWhen` ended the walk before the last page. */
  stopped: boolean;
  pages: number;
}

/** Head of a branch (documented `GET …/repository/commits` item; UNVERIFIED live). */
export interface HeadCommit {
  sha: string;
  title: string;
}

/** Newest tag (documented `GET …/repository/tags` item; UNVERIFIED live). */
export interface LatestTag {
  name: string;
  committedAt: number | null;
}

export type ApprovalsStatus = 'ok' | 'unavailable' | 'error';
export interface ApprovalsOutcome {
  mode: RepoConfig['approvalMode'];
  /** `unavailable` = the feature/endpoint is not there (tier/permissions); `error` = transient. */
  status: ApprovalsStatus;
  /** All approvers found (the merge gate filters by configured reviewers later). Empty unless `ok`. */
  approvedBy: string[];
  message?: string;
}

export interface SyncedMr {
  mr: Mr;
  mergeStatus: string | null;
  approvals: ApprovalsOutcome;
  notes: { count: number; skipped: number; error?: string };
  lastNote: { author: string | null; at: number } | null;
}

export interface SyncReport {
  listed: number;
  synced: number;
  /** Cached as opened but no longer in GitLab's open list: refreshed (now merged/closed). */
  reconciled: number;
  truncated: boolean;
  skipped: { iid?: number; reason: string }[];
  errors: { iid: number; kind: GitlabErrorKind | 'unknown'; message: string }[];
  /** true = stopped early because GitLab rate-limited us. */
  rateLimited: boolean;
  /** true = no `gitlab.myUsername`, so no open MR was listed (listing everyone's is too heavy). */
  noIdentity?: boolean;
}

export interface GitlabServiceOptions {
  repo: RepoConfig;
  host: string;
  http: HttpClient;
  store: AppDb;
  log: Logger;
  /** Notes written by this user are never "unread". */
  myUsername?: string;
  /** Every username that is "me" (`myUsername` plus the token bot users): their notes are never "unread". */
  myUsernames?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pathOnly = (p: string) => p.split('?')[0] ?? p;

const header = (h: HttpResponse['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export class GitlabService {
  private readonly client: GitlabClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private rate: RateLimitSnapshot = {};

  constructor(private readonly o: GitlabServiceOptions) {
    this.client = new GitlabClient(o.host, o.repo.gitlab.token, o.http);
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
  }

  /** Builds a service from saved config (repo token + global host). Throws if either is missing. */
  static forRepo(
    config: ConfigStore,
    repoId: string,
    deps: {
      http: HttpClient;
      store: AppDb;
      log: Logger;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ): GitlabService {
    // `~<projectId>` = a project reached through Reviews with the personal reviewer token.
    const repo = repoOrExt(config, repoId);
    if (!repo) throw new Error(`unknown repo "${repoId}"`);
    const g = config.getGlobal().gitlab;
    if (!g.host) throw new Error('GitLab host is not configured');
    return new GitlabService({
      ...deps,
      repo,
      host: g.host,
      ...(g.myUsername ? { myUsername: g.myUsername } : {}),
      myUsernames: config.myUsernames(),
    });
  }

  /** The GitLab host this service talks to. */
  get host(): string {
    return this.o.host;
  }

  /** Last rate-limit headers seen (for Sync Health). */
  rateLimit(): Readonly<RateLimitSnapshot> {
    return this.rate;
  }

  // ───────────── low level ─────────────

  private get pid(): number {
    return this.o.repo.gitlab.projectId;
  }

  private noteRateLimit(h: HttpResponse['headers']): void {
    const num = (v: string | undefined) => {
      if (v === undefined || v.trim() === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const limit = num(header(h, 'ratelimit-limit'));
    const remaining = num(header(h, 'ratelimit-remaining'));
    const reset = num(header(h, 'ratelimit-reset'));
    if (limit === undefined && remaining === undefined && reset === undefined) return;
    // RateLimit-Reset is documented as epoch seconds; tolerate a relative value just in case.
    const resetAt =
      reset === undefined ? undefined : reset > 1e9 ? reset * 1000 : this.now() + reset * 1000;
    this.rate = {
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }

  private async waitForRateLimit(path: string): Promise<void> {
    const { remaining, resetAt } = this.rate;
    if (remaining === undefined || remaining > 0 || resetAt === undefined) return;
    const wait = resetAt - this.now();
    if (wait <= 0) {
      this.rate = {};
      return;
    }
    if (wait > MAX_RATE_WAIT_MS) throw new GitlabApiError('rate_limited', undefined, path, wait);
    this.o.log.warn(
      { repo: this.o.repo.id, waitMs: wait },
      'gitlab rate limit window exhausted, waiting',
    );
    await this.sleep(wait + 250);
    this.rate = {};
  }

  /** One GET with rate-limit handling and status classification. 200/204 return, anything else throws. */
  private async get(path: string): Promise<HttpResponse> {
    const p = pathOnly(path);
    await this.waitForRateLimit(p);
    let res: HttpResponse;
    try {
      res = await this.client.get(path);
    } catch (e) {
      if (e instanceof HttpNetworkError) {
        throw new GitlabApiError('network', undefined, p, undefined, e.kind);
      }
      throw e;
    }
    this.noteRateLimit(res.headers);
    const s = res.status;
    if (s === 200 || s === 204) return res;
    const kind: GitlabErrorKind =
      s === 401
        ? 'auth'
        : s === 403
          ? 'forbidden'
          : s === 404
            ? 'not_found'
            : s === 429
              ? 'rate_limited'
              : s >= 500
                ? 'server'
                : s >= 400
                  ? 'bad_request'
                  : 'bad_response';
    const retryAfter = header(res.headers, 'retry-after');
    const secs = retryAfter !== undefined ? Number(retryAfter) : NaN;
    throw new GitlabApiError(kind, s, p, Number.isFinite(secs) ? secs * 1000 : undefined);
  }

  /**
   * Follows `X-Next-Page` (GitLab's offset pagination; absent/empty on the last page). 204 or `[]` = no
   * items. A non-array body is a `bad_response`. Stops after `maxPages` and reports `truncated`.
   */
  private async paginate(
    path: string,
    params: Record<string, string>,
    maxPages = DEFAULT_MAX_PAGES,
    perPage = PER_PAGE,
    stopWhen?: (page: unknown[]) => boolean,
  ): Promise<{ items: unknown[]; pages: number; truncated: boolean; stopped: boolean }> {
    const items: unknown[] = [];
    let page = 1;
    let pages = 0;
    for (;;) {
      const qs = new URLSearchParams({ ...params, per_page: String(perPage), page: String(page) });
      const res = await this.get(`${path}?${qs.toString()}`);
      pages++;
      if (res.status !== 204) {
        if (!Array.isArray(res.json))
          throw new GitlabApiError('bad_response', res.status, pathOnly(path));
        items.push(...res.json);
      }
      const next = Number(header(res.headers, 'x-next-page'));
      if (!Number.isInteger(next) || next <= page) {
        return { items, pages, truncated: false, stopped: false };
      }
      const pageItems = res.status !== 204 && Array.isArray(res.json) ? res.json : [];
      if (stopWhen?.(pageItems)) return { items, pages, truncated: false, stopped: true };
      if (pages >= maxPages) return { items, pages, truncated: true, stopped: false };
      page = next;
    }
  }

  // ───────────── MR reads ─────────────

  /** Paginated MR list with state / target filters. Pure read: nothing is cached (see `listMergedMrs`). */
  async listMrs(q: ListMrsQuery): Promise<ListMrsResult> {
    const params: Record<string, string> = {
      state: q.state,
      order_by: 'updated_at',
      sort: 'desc',
    };
    if (q.targetBranch) params.target_branch = q.targetBranch;
    if (q.sourceBranch) params.source_branch = q.sourceBranch;
    if (q.assigneeUsername) params.assignee_username = q.assigneeUsername;
    if (q.authorUsername) params.author_username = q.authorUsername;
    if (q.reviewerUsername) params.reviewer_username = q.reviewerUsername;
    if (q.updatedAfter !== undefined) params.updated_after = new Date(q.updatedAfter).toISOString();
    const stopWhen = q.stopWhen;
    const { items, pages, truncated, stopped } = await this.paginate(
      `/projects/${this.pid}/merge_requests`,
      params,
      q.maxPages,
      PER_PAGE,
      stopWhen
        ? (page) =>
            stopWhen(
              page.flatMap((raw) => {
                const m = mapRawMr(raw);
                return m.ok ? [m.value] : [];
              }),
            )
        : undefined,
    );
    const out: MrFields[] = [];
    const skipped: ListMrsResult['skipped'] = [];
    for (const raw of items) {
      const m = mapRawMr(raw);
      if (m.ok) out.push(m.value);
      else skipped.push({ ...(m.iid !== undefined ? { iid: m.iid } : {}), reason: m.reason });
    }
    return { mrs: out, skipped, truncated, stopped, pages };
  }

  /**
   * Merged MRs for (boundary + pending detection): `state=merged`, target = `targetBranch`
   * (default: the repo's base branch), newest `mergedAt` first. GitLab orders by `updated_at`, so the
   * result is re-sorted by `mergedAt` here. Rows are upserted as summaries (no approvals/notes).
   */
  async listMergedMrs(
    opts: {
      targetBranch?: string;
      maxPages?: number;
      persist?: boolean;
      stopWhen?: ListMrsQuery['stopWhen'];
    } = {},
  ): Promise<ListMrsResult> {
    const res = await this.listMrs({
      state: 'merged',
      targetBranch: opts.targetBranch ?? this.o.repo.baseBranch,
      ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
      ...(opts.stopWhen ? { stopWhen: opts.stopWhen } : {}),
    });
    res.mrs.sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0) || b.iid - a.iid);
    if (opts.persist !== false)
      upsertMrSummaries(this.o.store, this.o.repo.id, res.mrs, this.now());
    return res;
  }

  // ───────────── repository reads (release detection) ─────────────

  /** Newest commit of a branch; null when the branch has none. */
  async getHeadCommit(ref: string): Promise<HeadCommit | null> {
    const qs = new URLSearchParams({ ref_name: ref, per_page: '1' });
    const path = `/projects/${this.pid}/repository/commits`;
    const res = await this.get(`${path}?${qs.toString()}`);
    if (!Array.isArray(res.json)) throw new GitlabApiError('bad_response', res.status, path);
    if (res.json.length === 0) return null;
    const c = mapRawCommit(res.json[0]);
    if (!c) throw new GitlabApiError('bad_response', res.status, path);
    return c;
  }

  /** The most recently updated tag (GitLab's documented default order); null when there are no tags. */
  async getLatestTag(): Promise<LatestTag | null> {
    const qs = new URLSearchParams({ order_by: 'updated', sort: 'desc', per_page: '1' });
    const path = `/projects/${this.pid}/repository/tags`;
    const res = await this.get(`${path}?${qs.toString()}`);
    if (!Array.isArray(res.json)) throw new GitlabApiError('bad_response', res.status, path);
    if (res.json.length === 0) return null;
    const t = mapRawTag(res.json[0]);
    if (!t) throw new GitlabApiError('bad_response', res.status, path);
    return t;
  }

  /** Raw text of a repository file on a ref. Throws `not_found` (GitlabApiError) when it does not exist. */
  async readRawFile(filePath: string, ref: string): Promise<string> {
    const qs = new URLSearchParams({ ref });
    const path = `/projects/${this.pid}/repository/files/${encodeURIComponent(filePath)}/raw`;
    return (await this.get(`${path}?${qs.toString()}`)).text;
  }

  /** MR detail (draft, has_conflicts, merge status, head pipeline). Not cached by itself. */
  async getMrDetail(iid: number): Promise<MrFields> {
    return (await this.getMrDetailWithDescription(iid)).fields;
  }

  /**
   * Same GET as `getMrDetail` plus the raw markdown description (never cached: the drawer reads it live).
   * The description is user content; the client sanitizes it.
   */
  async getMrDetailWithDescription(
    iid: number,
  ): Promise<{ fields: MrFields; description: string | null; sha: string | null }> {
    const path = `/projects/${this.pid}/merge_requests/${iid}`;
    const res = await this.get(path);
    const m = mapRawMr(res.json);
    if (!m.ok) throw new GitlabApiError('bad_response', res.status, path);
    return { fields: m.value, description: mrDescription(res.json), sha: mrHeadSha(res.json) };
  }

  /**
   * Changed files (paths + added/renamed/deleted only). `GET …/diffs` (GitLab >= 15.7, paginated), falling back to
   * the legacy `GET …/changes` on 404. At most `maxFiles`; `truncated` says there were more. UNVERIFIED live.
   */
  async getMrFiles(
    iid: number,
    opts: { maxFiles?: number } = {},
  ): Promise<{ files: MrFile[]; truncated: boolean; skipped: number }> {
    const maxFiles = opts.maxFiles ?? FILES_MAX;
    const base = `/projects/${this.pid}/merge_requests/${iid}`;
    let raw: unknown[];
    let truncated = false;
    try {
      // Small pages: each item carries its diff text, so big pages could hit the response size cap.
      const r = await this.paginate(
        `${base}/diffs`,
        {},
        Math.ceil(maxFiles / FILES_PER_PAGE),
        FILES_PER_PAGE,
      );
      raw = r.items;
      truncated = r.truncated;
    } catch (e) {
      if (!(e instanceof GitlabApiError) || e.kind !== 'not_found') throw e;
      const res = await this.get(`${base}/changes`);
      const changes = (res.json as { changes?: unknown } | null)?.changes;
      if (!Array.isArray(changes))
        throw new GitlabApiError('bad_response', res.status, `${base}/changes`);
      raw = changes;
    }
    const mapped = mapDiffFiles(raw);
    if (!mapped) throw new GitlabApiError('bad_response', 200, `${base}/diffs`);
    if (mapped.files.length > maxFiles) truncated = true;
    return { files: mapped.files.slice(0, maxFiles), truncated, skipped: mapped.skipped };
  }

  // ───────────── Code Reviewer reads ─────────────

  /** MR `diff_refs` (needed to post a comment on a line). Throws on API error; null when GitLab omits them. */
  async getMrDiffRefs(iid: number): Promise<DiffRefs | null> {
    const res = await this.get(`/projects/${this.pid}/merge_requests/${iid}`);
    return mrDiffRefs(res.json);
  }

  /** Changed files WITH diff text. Same endpoints and limits as `getMrFiles`. */
  async getMrDiffs(
    iid: number,
    opts: { maxFiles?: number } = {},
  ): Promise<{ files: DiffFile[]; truncated: boolean }> {
    const maxFiles = opts.maxFiles ?? FILES_MAX;
    const base = `/projects/${this.pid}/merge_requests/${iid}`;
    let raw: unknown[];
    let truncated = false;
    try {
      const r = await this.paginate(
        `${base}/diffs`,
        {},
        Math.ceil(maxFiles / FILES_PER_PAGE),
        FILES_PER_PAGE,
      );
      raw = r.items;
      truncated = r.truncated;
    } catch (e) {
      if (!(e instanceof GitlabApiError) || e.kind !== 'not_found') throw e;
      const res = await this.get(`${base}/changes`);
      const changes = (res.json as { changes?: unknown } | null)?.changes;
      if (!Array.isArray(changes))
        throw new GitlabApiError('bad_response', res.status, `${base}/changes`);
      raw = changes;
    }
    const mapped = mapDiffFilesFull(raw);
    if (!mapped) throw new GitlabApiError('bad_response', 200, `${base}/diffs`);
    if (mapped.files.length > maxFiles) truncated = true;
    return { files: mapped.files.slice(0, maxFiles), truncated };
  }

  /** Title and description of an MR or issue of any project this token can read (for links pasted as context). */
  async getIssuable(
    projectPath: string,
    kind: 'merge_requests' | 'issues',
    iid: number,
  ): Promise<{ title: string; description: string; state: string }> {
    const path = `/projects/${encodeURIComponent(projectPath)}/${kind}/${iid}`;
    const j = (await this.get(path)).json as {
      title?: unknown;
      description?: unknown;
      state?: unknown;
    } | null;
    if (!j || typeof j.title !== 'string') throw new GitlabApiError('bad_response', 200, path);
    return {
      title: j.title,
      description: typeof j.description === 'string' ? j.description : '',
      state: typeof j.state === 'string' ? j.state : 'unknown',
    };
  }

  /** Discussions with their diff `position` kept (system-only threads dropped). */
  async getReviewDiscussions(iid: number): Promise<ReviewDiscussion[]> {
    const path = `/projects/${this.pid}/merge_requests/${iid}/discussions`;
    const { items } = await this.paginate(path, {});
    const mapped = mapReviewDiscussions(items);
    if (!mapped) throw new GitlabApiError('bad_response', 200, path);
    return mapped;
  }

  /**
   * A file attached to a comment (`GET /projects/:id/uploads/:secret/:filename`, GitLab 17.4+). Throws on any failure;
   * bodies over the HTTP client's size cap fail as well.
   */
  async downloadUpload(secret: string, filename: string): Promise<Buffer> {
    const path = `/projects/${this.pid}/uploads/${secret}/${encodeURIComponent(filename)}`;
    const res = await this.client.getBytes(path);
    if (res.status !== 200 || !res.bytes) {
      throw new GitlabApiError('bad_response', res.status, path);
    }
    return res.bytes;
  }

  /**
   * Commit SHAs of an MR (`GET …/merge_requests/:iid/commits` = `target...source`, newest first). At most 5 pages;
   * `truncated` = more existed (callers that gate must fail closed on it). UNVERIFIED live.
   */
  async getMrCommitShas(iid: number): Promise<{ shas: string[]; truncated: boolean }> {
    const path = `/projects/${this.pid}/merge_requests/${iid}/commits`;
    const { items, truncated } = await this.paginate(path, {}, 5);
    const shas: string[] = [];
    for (const raw of items) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !GIT_SHA_RE.test(id))
        throw new GitlabApiError('bad_response', 200, path);
      shas.push(id);
    }
    return { shas, truncated };
  }

  /** Project `squash_option` (`never|always|default_on|default_off`); null when absent. UNVERIFIED live. */
  async getProjectSquashOption(): Promise<string | null> {
    const path = `/projects/${this.pid}`;
    const res = await this.get(path);
    const v = (res.json as { squash_option?: unknown } | null)?.squash_option;
    return typeof v === 'string' ? v : null;
  }

  /** Every open MR into `targetBranch` (anyone's), at most 5 pages. For the live stack check. */
  async listOpenMrsInto(targetBranch: string): Promise<{ mrs: MrFields[]; complete: boolean }> {
    const r = await this.listMrs({ state: 'opened', targetBranch, maxPages: 5 });
    return { mrs: r.mrs, complete: !r.truncated && r.skipped.length === 0 };
  }

  /** Branches, optionally filtered by GitLab's `search` (substring). At most 3 pages. */
  async listBranches(search?: string): Promise<{ branches: Branch[]; truncated: boolean }> {
    const params: Record<string, string> = {};
    if (search) params.search = search;
    const path = `/projects/${this.pid}/repository/branches`;
    const { items, truncated } = await this.paginate(path, params, 3);
    const branches = mapBranches(items);
    if (!branches) throw new GitlabApiError('bad_response', 200, path);
    branches.sort(
      (a, b) =>
        Number(b.default) - Number(a.default) || (b.committedAt ?? 0) - (a.committedAt ?? 0),
    );
    return { branches, truncated };
  }

  /** `from...to` (merge-base compare, what an MR from `to` into `from` would show). */
  async compare(
    from: string,
    to: string,
  ): Promise<{
    commits: CommitSummary[];
    commitCount: number;
    files: DiffFile[];
    truncated: boolean;
    webUrl: string | null;
  }> {
    const qs = new URLSearchParams({ from, to, straight: 'false' });
    const path = `/projects/${this.pid}/repository/compare`;
    const res = await this.get(`${path}?${qs.toString()}`);
    const mapped = mapCompare(res.json);
    if (!mapped) throw new GitlabApiError('bad_response', res.status, path);
    const truncated = mapped.files.length > FILES_MAX;
    return { ...mapped, files: mapped.files.slice(0, FILES_MAX), truncated };
  }

  /** Discussions flattened to notes. Throws on API error. */
  async getNotes(iid: number): Promise<{ notes: Note[]; skipped: number }> {
    const path = `/projects/${this.pid}/merge_requests/${iid}/discussions`;
    const { items } = await this.paginate(path, {});
    const mapped = mapDiscussions(this.o.repo.id, iid, items);
    if (!mapped) throw new GitlabApiError('bad_response', 200, path);
    return mapped;
  }

  /**
   * Approvers according to the repo's `approvalMode`:
   *  - approvals_api: `GET …/approvals` (`approved_by[].user.username`); 403/404 => `unavailable`.
   *  - award_emoji:   users who gave the `thumbsup` award.
   *  - note_keyword:  derived from `notes` (pass them in; without them the result is `error`).
   * Never throws: a failure is reported as `unavailable` / `error` with `approvedBy: []`.
   */
  async getApprovals(iid: number, notes?: readonly Note[]): Promise<ApprovalsOutcome> {
    const mode = this.o.repo.approvalMode;
    const fail = (status: ApprovalsStatus, message: string): ApprovalsOutcome => ({
      mode,
      status,
      approvedBy: [],
      message,
    });
    try {
      if (mode === 'note_keyword') {
        if (!notes) return fail('error', 'Notes were not available to look for approval keywords.');
        return { mode, status: 'ok', approvedBy: keywordApprovals(notes) };
      }
      if (mode === 'award_emoji') {
        const path = `/projects/${this.pid}/merge_requests/${iid}/award_emoji`;
        const { items } = await this.paginate(path, {});
        const approvers = mapAwardApprovals(items);
        if (!approvers) return fail('error', 'Unexpected award_emoji response shape.');
        return { mode, status: 'ok', approvedBy: approvers };
      }
      const path = `/projects/${this.pid}/merge_requests/${iid}/approvals`;
      const res = await this.get(path);
      const approvers = mapApprovals(res.json);
      if (!approvers) return fail('error', 'Unexpected approvals response shape (no approved_by).');
      return { mode, status: 'ok', approvedBy: approvers };
    } catch (e) {
      if (e instanceof GitlabApiError) {
        if (mode === 'approvals_api' && (e.kind === 'forbidden' || e.kind === 'not_found')) {
          return fail(
            'unavailable',
            `Approvals API not available (${e.message}). Switch approvalMode.`,
          );
        }
        return fail('error', e.message);
      }
      throw e;
    }
  }

  // ───────────── sync (fetch + cache) ─────────────

  /**
   * Full refresh of one MR: detail + approvals + discussions, mapped to `Mr` and upserted together with
   * its notes. Failure semantics (so a blip never fakes "not approved"/"no comments"):
   *  - detail fails          -> throws, nothing written;
   *  - notes fail            -> notes cache and `lastNoteAt` keep their previous values;
   *  - approvals `error`     -> previous `approvedBy` kept; `unavailable` -> cleared to [].
   * Conflict info missing from detail is treated as `false` unless the merge status says conflict.
   */
  async syncMr(iid: number): Promise<SyncedMr> {
    const repoId = this.o.repo.id;
    const f = await this.getMrDetail(iid);
    // Commit list for the stacked-MR layout (cosmetic cache; never throws).
    await refreshMrCommits(this, this.o.store, repoId, f, this.now());

    let notes: Note[] | undefined;
    let notesSkipped = 0;
    let notesError: string | undefined;
    try {
      const n = await this.getNotes(iid);
      notes = n.notes;
      notesSkipped = n.skipped;
    } catch (e) {
      if (!(e instanceof GitlabApiError)) throw e;
      notesError = e.message;
    }

    const approvals = await this.getApprovals(iid, notes);
    const prior = getCachedMr(this.o.store, repoId, iid);
    const last = notes ? lastHumanNote(notes) : null;

    const approvedBy =
      approvals.status === 'ok'
        ? approvals.approvedBy
        : approvals.status === 'unavailable'
          ? []
          : (prior?.approvedBy ?? []);

    const mr: Mr = {
      repoId,
      iid: f.iid,
      gitlabId: f.gitlabId,
      title: f.title,
      state: f.state,
      draft: f.draft,
      hasConflicts: f.hasConflicts ?? false,
      sourceBranch: f.sourceBranch,
      targetBranch: f.targetBranch,
      author: f.author,
      webUrl: f.webUrl,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      mergedAt: f.mergedAt,
      descriptionNotionId: f.descriptionNotionId,
      approvedBy,
      assignees: f.assignees ?? prior?.assignees ?? [],
      reviewers: f.reviewers ?? prior?.reviewers ?? [],
      lastNoteAt: notes ? (last?.at ?? null) : (prior?.lastNoteAt ?? null),
      headPipeline: f.headPipeline ?? null,
      syncedAt: this.now(),
    };
    persistSyncedMr(
      this.o.store,
      mr,
      notes,
      this.o.myUsernames ?? (this.o.myUsername ? [this.o.myUsername] : []),
    );

    return {
      mr,
      mergeStatus: f.mergeStatus,
      approvals,
      notes: {
        count: notes?.length ?? 0,
        skipped: notesSkipped,
        ...(notesError ? { error: notesError } : {}),
      },
      lastNote: last,
    };
  }

  /**
   * Refreshes every open MR (list -> summaries cached -> per-MR full sync, 3 at a time), then re-syncs
   * MRs still cached as `opened` that are no longer in GitLab's open list (merged/closed meanwhile).
   * Per-MR failures are collected; a rate limit stops the run (`rateLimited`).
   */
  async syncOpenMrs(opts: { targetBranch?: string; maxPages?: number } = {}): Promise<SyncReport> {
    const repoId = this.o.repo.id;
    const me = this.o.myUsername;
    if (!me) {
      return {
        listed: 0,
        synced: 0,
        reconciled: 0,
        truncated: false,
        skipped: [],
        errors: [],
        rateLimited: false,
        noIdentity: true,
      };
    }
    // Only MRs that involve me. GitLab has no OR across these filters, so one list per role, merged by iid.
    const common = {
      state: 'opened' as const,
      ...(opts.targetBranch ? { targetBranch: opts.targetBranch } : {}),
      ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
    };
    const lists = [
      await this.listMrs({ ...common, authorUsername: me }),
      await this.listMrs({ ...common, assigneeUsername: me }),
      await this.listMrs({ ...common, reviewerUsername: me }),
    ];
    const byIid = new Map<number, MrFields>();
    for (const l of lists) for (const m of l.mrs) byIid.set(m.iid, m);
    const list = {
      mrs: [...byIid.values()],
      truncated: lists.some((l) => l.truncated),
      skipped: lists.flatMap((l) => l.skipped),
    };
    upsertMrSummaries(this.o.store, repoId, list.mrs, this.now());

    const report: SyncReport = {
      listed: list.mrs.length,
      synced: 0,
      reconciled: 0,
      truncated: list.truncated,
      skipped: list.skipped,
      errors: [],
      rateLimited: false,
    };

    const run = async (iids: number[], counter: 'synced' | 'reconciled') => {
      const queue = [...iids];
      const worker = async () => {
        for (;;) {
          if (report.rateLimited) return;
          const iid = queue.shift();
          if (iid === undefined) return;
          try {
            await this.syncMr(iid);
            report[counter]++;
          } catch (e) {
            if (e instanceof GitlabApiError) {
              if (e.kind === 'rate_limited') report.rateLimited = true;
              report.errors.push({ iid, kind: e.kind, message: e.message });
            } else {
              report.errors.push({ iid, kind: 'unknown', message: 'unexpected error' });
              this.o.log.error({ repo: repoId, iid }, 'syncMr failed unexpectedly');
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, worker));
    };

    await run(
      list.mrs.map((m) => m.iid),
      'synced',
    );

    // Only reconcile against a complete, unfiltered open list.
    if (!list.truncated && !opts.targetBranch && list.skipped.length === 0 && !report.rateLimited) {
      const open = new Set(list.mrs.map((m) => m.iid));
      // Only my cached MRs are re-checked one by one; someone else's would cost a request each.
      const stale = listCachedOpenIids(this.o.store, repoId, me).filter((i) => !open.has(i));
      await run(stale, 'reconciled');
    }
    if (!report.rateLimited && !opts.targetBranch) await this.cacheClosedMrs(me, report);
    return report;
  }

  /**
   * The inbox reads the cache, and the open list never carries an MR that was closed before it was first cached, so
   * those are listed here. Summaries only (no per-MR requests). A failure leaves the open sync's result standing.
   */
  private async cacheClosedMrs(me: string, report: SyncReport): Promise<void> {
    const common = { state: 'closed' as const, maxPages: CLOSED_MAX_PAGES };
    try {
      const lists = [
        await this.listMrs({ ...common, authorUsername: me }),
        await this.listMrs({ ...common, assigneeUsername: me }),
        await this.listMrs({ ...common, reviewerUsername: me }),
      ];
      upsertMrSummaries(
        this.o.store,
        this.o.repo.id,
        lists.flatMap((l) => l.mrs),
        this.now(),
      );
    } catch (e) {
      if (!(e instanceof GitlabApiError)) throw e;
      if (e.kind === 'rate_limited') report.rateLimited = true;
      this.o.log.warn({ repo: this.o.repo.id, err: e.message }, 'closed MR list failed');
    }
  }
}
