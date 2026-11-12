import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import {
  HOOK_EVENT_FLAGS,
  type RepoConfig,
  type WebhookEventStatus,
  type WebhookHookSummary,
  type WebhookProblem,
  type WebhookRegisterAllResult,
  type WebhookRegisterResult,
  type WebhookState,
  type WebhookStatus,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { events } from '../db/schema';
import type { Logger } from '../util/logger';
import { guardedWrite } from './dryRun';
import { GitlabHooksApi, isOurHookUrl, summarizeHook } from './gitlabHooks';
import { GitlabApiError } from './gitlabService';
import type { HttpClient } from './httpClient';

/**
 * Per-repo GitLab project-hook management: list, register (create or update), delete,
 * and "Re-register all" (the ngrok URL changed).
 *
 * Every GitLab WRITE goes through `guardedWrite`: it needs the explicit user action that reached the
 * route (`confirmed: true` is only ever passed from the HTTP handlers, never from a timer or a
 * webhook), honours the global dry-run (GitLab is then NOT called; the audit row says `dryRun`),
 * and is audited with before/after (no token anywhere) and an undo token. Nothing registers hooks
 * automatically, not even at startup.
 */

export class WebhookError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'WebhookError';
  }
}

export interface WebhookRegistryDeps {
  config: ConfigStore;
  audit: AuditWriter;
  store: AppDb;
  http: HttpClient;
  log: Logger;
}

type Plan = {
  /** Already correct: no write. */
  unchanged: boolean;
  existing: WebhookHookSummary | undefined;
};

/** Builds `<publicBaseUrl>/webhook/<repoId>`; `problem` says why that is impossible. */
export function expectedWebhookUrl(
  publicBaseUrl: string | undefined,
  repoId: string,
): { url: string; problem: null } | { url: null; problem: WebhookProblem } {
  if (!publicBaseUrl) return { url: null, problem: 'public_url_missing' };
  let u: URL;
  try {
    u = new URL(publicBaseUrl);
  } catch {
    return { url: null, problem: 'public_url_missing' };
  }
  // The secret token travels in a header of every delivery: only ever over TLS.
  if (u.protocol !== 'https:') return { url: null, problem: 'public_url_not_https' };
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return { url: `${base}/webhook/${repoId}`, problem: null };
}

export const PROBLEM_TEXT: Record<WebhookProblem, string> = {
  public_url_missing: 'Set Settings → Public URL (your ngrok https domain) first.',
  public_url_not_https: 'The public URL must be https: the webhook token is sent in a header.',
  gitlab_host_missing: 'Set Settings → GitLab host first.',
};

export function isHealthy(h: WebhookHookSummary): boolean {
  return (
    h.urlMatches &&
    h.events.merge_requests &&
    h.events.note &&
    h.events.pipeline &&
    h.events.push &&
    h.extraEvents.length === 0 &&
    h.sslVerification !== false &&
    (h.alertStatus === null || h.alertStatus === 'executable')
  );
}

/** Our hook among a project's hooks: the exact-URL one first, else a stale `…/webhook/<id>` one. */
export function pickOurs(hooks: WebhookHookSummary[]): WebhookHookSummary | undefined {
  return hooks.find((h) => h.urlMatches) ?? hooks.find((h) => h.ours);
}

export function errInfo(e: unknown): { kind: string; message: string } {
  if (e instanceof GitlabApiError) {
    const hint =
      e.kind === 'forbidden'
        ? ' (managing webhooks needs the Maintainer role and an `api`-scope token)'
        : e.kind === 'not_found'
          ? ' (project id wrong, or the token cannot see the project)'
          : '';
    return { kind: e.kind, message: `${e.message}${hint}` };
  }
  if (e instanceof WebhookError) return { kind: e.code, message: e.message };
  return { kind: 'unexpected', message: 'unexpected error' };
}

export class WebhookRegistry {
  constructor(private readonly d: WebhookRegistryDeps) {}

