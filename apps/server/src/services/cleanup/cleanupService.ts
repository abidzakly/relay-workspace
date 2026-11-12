import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import type { CleanupCandidate, CleanupResult, CleanupScan } from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db/open';
import {
  branchPushes,
  cards,
  cockpitAttachments,
  jobs,
  mrs,
  notesCache,
  testFindings,
  testRuns,
  workspaces as workspacesTable,
} from '../../db/schema';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import type { CockpitHost } from '../cockpit/host';
import type { CockpitSessionService } from '../cockpit/sessionService';
import type { WorkspaceService } from '../cockpit/workspaces';
import { SCRCPY_SERVER_VERSION } from '../device/scrcpyVersion';
import { FIGMA_CARDS_DIR } from '../figma/snapshotStore';
import {
  dataCandidates,
  tmpCandidates,
  workspaceCandidates,
  type CardFact,
  type DataFacts,
  type DbFacts,
  type FsEntry,
  type MrFact,
  type PlannedCandidate,
} from './rules';

/**
 * Storage cleanup (no AI). `scan()` gathers facts (DB, the Mac through the host, the server's data dir) and runs the
 * fixed rules in `rules.ts`. `apply(ids)` scans AGAIN and deletes only the ids that still match a rule, so anything
 * that changed since the user looked (a branch got a commit, a card reopened) is kept. A workspace with a session
 * still running is not touched at all. Once a day the safe tier runs by itself when Settings allows it.
 */

const AUTO_FIRST_MS = 10 * 60 * 1000;
const AUTO_EVERY_MS = 24 * 60 * 60 * 1000;
const RUN_ID_RE = /^[0-9a-f-]{36}$/;
const REPO_DIR_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface CleanupDeps {
  store: AppDb;
  config: ConfigStore;
  host: CockpitHost;
  workspaces: WorkspaceService;
  sessions: CockpitSessionService;
  audit: AuditWriter;
  log: Logger;
  dataDir: string;
  clonesRoot: string;
  now?: () => number;
}

