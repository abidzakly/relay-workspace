import { and, eq, inArray } from 'drizzle-orm';
import type { ReadyForMr } from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { branchPushes, mrs } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { GitlabApiError, GitlabService } from './gitlabService';
import type { HttpClient } from './httpClient';
import { loadStackRefs } from './mrStack';
import type { Notifier } from './notifier';
import { listCards } from './notionStore';
import type { PushEvent } from './webhookEvents';

/**
 * "Ready for MR". A pushed branch is READY when it equals a card's Branch formula
 * (exact, like MR title matching) and has no open MR. Pushes come from the webhook; a branch-list poll every few
 * minutes is the fallback when webhooks are missing. Pushed heads also feed the stack check (a parent branch without MR).
 */

export const POLL_MS = 5 * 60_000;

export interface ReadyForMrDeps {
  config: ConfigStore;
  store: AppDb;
  http: HttpClient;
  log: Logger;
  notifier?: Notifier;
  bus?: EventBus;
  now?: () => number;
}

/** Pure: which pushed branches are ready (card match + no open MR). */
export function readyBranches(
  pushes: readonly { repoId: string; branch: string }[],
  cards: readonly { id: string; branchName: string | null }[],
  openMrBranches: ReadonlySet<string>,
): { repoId: string; branch: string; cardId: string }[] {
  const byBranch = new Map<string, string>();
  for (const c of cards) {
    const b = c.branchName?.trim();
    if (b && !byBranch.has(b)) byBranch.set(b, c.id);
  }
  const out: { repoId: string; branch: string; cardId: string }[] = [];
  for (const p of pushes) {
    const cardId = byBranch.get(p.branch);
    if (cardId && !openMrBranches.has(`${p.repoId}:${p.branch}`)) out.push({ ...p, cardId });
  }
  return out;
}

export class ReadyForMrService {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly d: ReadyForMrDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private svc(repoId: string): GitlabService | null {
    try {
      return GitlabService.forRepo(this.d.config, repoId, {
        http: this.d.http,
        store: this.d.store,
        log: this.d.log,
      });
    } catch {
      return null;
    }
  }

  /** An MR is open for the branch, as far as the local MR cache knows. */
  hasOpenMr(repoId: string, branch: string): boolean {
    return this.openMrBranches().has(`${repoId}:${branch}`);
  }

  private openMrBranches(): Set<string> {
    return this.mrBranches(['opened', 'locked']);
  }

  /** Open OR merged MR for the branch: a merged parent must not count as "no MR yet" (stale push row). */
  private openOrMergedBranches(): Set<string> {
    return this.mrBranches(['opened', 'locked', 'merged']);
  }

  private mrBranches(states: string[]): Set<string> {
    return new Set(
      this.d.store.db
        .select({ repoId: mrs.repoId, branch: mrs.sourceBranch })
        .from(mrs)
        .where(inArray(mrs.state, states))
        .all()
        .map((r) => `${r.repoId}:${r.branch}`),
    );
  }

  private upsert(
    repoId: string,
    branch: string,
    sha: string,
    at: number,
    actor: string | null,
  ): boolean {
    const prior = this.d.store.db
      .select({ sha: branchPushes.sha })
      .from(branchPushes)
      .where(and(eq(branchPushes.repoId, repoId), eq(branchPushes.branch, branch)))
      .get();
    if (prior?.sha === sha) return false;
    this.d.store.db
      .insert(branchPushes)
      .values({ repoId, branch, sha, pushedAt: at, actor, commits: null })
      .onConflictDoUpdate({
        target: [branchPushes.repoId, branchPushes.branch],
        set: { sha, pushedAt: at, actor, commits: null },
      })
      .run();
    return true;
  }

  private remove(repoId: string, branch: string): void {
    this.d.store.db
      .delete(branchPushes)
      .where(and(eq(branchPushes.repoId, repoId), eq(branchPushes.branch, branch)))
      .run();
  }

  /** Webhook push (called after the cache update). Never throws. */
  onPush(repoId: string, ev: PushEvent): void {
    try {
      const repo = this.d.config.getRepo(repoId);
      if (!repo || !ev.branch || ev.branch === repo.baseBranch) return;
      if (ev.deleted) {
        this.remove(repoId, ev.branch);
        this.changed();
        return;
      }
      if (!ev.sha) return;
      if (this.upsert(repoId, ev.branch, ev.sha, ev.lastCommitAt ?? this.now(), ev.actor ?? null)) {
        void this.refreshCommits(repoId, ev.branch).then(() => this.afterChange());
      }
    } catch (e) {
      this.d.log.warn({ repo: repoId, err: (e as Error).message }, 'branch push record failed');
    }
  }

  /** `base...branch` commit ids for the stack layout and the commit count. */
  async refreshCommits(repoId: string, branch: string): Promise<void> {
    const repo = this.d.config.getRepo(repoId);
    const svc = this.svc(repoId);
    if (!repo || !svc) return;
    try {
      const r = await svc.compare(repo.baseBranch, branch);
      this.d.store.db
        .update(branchPushes)
        .set({ commits: r.commits.map((c) => c.id.toLowerCase()) })
        .where(and(eq(branchPushes.repoId, repoId), eq(branchPushes.branch, branch)))
        .run();
    } catch (e) {
      this.d.log.debug(
        { repo: repoId, branch, err: e instanceof GitlabApiError ? e.message : 'error' },
        'branch compare failed',
      );
    }
  }