  private context(repoId: string): {
    repo: RepoConfig;
    api: GitlabHooksApi;
    secret: string;
    expected: ReturnType<typeof expectedWebhookUrl>;
  } {
    const repo = this.d.config.getRepo(repoId);
    if (!repo) throw new WebhookError(404, 'repo_not_found');
    const g = this.d.config.getGlobal();
    if (!g.gitlab.host) {
      throw new WebhookError(400, 'gitlab_host_missing', PROBLEM_TEXT.gitlab_host_missing);
    }
    const secret = this.d.config.getWebhookSecret(repoId);
    if (!secret)
      throw new WebhookError(500, 'webhook_secret_missing', 'repo has no webhook secret');
    return {
      repo,
      api: new GitlabHooksApi(g.gitlab.host, repo.gitlab.token, repo.gitlab.projectId, this.d.http),
      secret,
      expected: expectedWebhookUrl(g.publicBaseUrl, repoId),
    };
  }

  private async hooksOf(
    api: GitlabHooksApi,
    repoId: string,
    expectedUrl: string | null,
  ): Promise<WebhookHookSummary[]> {
    const raw = await api.list();
    const out: WebhookHookSummary[] = [];
    for (const r of raw) {
      const s = summarizeHook(r, repoId, expectedUrl);
      if (s) out.push(s);
    }
    return out;
  }

  /** READ ONLY: hook list + verdict + last delivery. Never writes, never throws for GitLab errors. */
  async status(repoId: string): Promise<WebhookStatus> {
    const repo = this.d.config.getRepo(repoId);
    if (!repo) throw new WebhookError(404, 'repo_not_found');
    const g = this.d.config.getGlobal();
    const expected = expectedWebhookUrl(g.publicBaseUrl, repoId);
    const lastEvent = this.lastEvent(repoId);
    const base = { repoId, expectedUrl: expected.url, lastEvent };

    if (!g.gitlab.host) {
      return {
        ...base,
        problem: 'gitlab_host_missing',
        state: 'unknown',
        hooks: [],
        gitlabError: null,
      };
    }
    let hooks: WebhookHookSummary[];
    try {
      const api = new GitlabHooksApi(
        g.gitlab.host,
        repo.gitlab.token,
        repo.gitlab.projectId,
        this.d.http,
      );
      hooks = await this.hooksOf(api, repoId, expected.url);
    } catch (e) {
      return {
        ...base,
        problem: expected.problem,
        state: 'unknown',
        hooks: [],
        gitlabError: errInfo(e),
      };
    }
    const ours = pickOurs(hooks);
    let state: WebhookState;
    if (!ours) state = 'missing';
    else if (ours.alertStatus !== null && ours.alertStatus !== 'executable') state = 'disabled';
    else state = isHealthy(ours) ? 'registered' : 'outdated';
    return { ...base, problem: expected.problem, state, hooks, gitlabError: null };
  }

  private lastEvent(repoId: string): WebhookStatus['lastEvent'] {
    const r = this.d.store.db
      .select({
        receivedAt: events.receivedAt,
        objectKind: events.objectKind,
        status: events.status,
      })
      .from(events)
      .where(eq(events.repoId, repoId))
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(1)
      .get();
    return r
      ? {
          receivedAt: r.receivedAt,
          objectKind: r.objectKind,
          status: r.status as WebhookEventStatus,
        }
      : null;
  }