export class CleanupService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | null = null;
  private last: CleanupResult | null = null;
  private readonly now: () => number;

  constructor(private readonly d: CleanupDeps) {
    this.now = d.now ?? Date.now;
  }

  lastResult(): CleanupResult | null {
    return this.last;
  }

  start(): void {
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.autoRun().finally(() => tick(AUTO_EVERY_MS));
      }, delay);
      this.timer.unref?.();
    };
    tick(AUTO_FIRST_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async autoRun(): Promise<void> {
    if (!this.d.config.getGlobalStored().storageCleanup.auto) return;
    try {
      const scan = await this.plan();
      const ids = scan.candidates.filter((c) => c.tier === 'safe').map((c) => c.id);
      if (ids.length === 0) return;
      const r = await this.apply(ids, { auto: true });
      this.d.log.info(
        { removed: r.removed.length, failed: r.failed.length, bytes: r.bytesFreed },
        'storage cleanup (auto) done',
      );
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'storage cleanup (auto) failed');
    }
  }

  async scan(): Promise<CleanupScan> {
    const s = await this.plan();
    return { ...s, candidates: s.candidates.map(publicCandidate) };
  }

  /** Deletes the asked ids that still match a rule now. One run at a time. */
  async apply(ids: readonly string[], opts: { auto?: boolean } = {}): Promise<CleanupResult> {
    if (this.running)
      throw new ActionError(409, 'cleanup_running', 'A cleanup is already running.');
    const run = this.applyNow(ids, opts.auto === true);
    this.running = run;
    try {
      return await run;
    } finally {
      this.running = null;
    }
  }

  private async applyNow(ids: readonly string[], auto: boolean): Promise<CleanupResult> {
    const fresh = await this.plan();
    const want = new Set(ids);
    const pick = fresh.candidates.filter((c) => want.has(c.id) && (!auto || c.tier === 'safe'));
    const found = new Set(pick.map((c) => c.id));
    const result: CleanupResult = {
      removed: [],
      failed: [],
      kept: ids.filter((id) => !found.has(id)),
      bytesFreed: 0,
      at: this.now(),
      auto,
    };
    // Prune last: `git gc` should see the refs already gone.
    const ordered = [...pick].sort(
      (a, b) => Number(a.category === 'git') - Number(b.category === 'git'),
    );
    const tmpNames: PlannedCandidate[] = [];
    for (const c of ordered) {
      const a = c.action;
      try {
        if (a.on === 'tmp') {
          tmpNames.push(c);
          continue;
        }
        if (a.on === 'worktree') {
          await this.d.workspaces.removeWorktree(a.workspaceId);
        } else if (a.on === 'ws') {
          const r = await this.d.host.wsCleanupApply(this.d.workspaces.ref(a.workspaceId), a.base, [
            a.item,
          ]);
          if (r.failed.length > 0) throw new Error(r.failed[0]!.reason);
        } else {
          await removeInside(a.root, a.rel);
        }
        result.removed.push({ id: c.id, label: c.label, bytes: c.bytes });
        result.bytesFreed += c.bytes ?? 0;
      } catch (e) {
        result.failed.push({ id: c.id, label: c.label, reason: (e as Error).message });
      }
    }
    if (tmpNames.length > 0) {
      try {
        const r = await this.d.host.tmpCleanupApply(
          tmpNames.map((c) => (c.action as { name: string }).name),
        );
        const failed = new Map(r.failed.map((f) => [f.item, f.reason]));
        for (const c of tmpNames) {
          const name = (c.action as { name: string }).name;
          if (failed.has(name)) {
            result.failed.push({ id: c.id, label: c.label, reason: failed.get(name)! });
          } else {
            result.removed.push({ id: c.id, label: c.label, bytes: c.bytes });
            result.bytesFreed += c.bytes ?? 0;
          }
        }
      } catch (e) {
        for (const c of tmpNames) {
          result.failed.push({ id: c.id, label: c.label, reason: (e as Error).message });
        }
      }
    }

    if (result.removed.length > 0 || result.failed.length > 0) {
      this.d.audit.write({
        actor: auto ? 'system' : 'user',
        action: 'storage.cleanup',
        targetType: 'storage',
        targetId: auto ? 'auto' : 'manual',
        after: {
          removed: result.removed.map((r) => r.id),
          failed: result.failed.map((f) => ({ id: f.id, reason: f.reason })),
          bytesFreed: result.bytesFreed,
        },
      });
    }
    this.last = result;
    return result;
  }

  /**
   * A bulk-start worktree is done when no session runs in it (checked by the caller), its tree is clean, and its branch's
   * MR is merged or its card is finished. Removing it deletes the folder only: the branch and its commits stay.
   */
  private async worktreeCandidate(
    w: ReturnType<WorkspaceService['list']>[number],
  ): Promise<PlannedCandidate | null> {
    const status = await this.d.host.wsStatus(this.d.workspaces.ref(w.id));
    const branch = status.branch;
    if (!branch || status.dirty.length > 0) return null;
    const merged =
      w.repoId !== null &&
      this.d.store.db
        .select({ state: mrs.state, sourceBranch: mrs.sourceBranch })
        .from(mrs)
        .where(eq(mrs.repoId, w.repoId))
        .all()
        .some((m) => m.sourceBranch === branch && m.state === 'merged');
    const cardDone = this.d.store.db
      .select({ branchName: cards.branchName, status: cards.status })
      .from(cards)
      .all()
      .some(
        (c) =>
          c.branchName?.trim() === branch &&
          /complete|done|ready to test|archived/i.test(c.status ?? ''),
      );
    if (!merged && !cardDone) return null;
    return {
      id: `worktree:${w.id}:${branch}`,
      category: 'worktrees',
      tier: 'confirm',
      label: w.absPath,
      reason: merged
        ? `Its MR (${branch}) is merged; the branch stays`
        : `Its card is finished; the branch stays`,
      bytes: null,
      where: w.name,
      action: { on: 'worktree', workspaceId: w.id },
    };
  }

  // ───────────────────────────── facts ─────────────────────────────

  private async plan(): Promise<{
    candidates: PlannedCandidate[];
    skipped: CleanupScan['skipped'];
    scannedAt: number;
  }> {
    const now = this.now();
    const db = this.dbFacts(now);
    const candidates: PlannedCandidate[] = [];
    const skipped: CleanupScan['skipped'] = [];

    const sessions = await this.d.sessions.list().catch(() => null);
    for (const w of this.d.workspaces.list()) {
      if (!sessions) {
        skipped.push({ where: w.name, reason: 'Could not list sessions (host agent down?)' });
        continue;
      }
      if (sessions.some((s) => s.workspaceId === w.id && s.state !== 'exited')) {
        skipped.push({ where: w.name, reason: 'A session is running in it' });
        continue;
      }
      try {
        if (w.kind === 'worktree') {
          const wt = await this.worktreeCandidate(w);
          if (wt) candidates.push(wt);
        }
        const base = w.defaultBase || 'main';
        const facts = await this.d.host.wsCleanupFacts(this.d.workspaces.ref(w.id), base);
        candidates.push(
          ...workspaceCandidates(
            { ws: { id: w.id, name: w.name, repoId: w.repoId, base }, facts },
            db,
          ),
        );
      } catch (e) {
        skipped.push({ where: w.name, reason: (e as Error).message });
      }
    }

    try {
      const t = await this.d.host.tmpCleanupFacts();
      const active = new Set(
        this.d.store.db
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(inArray(testRuns.status, ['active', 'paused']))
          .all()
          .map((r) => r.id),
      );
      candidates.push(...tmpCandidates(t, now, (id) => active.has(id)));
    } catch (e) {
      skipped.push({ where: 'Mac temp dir', reason: (e as Error).message });
    }

    try {
      candidates.push(...dataCandidates(await this.dataFacts(now, db)));
    } catch (e) {
      skipped.push({ where: 'Dashboard data', reason: (e as Error).message });
    }
    return { candidates, skipped, scannedAt: now };
  }

  private dbFacts(now: number): DbFacts {
    const db = this.d.store.db;
    const cardMap = new Map<string, CardFact>();
    for (const c of db
      .select({
        id: cards.id,
        status: cards.status,
        archived: cards.archived,
        branchName: cards.branchName,
      })
      .from(cards)
      .all()) {
      cardMap.set(c.id, { status: c.status, archived: c.archived, branchName: c.branchName });
    }
    const mrByBranch = new Map<string, MrFact>();
    const mrState = new Map<string, string>();
    for (const m of db
      .select({
        repoId: mrs.repoId,
        iid: mrs.iid,
        state: mrs.state,
        sourceBranch: mrs.sourceBranch,
      })
      .from(mrs)
      .orderBy(desc(mrs.createdAt))
      .all()) {
      mrState.set(`${m.repoId}!${m.iid}`, m.state);
      const key = `${m.repoId}\t${m.sourceBranch}`;
      // Newest first: the latest MR of a branch decides.
      if (!mrByBranch.has(key)) mrByBranch.set(key, { iid: m.iid, state: m.state });
    }
    const threads = new Map<string, boolean>();
    for (const n of db
      .select({
        repoId: notesCache.repoId,
        iid: notesCache.mrIid,
        discussionId: notesCache.discussionId,
        resolvable: notesCache.resolvable,
        resolved: notesCache.resolved,
      })
      .from(notesCache)
      .where(eq(notesCache.resolvable, true))
      .all()) {
      const key = `${n.repoId}!${n.iid}#${n.discussionId}`;
      threads.set(key, (threads.get(key) ?? true) && n.resolved);
    }
    const pushedSha = new Map<string, string>();
    for (const p of db
      .select({ repoId: branchPushes.repoId, branch: branchPushes.branch, sha: branchPushes.sha })
      .from(branchPushes)
      .orderBy(desc(branchPushes.pushedAt))
      .all()) {
      const key = `${p.repoId}\t${p.branch}`;
      if (!pushedSha.has(key)) pushedSha.set(key, p.sha);
    }
    return {
      now,
      workspaceIds: new Set(
        db
          .select({ id: workspacesTable.id })
          .from(workspacesTable)
          .all()
          .map((w) => w.id),
      ),
      cards: cardMap,
      mrByBranch,
      mrState,
      resolvedThreads: new Set([...threads].filter(([, r]) => r).map(([k]) => k)),
      findings: new Map(
        db
          .select({ id: testFindings.id, status: testFindings.status })
          .from(testFindings)
          .all()
          .map((f) => [f.id, f.status]),
      ),
      pushedSha,
      attachments: new Map(
        db
          .select()
          .from(cockpitAttachments)
          .all()
          .map((a) => [a.group, { kind: a.kind, refId: a.refId, createdAt: a.createdAt }]),
      ),
    };
  }

  private async dataFacts(now: number, known: DbFacts): Promise<DataFacts> {
    const db = this.d.store.db;
    const { dataDir, clonesRoot } = this.d;
    const repoIds = new Set(this.d.config.listRepos().map((r) => r.id));
    const busyRepos = new Set(
      db
        .select({ repoId: jobs.repoId })
        .from(jobs)
        .where(inArray(jobs.status, ['queued', 'running', 'paused']))
        .all()
        .map((j) => j.repoId),
    );
    const lastBuildFinished = new Map<string, number>();
    for (const j of db
      .select({ repoId: jobs.repoId, finishedAt: jobs.finishedAt })
      .from(jobs)
      .where(eq(jobs.kind, 'build'))
      .orderBy(desc(jobs.finishedAt))
      .all()) {
      if (j.finishedAt && !lastBuildFinished.has(j.repoId)) {
        lastBuildFinished.set(j.repoId, j.finishedAt);
      }
    }

    const cloneBuilds: DataFacts['cloneBuilds'] = [];
    const clones: DataFacts['clones'] = [];
    for (const name of await dirs(clonesRoot)) {
      if (!REPO_DIR_RE.test(name)) continue;
      const hasGit = await isDir(join(clonesRoot, name, '.git'));
      if (!hasGit) continue;
      if (repoIds.has(name)) {
        const build = await entry(clonesRoot, `${name}/build`);
        if (build) cloneBuilds.push({ ...build, repoId: name });
      } else {
        const c = await entry(clonesRoot, name);
        if (c) clones.push({ ...c, repoId: name });
      }
    }

    const apks: DataFacts['apks'] = [];
    for (const repo of await dirs(join(dataDir, 'apks'))) {
      for (const f of await files(join(dataDir, 'apks', repo))) {
        if (!/\.(apk|aab)$/i.test(f)) continue;
        const e = await entry(dataDir, `apks/${repo}/${f}`);
        if (e) apks.push({ ...e, repoId: repo });
      }
    }

    const evidence: DataFacts['evidence'] = [];
    for (const runId of await dirs(join(dataDir, 'testbench'))) {
      if (!RUN_ID_RE.test(runId)) continue;
      const e = await entry(dataDir, `testbench/${runId}`);
      if (e) evidence.push({ ...e, runId });
    }
    const runs = new Map(
      db
        .select({ id: testRuns.id, status: testRuns.status, endedAt: testRuns.endedAt })
        .from(testRuns)
        .all()
        .map((r) => [r.id, { status: r.status, endedAt: r.endedAt }]),
    );
    const runsInUse = new Set(
      db
        .select({ path: testFindings.screenshotPath })
        .from(testFindings)
        .where(inArray(testFindings.status, ['open', 'fixing', 'fixed']))
        .all()
        .map((f) => f.path?.split('/')[0] ?? '')
        .filter(Boolean),
    );

    const figma: FsEntry[] = [];
    for (const key of await dirs(join(dataDir, 'figma'))) {
      const e = await entry(dataDir, `figma/${key}`);
      if (e) figma.push(e);
    }
    const figmaCards: DataFacts['figmaCards'] = [];
    for (const cardId of await dirs(join(dataDir, FIGMA_CARDS_DIR))) {
      const e = await entry(dataDir, `${FIGMA_CARDS_DIR}/${cardId}`);
      if (e) figmaCards.push({ ...e, cardId });
    }
    const scrcpy: FsEntry[] = [];
    for (const f of await files(join(dataDir, 'scrcpy'))) {
      const e = await entry(dataDir, `scrcpy/${f}`);
      if (e) scrcpy.push(e);
    }

    return {
      now,
      dataDir,
      clonesRoot,
      repoIds,
      busyRepos,
      lastBuildFinished,
      cloneBuilds,
      clones,
      apks,
      evidence,
      runs,
      runsInUse,
      figma,
      figmaCards,
      cards: known.cards,
      mrByBranch: known.mrByBranch,
      scrcpy,
      scrcpyCurrent: `scrcpy-server-v${SCRCPY_SERVER_VERSION}`,
    };
  }
}

