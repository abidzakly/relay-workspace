import { eq } from 'drizzle-orm';
import {
  WORKSPACE_COLORS,
  type DeckSource,
  type Workspace,
  type WorkspaceColor,
  type WorkspaceCreate,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { workspaces } from '../../db/schema';
import type { EventBus } from '../../sync/eventBus';
import { ActionError } from '../actionError';
import type { DeckDiff } from '../deck/reviewDeck';
import { listCards } from '../notionStore';
import type { CockpitHost, WsRef } from './host';
import type { ExistingBranch } from './workflowOps';

/**
 * Cockpit workspaces: the registry lives here, the directories on the Mac. Adding one is
 * validated by the host (`git rev-parse` + allowlisted root). Every later host call names the path again and the host
 * re-checks it: the registry is convenience, not authority.
 */

export class WorkspaceError extends ActionError {
  constructor(status: number, code: string, message?: string) {
    super(status, code, message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceDeps {
  store: AppDb;
  config: ConfigStore;
  host: CockpitHost;
  bus?: EventBus;
  now?: () => number;
}

function toWorkspace(r: typeof workspaces.$inferSelect): Workspace {
  return {
    ...r,
    color: r.color as WorkspaceColor,
    kind: r.kind === 'worktree' ? 'worktree' : 'repo',
  };
}

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ws';

export class WorkspaceService {
  constructor(private readonly d: WorkspaceDeps) {}

  list(): Workspace[] {
    return this.d.store.db
      .select()
      .from(workspaces)
      .all()
      .map(toWorkspace)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Workspace {
    const r = this.d.store.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!r) throw new WorkspaceError(404, 'workspace_not_found', 'Unknown workspace');
    return toWorkspace(r);
  }

  ref(id: string): WsRef {
    const w = this.get(id);
    return { path: w.absPath, wsId: w.id };
  }

  async add(input: WorkspaceCreate): Promise<Workspace> {
    if (input.repoId && !this.d.config.getRepo(input.repoId)) {
      throw new WorkspaceError(404, 'repo_not_found', 'Unknown repository');
    }
    const existing = this.list();
    let id = slugify(input.name);
    for (let i = 2; existing.some((w) => w.id === id); i++) id = `${slugify(input.name)}-${i}`;
    const v = await this.d.host.wsValidate({ path: input.absPath, wsId: id });
    if (existing.some((w) => w.absPath === v.realPath)) {
      throw new WorkspaceError(409, 'workspace_exists', 'This directory is already a workspace.');
    }
    await this.d.host.wsEnsureAgentRules({ path: v.realPath, wsId: id });
    const ws: Workspace = {
      id,
      name: input.name,
      absPath: v.realPath,
      repoId: input.repoId,
      defaultBase: input.defaultBase,
      color: input.color ?? WORKSPACE_COLORS[existing.length % WORKSPACE_COLORS.length]!,
      createdAt: (this.d.now ?? Date.now)(),
      kind: 'repo',
      parentId: null,
    };
    this.d.store.db.insert(workspaces).values(ws).run();
    this.d.bus?.emit({ type: 'cockpit.changed', what: 'workspaces' });
    return ws;
  }

  /**
   * A git worktree of `parentId` on a new `branch` (bulk start), registered as a workspace of its own so it gets its
   * own sessions, terminal and diff. Same repo, base and pigment as the parent.
   */
  async addWorktree(
    parentId: string,
    branch: string,
    base: string,
    onExisting?: ExistingBranch,
  ): Promise<{ workspace: Workspace; replaced: boolean; reused: boolean }> {
    const parent = this.get(parentId);
    if (parent.kind !== 'repo') {
      throw new WorkspaceError(422, 'worktree_of_worktree', 'Start from the repo workspace.');
    }
    const { path, replaced, reused } = await this.d.host.wsAddWorktree(
      this.ref(parentId),
      branch,
      base,
      onExisting,
    );
    const existing = this.list();
    const stem = `${parent.id}-${slugify(branch.split('/').pop() ?? branch)}`.slice(0, 58);
    let id = stem;
    for (let i = 2; existing.some((w) => w.id === id); i++) id = `${stem}-${i}`;
    await this.d.host.wsEnsureAgentRules({ path, wsId: id }).catch(() => undefined);
    const ws: Workspace = {
      id,
      name: `${parent.name} · ${branch.split('/').pop() ?? branch}`.slice(0, 60),
      absPath: path,
      repoId: parent.repoId,
      defaultBase: parent.defaultBase,
      color: parent.color,
      createdAt: (this.d.now ?? Date.now)(),
      kind: 'worktree',
      parentId: parent.id,
    };
    this.d.store.db.insert(workspaces).values(ws).run();
    this.d.bus?.emit({ type: 'cockpit.changed', what: 'workspaces' });
    return { workspace: ws, replaced: !!replaced, reused: !!reused };
  }

  /** Removes a worktree workspace and waits for its folder to go (storage cleanup). */
  async removeWorktree(id: string): Promise<void> {
    const w = this.get(id);
    if (w.kind !== 'worktree' || !w.parentId) {
      throw new WorkspaceError(422, 'not_a_worktree', 'Not a worktree workspace.');
    }
    await this.d.host.wsRemoveWorktree(this.ref(w.parentId), w.absPath);
    this.d.store.db.delete(workspaces).where(eq(workspaces.id, id)).run();
    this.d.bus?.emit({ type: 'cockpit.changed', what: 'workspaces' });
  }

  /** The worktrees made from a workspace. */
  worktreesOf(parentId: string): Workspace[] {
    return this.list().filter((w) => w.kind === 'worktree' && w.parentId === parentId);
  }

  remove(id: string): void {
    const w = this.get(id);
    if (w.kind === 'worktree') {
      // Its folder goes with it; the branch and its commits stay in the repo.
      if (w.parentId) {
        void this.d.host.wsRemoveWorktree(this.ref(w.parentId), w.absPath).catch(() => undefined);
      }
      this.d.store.db.delete(workspaces).where(eq(workspaces.id, id)).run();
      this.d.bus?.emit({ type: 'cockpit.changed', what: 'workspaces' });
      return;
    }
    // A repo workspace takes its worktrees' rows along (their folders stay until git prunes them).
    for (const wt of this.worktreesOf(id)) this.remove(wt.id);
    const ref = this.ref(id);
    // Its checkpoint refs would otherwise pin old snapshots in the repo forever. Best effort: the host may be down.
    void this.d.host
      .wsCleanupFacts(ref, 'main')
      .then((f) =>
        this.d.host.wsCleanupApply(
          ref,
          'main',
          f.refs
            .filter((r) => r.name.startsWith(`refs/cockpit/${id}/`))
            .map((r) => ({ kind: 'ref' as const, name: r.name, sha: r.sha })),
        ),
      )
      .catch(() => undefined);
    this.d.store.db.delete(workspaces).where(eq(workspaces.id, id)).run();
    this.d.bus?.emit({ type: 'cockpit.changed', what: 'workspaces' });
  }

  /** The workspace holding a repo (first by name), for "send to agent" from an MR deck. */
  forRepo(repoId: string): string | null {
    return this.list().find((w) => w.repoId === repoId && w.kind === 'repo')?.id ?? null;
  }

  /** `LocalReviewReader`: the Review Deck's `local` source (working / branch / per agent turn). */
  async localDiff(source: Extract<DeckSource, { kind: 'local' }>): Promise<DeckDiff> {
    const w = this.get(source.workspaceId);
    const ref = { path: w.absPath, wsId: w.id };
    const base = source.mode === 'branch' ? (source.base ?? w.defaultBase) : source.base;
    const [diff, status] = await Promise.all([
      this.d.host.wsDiff(ref, source.mode, base),
      this.d.host.wsStatus(ref).catch(() => null),
    ]);
    const card = status?.branch
      ? (listCards(this.d.store).find((c) => c.branchName?.trim() === status.branch) ?? null)
      : null;
    return {
      title: card?.title ?? `${w.name}${status?.branch ? ` · ${status.branch}` : ''}`,
      subtitle: `${w.name} · ${diff.label}`,
      files: diff.files,
      truncated: false,
      card: card ? { title: card.title, status: card.status ?? null, url: card.url ?? null } : null,
      agentTarget: { workspaceId: w.id },
    };
  }
}
