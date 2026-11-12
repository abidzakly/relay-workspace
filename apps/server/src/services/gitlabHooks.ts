import { z } from 'zod';
import { HOOK_EVENT_FLAGS, type HookEventFlag, type WebhookHookSummary } from '@relay/shared';
import { GitlabClient } from './gitlab';
import { GitlabApiError, type GitlabErrorKind } from './gitlabService';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';

/**
 * GitLab Project Hooks API: list / create / update / delete.
 * Shapes follow GitLab's documented API (`/projects/:id/hooks`) and are UNVERIFIED against the live
 * instance (no sample was attached) (no live sample was checked). The hook `token` is write-only in GitLab: it is
 * never returned, so it can neither be read back nor logged from here.
 */

/** Everything we subscribe to; anything not listed is explicitly switched OFF on create/update. */
const ALL_EVENT_FLAGS = [
  'push_events',
  'tag_push_events',
  'merge_requests_events',
  'note_events',
  'confidential_note_events',
  'issues_events',
  'confidential_issues_events',
  'pipeline_events',
  'job_events',
  'wiki_page_events',
  'deployment_events',
  'releases_events',
] as const;

const WANTED = new Set<string>(HOOK_EVENT_FLAGS);

/** Raw hook as GitLab documents it (lenient: fields differ between versions). */
const RawHookSchema = z
  .object({
    id: z.number().int(),
    url: z.string(),
    enable_ssl_verification: z.boolean().optional(),
    alert_status: z.string().nullish(),
  })
  .loose();

const pathOnly = (p: string) => p.split('?')[0] ?? p;

function kindOf(status: number): GitlabErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'bad_response';
}

/** True when `hookUrl`'s path is `.../webhook/<repoId>` (ours, whatever the base URL was). */
export function isOurHookUrl(hookUrl: string, repoId: string): boolean {
  try {
    return new URL(hookUrl).pathname.replace(/\/+$/, '').endsWith(`/webhook/${repoId}`);
  } catch {
    return false;
  }
}

/** Raw hook -> summary (no token ever). `expectedUrl` may be null while the public URL is unusable. */
export function summarizeHook(
  raw: unknown,
  repoId: string,
  expectedUrl: string | null,
): WebhookHookSummary | undefined {
  const parsed = RawHookSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const h = parsed.data as Record<string, unknown> & z.infer<typeof RawHookSchema>;
  const flag = (k: HookEventFlag) => h[k] === true;
  const extra = ALL_EVENT_FLAGS.filter((k) => !WANTED.has(k) && h[k] === true);
  return {
    id: h.id,
    url: h.url,
    ours: isOurHookUrl(h.url, repoId),
    urlMatches: expectedUrl !== null && h.url === expectedUrl,
    events: {
      merge_requests: flag('merge_requests_events'),
      note: flag('note_events'),
      pipeline: flag('pipeline_events'),
      push: flag('push_events'),
    },
    extraEvents: [...extra],
    sslVerification:
      typeof h.enable_ssl_verification === 'boolean' ? h.enable_ssl_verification : null,
    alertStatus: typeof h.alert_status === 'string' ? h.alert_status : null,
  };
}

/** Body for POST/PUT: our four events on, every other event off, SSL verification on. */
export function hookParams(url: string, token: string): Record<string, unknown> {
  const body: Record<string, unknown> = { url, token, enable_ssl_verification: true };
  for (const k of ALL_EVENT_FLAGS) body[k] = WANTED.has(k);
  return body;
}

export class GitlabHooksApi {
  private readonly client: GitlabClient;

  constructor(
    host: string,
    token: string,
    private readonly projectId: number,
    http: HttpClient,
  ) {
    this.client = new GitlabClient(host, token, http);
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

  /** `GET /projects/:id/hooks` (all pages, max 5 x 100). Raw objects; use `summarizeHook`. */
  async list(): Promise<unknown[]> {
    const base = `/projects/${this.projectId}/hooks`;
    const out: unknown[] = [];
    for (let page = 1; page <= 5; page++) {
      const path = `${base}?per_page=100&page=${page}`;
      const res = await this.call(() => this.client.get(path), pathOnly(path));
      if (res.status === 204) break;
      if (!Array.isArray(res.json)) throw new GitlabApiError('bad_response', res.status, base);
      out.push(...res.json);
      const raw = res.headers['x-next-page'];
      const next = Number(Array.isArray(raw) ? raw[0] : raw);
      if (!Number.isInteger(next) || next <= page) break;
    }
    return out;
  }

  /** `POST /projects/:id/hooks` -> the new hook id. A WRITE: call only through `guardedWrite`. */
  async create(url: string, token: string): Promise<number> {
    const path = `/projects/${this.projectId}/hooks`;
    const res = await this.call(
      () => this.client.write('POST', path, hookParams(url, token)),
      path,
    );
    return this.idOf(res, path);
  }

  /** `PUT /projects/:id/hooks/:hookId`. A WRITE: call only through `guardedWrite`. */
  async update(hookId: number, url: string, token: string): Promise<number> {
    const path = `/projects/${this.projectId}/hooks/${hookId}`;
    const res = await this.call(() => this.client.write('PUT', path, hookParams(url, token)), path);
    return this.idOf(res, path);
  }

  /**
   * `POST /projects/:id/hooks/:hookId/test/:trigger` (GitLab >= 16.11): GitLab sends a sample event
   * to the hook URL right now and answers 201 when our listener returned 2xx, else 422 with GitLab's
   * message (e.g. "Hook executed successfully but returned HTTP 401 ..."). It changes nothing in
   * GitLab's configuration, so it is NOT routed through `guardedWrite`; it only ever runs from the
   * user's "Test connection" click. Returns the raw response (no throw for 4xx) so the caller can
   * explain each case.
   */
  async test(hookId: number, trigger: 'push_events'): Promise<HttpResponse> {
    const path = `/projects/${this.projectId}/hooks/${hookId}/test/${trigger}`;
    try {
      return await this.client.write('POST', path);
    } catch (e) {
      if (e instanceof HttpNetworkError) throw new GitlabApiError('network', undefined, path);
      throw e;
    }
  }

  /** `DELETE /projects/:id/hooks/:hookId` (204). A WRITE: call only through `guardedWrite`. */
  async delete(hookId: number): Promise<void> {
    const path = `/projects/${this.projectId}/hooks/${hookId}`;
    await this.call(() => this.client.write('DELETE', path), path);
  }

  private idOf(res: HttpResponse, path: string): number {
    const id = (res.json as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new GitlabApiError('bad_response', res.status, pathOnly(path));
    }
    return id;
  }
}
