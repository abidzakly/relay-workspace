import { and, eq } from 'drizzle-orm';
import type {
  BranchFetchResult,
  BranchListResult,
  BranchRow,
  BranchSourceState,
  LocalBranch,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { mrs } from '../../db/schema';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import { cardForBranch, removeCardLink, setCardLink } from '../cardLinks';
import { CockpitHostError, type CockpitHost } from '../cockpit/host';
import type { WorkspaceService } from '../cockpit/workspaces';
import { GitlabApiError, GitlabService } from '../gitlabService';
import type { HttpClient } from '../httpClient';
import { listCards } from '../notionStore';

export interface BranchesDeps {
  config: ConfigStore;
  store: AppDb;
  http: HttpClient;
  log: Logger;
  audit: AuditWriter;
  host: CockpitHost;
  workspaces: WorkspaceService;
}

const errState = (code: string, message: string): BranchSourceState => ({
  ok: false,
  code,
  message,
});

/** A host failure → a source state the page can explain. An old agent does not know the op yet. */
function hostState(e: unknown): BranchSourceState {
  if (e instanceof CockpitHostError) {
    if (e.code === 'not_found') {
      return errState(
        'agent_outdated',
        'The host agent on the Mac is older than this Relay: restart `pnpm agent` to list local branches.',
      );
    }
    return errState(e.code, e.message);
  }
  return errState(
    'local_failed',
    e instanceof Error ? e.message : 'Could not read local branches.',
  );
}

/** GitLab failures in words: unreachable usually means the VPN is off. */
function gitlabState(e: unknown): BranchSourceState {
  if (e instanceof GitlabApiError) {
    if (e.kind === 'network') {
      return errState(
        'gitlab_unreachable',
        'GitLab could not be reached (VPN off?). Showing what this Mac knows from the last fetch.',
      );
    }
    if (e.kind === 'auth' || e.kind === 'forbidden') {
      return errState('gitlab_auth', 'GitLab refused the token. Check it under Settings → Repos.');
    }
    return errState('gitlab_failed', `GitLab answered ${e.status || e.kind}.`);
  }
  return errState('gitlab_failed', e instanceof Error ? e.message : 'GitLab could not be read.');
}

/**
 * Every branch of a repository, from the Mac's workspace (local heads, origin refs) and GitLab, with its open MR and
 * its card (linked in Relay or by Branch formula). Each source fails on its own: the page shows what it has and says
 * what is missing.
 */
export class BranchesService {
  constructor(private readonly d: BranchesDeps) {}

  private repo(repoId: string) {
    const repo = this.d.config.getRepo(repoId);
    if (!repo) throw new ActionError(404, 'repo_not_found', 'Unknown repository');
    return repo;
  }

  async list(repoId: string): Promise<BranchListResult> {
    const repo = this.repo(repoId);
    const base = repo.baseBranch;
    const workspaceId = this.d.workspaces.forRepo(repoId);

    const localP: Promise<{ rows: LocalBranch[]; state: BranchSourceState }> = workspaceId
      ? this.d.host
          .wsListBranches(this.d.workspaces.ref(workspaceId))
          .then((rows) => ({ rows, state: { ok: true } as const }))
          .catch((e: unknown) => ({ rows: [], state: hostState(e) }))
      : Promise.resolve({
          rows: [],
          state: errState(
            'no_workspace',
            'No workspace on this Mac holds this repository: only remote branches are listed.',
          ),
        });
    const remoteP = (async () => {
      try {
        const svc = GitlabService.forRepo(this.d.config, repoId, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
        const r = await svc.listBranches();
        return { ...r, state: { ok: true } as BranchSourceState };
      } catch (e) {
        return { branches: [], truncated: false, state: gitlabState(e) };
      }
    })();
    const [local, remote] = await Promise.all([localP, remoteP]);

    const rows = new Map<string, BranchRow>();
    const blank = (name: string): BranchRow => ({
      name,
      local: false,
      remote: false,
      current: false,
      sha: null,
      committedAt: null,
      author: null,
      subject: null,
      track: null,
      isBase: name === base,
      merged: false,
      mr: null,
      card: null,
    });
    for (const l of local.rows) rows.set(l.name, { ...blank(l.name), ...l });
    for (const b of remote.branches) {
      const row = rows.get(b.name) ?? blank(b.name);
      // GitLab is the truth about origin; the Mac's origin refs may be a fetch behind.
      row.remote = true;
      row.merged = b.merged;
      if (!row.local) {
        row.sha = b.sha ?? row.sha;
        row.committedAt = b.committedAt ?? row.committedAt;
      }
      rows.set(b.name, row);
    }
    // With GitLab answering, a ref only on the Mac's stale origin refs is gone upstream.
    if (remote.state.ok) {
      const onGitlab = new Set(remote.branches.map((b) => b.name));
      for (const [name, row] of rows) {
        if (!row.local && !onGitlab.has(name)) rows.delete(name);
        else if (row.local && !onGitlab.has(name)) row.remote = false;
      }
    }

    const open = this.d.store.db
      .select({
        iid: mrs.iid,
        title: mrs.title,
        draft: mrs.draft,
        sourceBranch: mrs.sourceBranch,
        targetBranch: mrs.targetBranch,
        webUrl: mrs.webUrl,
      })
      .from(mrs)
      .where(and(eq(mrs.repoId, repoId), eq(mrs.state, 'opened')))
      .all();
    const cards = listCards(this.d.store);
    for (const row of rows.values()) {
      const mr = open.find((m) => m.sourceBranch === row.name);
      if (mr) {
        row.mr = {
          iid: mr.iid,
          title: mr.title,
          draft: mr.draft,
          targetBranch: mr.targetBranch,
          webUrl: mr.webUrl ?? null,
        };
      }
      if (!row.isBase) {
        const c = cardForBranch(this.d.store, row.name, repoId, cards);
        if (c) {
          row.card = {
            id: c.card.id,
            title: c.card.title,
            url: c.card.url ?? null,
            status: c.card.status ?? null,
            linked: c.linked,
          };
        }
      }
    }

    return {
      repoId,
      baseBranch: base,
      workspaceId,
      rows: [...rows.values()].sort(
        (a, b) =>
          Number(b.isBase) - Number(a.isBase) ||
          Number(b.current) - Number(a.current) ||
          (b.committedAt ?? 0) - (a.committedAt ?? 0),
      ),
      sources: { local: local.state, remote: remote.state },
      truncated: remote.truncated,
    };
  }

  /** `git fetch origin` in the repo workspace, so local origin refs catch up. */
  async fetch(repoId: string): Promise<BranchFetchResult> {
    this.repo(repoId);
    const workspaceId = this.d.workspaces.forRepo(repoId);
    if (!workspaceId) {
      throw new ActionError(404, 'no_workspace', 'No workspace on this Mac holds this repository.');
    }
    try {
      return { fetchFailed: await this.d.host.wsFetch(this.d.workspaces.ref(workspaceId)) };
    } catch (e) {
      if (e instanceof CockpitHostError && e.code === 'not_found') {
        throw new ActionError(
          409,
          'agent_outdated',
          'The host agent on the Mac is older than this Relay: restart `pnpm agent`.',
        );
      }
      throw e;
    }
  }

  linkCard(repoId: string, branch: string, cardId: string): { ok: true } {
    const repo = this.repo(repoId);
    if (branch === repo.baseBranch) {
      throw new ActionError(422, 'base_branch', 'The base branch has no card.');
    }
    const card = listCards(this.d.store).find((c) => c.id === cardId);
    if (!card)
      throw new ActionError(404, 'card_not_found', 'That card is not in the Notion cache.');
    const before = cardForBranch(this.d.store, branch, repoId)?.card.id ?? null;
    setCardLink(this.d.config, repoId, branch, cardId);
    this.d.audit.write({
      actor: 'user',
      action: 'branch.cardLink',
      targetType: 'branch',
      targetId: `${repoId}:${branch}`,
      before: { cardId: before },
      after: { cardId, title: card.title },
    });
    return { ok: true };
  }

  unlinkCard(repoId: string, branch: string): { ok: true; removed: boolean } {
    this.repo(repoId);
    const before = cardForBranch(this.d.store, branch, repoId);
    const removed = removeCardLink(this.d.config, repoId, branch);
    if (removed) {
      this.d.audit.write({
        actor: 'user',
        action: 'branch.cardUnlink',
        targetType: 'branch',
        targetId: `${repoId}:${branch}`,
        before: { cardId: before?.card.id ?? null },
        after: null,
      });
    }
    return { ok: true, removed };
  }
}