  /**
   * Creates the repo's hook, or updates the stale/incorrect one. `force` re-sends even a hook that
   * looks right (GitLab never returns the token, so a rotated/typo'd secret is not detectable).
   * Throws `WebhookError` for input problems; GitLab failures come back as `outcome:'failed'`.
   */
  async register(
    repoId: string,
    opts: { force?: boolean; batchId?: string | null } = {},
  ): Promise<WebhookRegisterResult> {
    const ctx = this.context(repoId);
    if (ctx.expected.problem) {
      throw new WebhookError(400, ctx.expected.problem, PROBLEM_TEXT[ctx.expected.problem]);
    }
    const url = ctx.expected.url;

    let plan: Plan;
    try {
      const hooks = await this.hooksOf(ctx.api, repoId, url);
      const existing = pickOurs(hooks);
      plan = { existing, unchanged: !opts.force && existing !== undefined && isHealthy(existing) };
    } catch (e) {
      return this.failed(repoId, url, e);
    }
    if (plan.unchanged) {
      return {
        repoId,
        outcome: 'unchanged',
        dryRun: this.d.config.isDryRun(),
        url,
        hookId: plan.existing!.id,
        auditId: null,
        error: null,
      };
    }

    const existing = plan.existing;
    const wanted = Object.fromEntries(HOOK_EVENT_FLAGS.map((f) => [f, true]));
    try {
      const out = await guardedWrite<number>(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: existing ? 'webhook.update' : 'webhook.create',
          targetType: 'repo',
          targetId: repoId,
          // The route that calls this is the user's click; no timer or webhook ever reaches here.
          confirmed: true,
          // Public facts only. The token is never read back from GitLab and never audited.
          before: existing ?? null,
          after: { url, events: wanted, sslVerification: true, hookId: existing?.id ?? null },
          reversible: true,
          batchId: opts.batchId ?? null,
          simulated: existing?.id ?? 0,
          run: () =>
            existing
              ? ctx.api.update(existing.id, url, ctx.secret)
              : ctx.api.create(url, ctx.secret),
        },
      );
      const hookId = out.dryRun ? (existing?.id ?? null) : out.result;
      this.d.log.info(
        { repoId, outcome: existing ? 'updated' : 'created', dryRun: out.dryRun, hookId },
        'webhook registered',
      );
      return {
        repoId,
        outcome: existing ? 'updated' : 'created',
        dryRun: out.dryRun,
        url,
        hookId,
        auditId: out.audit.id,
        error: null,
      };
    } catch (e) {
      return this.failed(repoId, url, e);
    }
  }

  /** "Re-register all": every repo, sequentially, one shared batch id; one failure never stops the rest. */
  async registerAll(opts: { force?: boolean } = {}): Promise<WebhookRegisterAllResult> {
    const batchId = randomUUID();
    const results: WebhookRegisterResult[] = [];
    for (const repo of this.d.config.listReposFull()) {
      try {
        results.push(await this.register(repo.id, { ...opts, batchId }));
      } catch (e) {
        const info = errInfo(e);
        results.push({
          repoId: repo.id,
          outcome: 'failed',
          dryRun: this.d.config.isDryRun(),
          url: null,
          hookId: null,
          auditId: null,
          error: info,
        });
      }
    }
    return { dryRun: this.d.config.isDryRun(), results };
  }

  /**
   * Deletes one of OUR hooks (path `…/webhook/<repoId>`) after re-reading the list: this endpoint
   * cannot be used to delete an unrelated hook of the project.
   */
  async remove(repoId: string, hookId: number): Promise<{ dryRun: boolean; auditId: number }> {
    const ctx = this.context(repoId);
    let hooks: WebhookHookSummary[];
    try {
      hooks = await this.hooksOf(ctx.api, repoId, ctx.expected.url);
    } catch (e) {
      const i = errInfo(e);
      throw new WebhookError(502, 'gitlab_error', i.message);
    }
    const target = hooks.find((h) => h.id === hookId);
    if (!target) throw new WebhookError(404, 'hook_not_found');
    if (!isOurHookUrl(target.url, repoId)) {
      throw new WebhookError(
        403,
        'not_our_hook',
        'only hooks created for this repo can be deleted here',
      );
    }
    try {
      const out = await guardedWrite<void>(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'webhook.delete',
          targetType: 'repo',
          targetId: repoId,
          confirmed: true,
          before: target,
          after: null,
          reversible: true,
          run: () => ctx.api.delete(hookId),
        },
      );
      return { dryRun: out.dryRun, auditId: out.audit.id };
    } catch (e) {
      const i = errInfo(e);
      throw new WebhookError(502, 'gitlab_error', i.message);
    }
  }

  private failed(repoId: string, url: string | null, e: unknown): WebhookRegisterResult {
    const error = errInfo(e);
    this.d.log.warn({ repoId, kind: error.kind }, 'webhook registration failed');
    return {
      repoId,
      outcome: 'failed',
      dryRun: this.d.config.isDryRun(),
      url,
      hookId: null,
      auditId: null,
      error,
    };
  }
}