  /** Fallback when webhooks are missing: branch heads of every repo, only branches some card names. */
  async poll(): Promise<void> {
    const cards = new Set(
      listCards(this.d.store)
        .map((c) => c.branchName?.trim())
        .filter((b): b is string => !!b),
    );
    let changed = false;
    for (const repo of this.d.config.listRepos()) {
      if (this.closed) return;
      const svc = this.svc(repo.id);
      if (!svc) continue;
      let list;
      try {
        list = await svc.listBranches();
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const b of list.branches) {
        if (b.default || b.merged || b.name === repo.baseBranch || !cards.has(b.name) || !b.sha)
          continue;
        seen.add(b.name);
        if (this.upsert(repo.id, b.name, b.sha, b.committedAt ?? this.now(), null)) {
          await this.refreshCommits(repo.id, b.name);
          changed = true;
        }
      }
      if (!list.truncated) {
        // Branches deleted on GitLab (merged + removed): forget them.
        for (const row of this.rows(repo.id)) {
          if (!seen.has(row.branch) && cards.has(row.branch)) {
            this.remove(repo.id, row.branch);
            changed = true;
          }
        }
      }
    }
    if (changed) this.afterChange();
  }

  start(): void {
    const tick = () => {
      if (this.closed) return;
      void this.poll()
        .catch((e: unknown) => this.d.log.warn({ err: (e as Error).message }, 'branch poll failed'))
        .finally(() => {
          if (!this.closed) this.timer = setTimeout(tick, POLL_MS).unref();
        });
    };
    this.timer = setTimeout(tick, 15_000).unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private rows(repoId?: string) {
    const q = this.d.store.db.select().from(branchPushes);
    return repoId ? q.where(eq(branchPushes.repoId, repoId)).all() : q.all();
  }

  /** Pushed heads of a repo that have no open MR: stack parents "belum ada MR" for the merge gate. */
  branchHeads(repoId: string): { branch: string; sha: string }[] {
    const open = this.openOrMergedBranches();
    return this.rows(repoId)
      .filter((r) => !open.has(`${repoId}:${r.branch}`))
      .map((r) => ({ branch: r.branch, sha: r.sha }));
  }

  /** The "Ready for MR" list, with stack placement (parent at the bottom). */
  list(): ReadyForMr[] {
    const rows = this.rows();
    const cards = listCards(this.d.store);
    const cardBy = new Map(cards.map((c) => [c.id, c] as const));
    const open = this.openOrMergedBranches();
    const ready = readyBranches(rows, cards, open);
    const readySet = new Set(ready.map((r) => `${r.repoId}:${r.branch}`));
    const layout = loadStackRefs(
      this.d.store,
      rows
        .filter((r) => readySet.has(`${r.repoId}:${r.branch}`))
        .map((r) => ({
          repoId: r.repoId,
          branch: r.branch,
          sha: r.sha,
          commits: r.commits ?? null,
        })),
    );
    const repoName = new Map(this.d.config.listRepos().map((r) => [r.id, r.name] as const));
    return ready
      .map((r) => {
        const row = rows.find((x) => x.repoId === r.repoId && x.branch === r.branch)!;
        const c = cardBy.get(r.cardId)!;
        return {
          repoId: r.repoId,
          repoName: repoName.get(r.repoId) ?? r.repoId,
          branch: r.branch,
          sha: row.sha,
          pushedAt: row.pushedAt,
          actor: row.actor,
          card: { id: c.id, title: c.title, url: c.url ?? null, status: c.status ?? null },
          commitCount: row.commits ? row.commits.length : null,
          stack: layout.refs.get(`${r.repoId}:${r.branch}`) ?? null,
        };
      })
      .sort((a, b) => b.pushedAt - a.pushedAt);
  }

  private changed(): void {
    try {
      this.d.bus?.emit({ type: 'cockpit.changed', what: 'ready' });
    } catch {
      /* cosmetic */
    }
  }

  /** Notifies newly ready heads once each ("Branch X sudah di-push, buat MR?"). */
  private afterChange(): void {
    this.changed();
    if (!this.d.notifier) return;
    const rowsBy = new Map(this.rows().map((r) => [`${r.repoId}:${r.branch}`, r] as const));
    for (const item of this.list()) {
      const row = rowsBy.get(`${item.repoId}:${item.branch}`);
      if (!row || row.notifiedSha === row.sha) continue;
      this.d.notifier.notifyCockpit({
        event: 'readyForMr',
        key: `ready:${item.repoId}:${item.branch}:${row.sha}`,
        ttlMs: 24 * 60 * 60_000,
        title: `Branch ready for an MR`,
        body: `${item.branch} was pushed (${item.repoName}). Create an MR?`,
        url: `/mr-create/${encodeURIComponent(item.repoId)}?branch=${encodeURIComponent(item.branch)}`,
        tag: `ready-${item.repoId}-${item.branch}`,
        repoId: item.repoId,
        subject: { kind: 'branch', repoId: item.repoId, branch: item.branch },
      });
      this.d.store.db
        .update(branchPushes)
        .set({ notifiedSha: row.sha })
        .where(and(eq(branchPushes.repoId, item.repoId), eq(branchPushes.branch, item.branch)))
        .run();
    }
  }
}