function publicCandidate(c: PlannedCandidate): CleanupCandidate {
  const { action: _action, ...rest } = c;
  return rest;
}

// ───────────────────────────── fs helpers ─────────────────────────────

async function dirs(path: string): Promise<string[]> {
  const list = await readdir(path, { withFileTypes: true }).catch(() => []);
  return list.filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name);
}

async function files(path: string): Promise<string[]> {
  const list = await readdir(path, { withFileTypes: true }).catch(() => []);
  return list.filter((d) => d.isFile()).map((d) => d.name);
}

async function isDir(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return !!st?.isDirectory();
}

/** Size (via `du`, it handles big trees) and newest mtime of the top entry. Null when missing or a symlink. */
async function entry(root: string, rel: string): Promise<FsEntry | null> {
  const path = join(root, rel);
  const st = await lstat(path).catch(() => null);
  if (!st || st.isSymbolicLink()) return null;
  if (!st.isDirectory()) return { rel, bytes: st.size, mtimeMs: st.mtimeMs };
  const bytes = await duBytes(path);
  return { rel, bytes, mtimeMs: st.mtimeMs };
}

function duBytes(path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', path], { timeout: 60_000 }, (err, stdout) => {
      const kb = Number(String(stdout).split(/\s+/)[0]);
      resolve(err || !Number.isFinite(kb) ? 0 : kb * 1024);
    });
  });
}

/** Removes `<root>/<rel>` only when its real path is strictly inside the real root and it is not a symlink. */
async function removeInside(root: string, rel: string): Promise<void> {
  if (rel.includes('\0') || rel.split('/').some((p) => p === '..' || p === '')) {
    throw new Error('invalid path');
  }
  const realRoot = await realpath(root);
  const path = join(realRoot, rel);
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Error('symlink, not removed');
  const real = await realpath(path);
  if (!real.startsWith(realRoot + sep) || real === realRoot) throw new Error('outside its root');
  await rm(real, { recursive: true, force: true });
}
