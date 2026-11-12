import type {
  RepoConfig,
  SyncRunKind,
  SyncRunOutcome,
  SyncRunSummary,
  SyncSourceState,
  SyncSourceStatus,
  SyncStatus,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { GitlabApiError, GitlabService, type SyncReport } from '../services/gitlabService';
import type { HttpClient } from '../services/httpClient';
import { relinkAll } from '../services/linkStore';
import { NotionApiError, NotionService, type NotionSyncReport } from '../services/notionService';
import { runReleaseCheck } from '../services/releaseCheck';
import type { Logger } from '../util/logger';
import { diffFingerprints, fingerprintCache } from './diff';
import type { EventBus } from './eventBus';

/**
 * Orchestrates one sync run: Notion -> GitLab (per repo) -> matcher, then tells the bus
 * what actually changed. Read-only towards Notion/GitLab; writes only the local cache.
 *
 *  - Kinds:  `full`        Notion full + every repo's open MRs + relink   (startup catch-up, every 10 min)
 *            `incremental` Notion incremental (+ relink if cards changed) (every ~45 s)
 *            `refresh`     Notion incremental + the given repo(s)/all open MRs + relink (webhook)
 *  - Overlap guard: at most ONE run executes at any time. A `skip` request that finds a run in progress is
 *    dropped (timer ticks); a `queue` request is coalesced into one follow-up run that starts as soon as the
 *    current one ends (full absorbs everything; refreshes merge their repo sets).
 *  - Error isolation: Notion, each repo and the matcher are separate try/catch units; one failing never
 *    stops the others, and a failure never leaves the cache half-written (services write transactionally).
 */

export interface SyncEngineDeps {
  config: ConfigStore;
  store: AppDb;
  http: HttpClient;
  log: Logger;
  bus: EventBus;
  now?: () => number;
  /** Overrides (default: built from saved config on every run, so Settings edits apply live). */
  notion?: Pick<NotionService, 'fullSync' | 'incrementalSync'>;
  gitlabFor?: (repoId: string) => Pick<GitlabService, 'syncOpenMrs' | 'rateLimit'>;
}

export type RunResult =
  { status: 'completed'; summary: SyncRunSummary } | { status: 'skipped_busy' };

interface Plan {
  kind: SyncRunKind;
  /** Repos to sync from GitLab. */
  repoIds: ReadonlySet<string> | 'all';
}

interface Pending {
  full: boolean;
  repoIds: Set<string> | 'all';
  waiters: ((r: RunResult) => void)[];
}

const NOTION = 'notion';
const LINKS = 'links';
const gitlabSource = (repoId: string) => `gitlab:${repoId}`;

type TaskResult = {
  state: Exclude<SyncSourceState, 'never'>;
  warnings?: string[];
  error?: { kind: string; message: string };
  rateLimit?: SyncSourceStatus['rateLimit'];
};

/** Only errors raised by our own services carry a message that is known to be free of secrets. */
function describeError(e: unknown): { kind: string; message: string } {
  if (e instanceof GitlabApiError || e instanceof NotionApiError) {
    return { kind: e.kind, message: e.message };
  }
  return { kind: 'unexpected', message: 'unexpected error' };
}

export class SyncEngine {
  private readonly now: () => number;
  private current: Promise<RunResult> | undefined;
  private pending: Pending | undefined;
  private closed = false;
  private skippedBusy = 0;
  private lastRun: SyncRunSummary | null = null;
  private readonly sources = new Map<string, SyncSourceStatus>();

  constructor(private readonly d: SyncEngineDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────── public API ─────────────

  /** Notion full + all repos + relink. Queued behind a running run (it is the safety net: never dropped). */
  runFull(): Promise<RunResult> {
    return this.request({ kind: 'full', repoIds: 'all' }, 'queue');
  }

  /** Notion incremental. Timer ticks use this: dropped (`skipped_busy`) if a run is in progress. */
  runIncremental(): Promise<RunResult> {
    return this.request({ kind: 'incremental', repoIds: new Set() }, 'skip');
  }

  /**
   * Instant refresh (webhook): Notion incremental + the repo's open MRs (or every repo) + relink.
   * Bursts coalesce: while a run executes, all refreshes share ONE follow-up run.
   */
  refreshNow(repoId?: string): Promise<RunResult> {
    return this.request(
      { kind: 'refresh', repoIds: repoId === undefined ? 'all' : new Set([repoId]) },
      'queue',
    );
  }

  /** Stops accepting work and waits for the run in progress. Queued follow-ups resolve as skipped. */
  async close(): Promise<void> {
    this.closed = true;
    const waiters = this.pending?.waiters ?? [];
    this.pending = undefined;
    for (const w of waiters) w({ status: 'skipped_busy' });
    await this.current;
  }

  isRunning(): boolean {
    return this.current !== undefined;
  }

  /** Status for Sync Health / `/api/state` (poller schedule is added by the poller). */
  status(): Omit<SyncStatus, 'schedule'> {
    const live = new Set(this.d.config.listReposFull().map((r) => gitlabSource(r.id)));
    const list = [...this.sources.values()]
      .filter((s) => !s.source.startsWith('gitlab:') || live.has(s.source))
      .sort((a, b) => a.source.localeCompare(b.source));
    return {
      running: this.current !== undefined,
      queued: this.pending !== undefined,
      skippedBusy: this.skippedBusy,
      lastRun: this.lastRun,
      sources: list,
    };
  }

  // ───────────── overlap guard ─────────────

  private request(plan: Plan, whenBusy: 'queue' | 'skip'): Promise<RunResult> {
    if (this.closed) return Promise.resolve({ status: 'skipped_busy' });
    if (!this.current) return this.start(plan);
    if (whenBusy === 'skip') {
      this.skippedBusy++;
      return Promise.resolve({ status: 'skipped_busy' });
    }
    const p = this.pending ?? { full: false, repoIds: new Set<string>(), waiters: [] };
    this.pending = p;
    if (plan.kind === 'full') p.full = true;
    if (plan.repoIds === 'all') p.repoIds = 'all';
    else if (p.repoIds !== 'all') for (const id of plan.repoIds) p.repoIds.add(id);
    return new Promise<RunResult>((resolve) => p.waiters.push(resolve));
  }

  /** Runs `plan` and, when it ends, starts the coalesced follow-up (if any). `execute` never rejects. */
  private start(plan: Plan): Promise<RunResult> {
    const run = this.execute(plan);
    this.current = run;
    void run.then(() => {
      this.current = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (!next) return;
      if (this.closed) {
        for (const w of next.waiters) w({ status: 'skipped_busy' });
        return;
      }
      const followUp = this.start(
        next.full ? { kind: 'full', repoIds: 'all' } : { kind: 'refresh', repoIds: next.repoIds },
      );
      void followUp.then((r) => {
        for (const w of next.waiters) w(r);
      });
    });
    return run;
  }

  // ───────────── one run ─────────────

  private async execute(plan: Plan): Promise<RunResult> {
    const startedAt = this.now();
    const { log, bus } = this.d;
    let outcome: SyncRunOutcome = 'failed';
    let diff: ReturnType<typeof diffFingerprints> = { cardIds: [], mrs: new Map(), links: 0 };
    try {
      const before = fingerprintCache(this.d.store);
      const results: TaskResult[] = [];

      // 1) Notion (isolated)
      let relink = plan.kind !== 'incremental';
      const notion = await this.syncNotion(plan.kind);
      results.push(notion.result);
      if (notion.report) {
        const r = notion.report;
        if (r.created + r.updated + r.archivedMissing > 0 || r.promotedToFull) relink = true;
      }

      // 2) GitLab, one isolated unit per repo
      if (plan.kind !== 'incremental') {
        const repos = this.d.config
          .listReposFull()
          .filter((r) => plan.repoIds === 'all' || plan.repoIds.has(r.id))
          // Imported without secrets: no token yet, so nothing to authenticate with.
          .filter((r) => r.gitlab.token.length > 0);
        const host = this.d.config.getGlobal().gitlab.host;
        for (const repo of repos) {
          if (this.closed) break;
          results.push(await this.syncRepo(repo, Boolean(host)));
        }
      }

      // 3) matcher (local cache only; runs even if a source failed: the cache is still consistent)
      if (relink && !this.closed) results.push(this.relink());

      const after = fingerprintCache(this.d.store);
      diff = diffFingerprints(before, after);
      outcome = this.outcomeOf(results);
    } catch (e) {
      log.error({ kind: plan.kind, err: (e as Error).name }, 'sync run crashed');
    }

    const finishedAt = this.now();
    const summary: SyncRunSummary = {
      kind: plan.kind,
      startedAt,
      finishedAt,
      outcome,
      changed: {
        cards: diff.cardIds.length,
        mrs: [...diff.mrs.values()].reduce((n, l) => n + l.length, 0),
        links: diff.links,
      },
    };
    this.lastRun = summary;

    const line = { kind: plan.kind, outcome, ms: finishedAt - startedAt, changed: summary.changed };
    if (plan.kind === 'incremental' && outcome === 'ok' && isEmpty(summary)) {
      log.debug(line, 'sync run finished');
    } else {
      log.info(line, 'sync run finished');
    }

    // Events last, after the run is recorded; a listener can never break the engine (EventBus guards).
    if (diff.cardIds.length > 0) bus.emit({ type: 'cards.changed', cardIds: diff.cardIds });
    for (const [repoId, iids] of diff.mrs) bus.emit({ type: 'mrs.changed', repoId, iids });
    if (diff.links > 0) bus.emit({ type: 'links.changed' });
    bus.emit({ type: 'health.changed' });
    return { status: 'completed', summary };
  }

  private outcomeOf(results: TaskResult[]): SyncRunOutcome {
    const attempted = results.filter((r) => r.state !== 'skipped');
    if (attempted.length === 0) return 'ok';
    const errors = attempted.filter((r) => r.state === 'error').length;
    if (errors === attempted.length) return 'failed';
    if (errors > 0 || attempted.some((r) => r.state === 'partial')) return 'partial';
    return 'ok';
  }

  // ───────────── units ─────────────

  private async syncNotion(
    kind: SyncRunKind,
  ): Promise<{ result: TaskResult; report?: NotionSyncReport }> {
    const t0 = this.now();
    let result: TaskResult;
    let report: NotionSyncReport | undefined;
    try {
      const svc =
        this.d.notion ??
        NotionService.fromConfig(this.d.config, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
      report = await (kind === 'full' ? svc.fullSync() : svc.incrementalSync());
      const warnings: string[] = [];
      if (report.truncated) warnings.push('truncated: more pages than the limit');
      if (report.skipped.length > 0) warnings.push(`${report.skipped.length} page(s) skipped`);
      for (const p of report.problems) warnings.push(`property ${p.role}: ${p.kind}`);
      if (report.identity.status !== 'ok') warnings.push(`identity: ${report.identity.status}`);
      result = {
        state: report.truncated || report.skipped.length > 0 ? 'partial' : 'ok',
        warnings,
      };
    } catch (e) {
      const err = describeError(e);
      result =
        e instanceof NotionApiError && e.kind === 'not_configured'
          ? {
              state: 'skipped',
              warnings: [
                e.code === 'no_user_id'
                  ? 'Not synced: add your Notion user id under Settings → Notion → My names (the Assignee property must be a people property)'
                  : 'Notion is not configured',
              ],
            }
          : { state: 'error', error: err };
    }
    this.record(NOTION, t0, result);
    return report ? { result, report } : { result };
  }

  private async syncRepo(repo: RepoConfig, hostConfigured: boolean): Promise<TaskResult> {
    const source = gitlabSource(repo.id);
    const t0 = this.now();
    let result: TaskResult;
    if (!hostConfigured) {
      result = { state: 'skipped', warnings: ['GitLab host is not configured'] };
      this.record(source, t0, result);
      return result;
    }
    let rateLimit: SyncSourceStatus['rateLimit'] = null;
    try {
      // An injected `gitlabFor` (tests) has no repository reads: the release check needs the real service.
      const real = this.d.gitlabFor
        ? undefined
        : GitlabService.forRepo(this.d.config, repo.id, {
            http: this.d.http,
            store: this.d.store,
            log: this.d.log,
          });
      const svc = this.d.gitlabFor?.(repo.id) ?? real!;
      let report: SyncReport;
      let releaseWarnings: string[] = [];
      try {
        report = await svc.syncOpenMrs();
        // Re-evaluated on every sync of the repo, which includes every merge_request/push webhook.
        if (real && !report.rateLimited) {
          const check = await runReleaseCheck({
            app: this.d.store,
            repo,
            gitlab: real,
            now: this.now(),
          });
          releaseWarnings = check.warnings;
        }
      } finally {
        const rl = svc.rateLimit();
        rateLimit = {
          limit: rl.limit ?? null,
          remaining: rl.remaining ?? null,
          resetAt: rl.resetAt ?? null,
        };
      }
      const warnings: string[] = [];
      if (report.errors.length > 0) warnings.push(`${report.errors.length} MR sync error(s)`);
      if (report.rateLimited) warnings.push('rate limited: run stopped early');
      if (report.truncated) warnings.push('truncated: more pages than the limit');
      if (report.skipped.length > 0) warnings.push(`${report.skipped.length} MR(s) skipped`);
      if (report.noIdentity) {
        warnings.push('open MRs not synced: set your GitLab username in Settings → GitLab');
      }
      warnings.push(...releaseWarnings);
      result = { state: warnings.length > 0 ? 'partial' : 'ok', warnings, rateLimit };
    } catch (e) {
      result = { state: 'error', error: describeError(e), rateLimit };
    }
    this.record(source, t0, result);
    return result;
  }

  private relink(): TaskResult {
    const t0 = this.now();
    let result: TaskResult;
    try {
      relinkAll(this.d.store, this.d.config.listReposFull());
      result = { state: 'ok' };
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'relink failed');
      result = { state: 'error', error: { kind: 'unexpected', message: 'matcher failed' } };
    }
    this.record(LINKS, t0, result);
    return result;
  }

  // ───────────── status book ─────────────

  private record(source: string, t0: number, r: TaskResult): void {
    const t1 = this.now();
    const prev = this.sources.get(source);
    const failed = r.state === 'error';
    const next: SyncSourceStatus = {
      source,
      state: r.state,
      lastAttemptAt: t0,
      lastSuccessAt: r.state === 'ok' || r.state === 'partial' ? t1 : (prev?.lastSuccessAt ?? null),
      lastDurationMs: t1 - t0,
      // A skipped (not configured) source is neither a failure nor a recovery.
      consecutiveFailures: failed
        ? (prev?.consecutiveFailures ?? 0) + 1
        : r.state === 'skipped'
          ? (prev?.consecutiveFailures ?? 0)
          : 0,
      error: failed ? (r.error ?? null) : null,
      warnings: r.warnings ?? [],
      rateLimit: r.rateLimit ?? prev?.rateLimit ?? null,
    };
    this.sources.set(source, next);

    // Log on transitions only: a down service must not write a line every 45 s.
    if (failed) {
      const line = { source, kind: r.error?.kind, failures: next.consecutiveFailures };
      if (prev?.state !== 'error' || prev.error?.kind !== r.error?.kind) {
        this.d.log.warn(line, 'sync source failed');
      } else {
        this.d.log.debug(line, 'sync source failed');
      }
    } else if (prev?.state === 'error') {
      this.d.log.info({ source }, 'sync source recovered');
    }
  }
}

const isEmpty = (s: SyncRunSummary) =>
  s.changed.cards === 0 && s.changed.mrs === 0 && s.changed.links === 0;
