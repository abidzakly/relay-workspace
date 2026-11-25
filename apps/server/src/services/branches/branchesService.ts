import { and, eq } from 'drizzle-orm';
import type {
  BranchDeleteBody,
  BranchDeleteResult,
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
import { guardedWrite } from '../dryRun';
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

    const localP: Promise<{ rows: LocalBranch[]; me: string | null; state: BranchSourceState }> =
      workspaceId
        ? this.d.host
            .wsListBranches(this.d.workspaces.ref(workspaceId))
            .then((r) => ({ rows: r.branches, me: r.me, state: { ok: true } as const }))
            .catch((e: unknown) => ({ rows: [], me: null, state: hostState(e) }))
        : Promise.resolve({
            rows: [],
            me: null,
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
      authorEmail: null,
      subject: null,
      track: null,
      isBase: name === base,
      merged: false,
      protected: false,
      mine: null,
      mr: null,
      card: null,
    });
    for (const l of local.rows) rows.set(l.name, { ...blank(l.name), ...l });
    for (const b of remote.branches) {
      const row = rows.get(b.name) ?? blank(b.name);
      // GitLab is the truth about origin; the Mac's origin refs may be a fetch behind.
      row.remote = true;
      row.merged = b.merged;
      row.protected = b.protected;
      if (b.default) row.isBase = true;
      if (!row.local) {
        row.authorEmail = b.authorEmail ?? row.authorEmail;
        row.author = b.authorName ?? row.author;
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
    const me = local.me;
    for (const row of rows.values()) {
      row.mine = me && row.authorEmail ? row.authorEmail === me : null;
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
      meEmail: me,
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

  /**
   * Deletes a branch on the Mac, on origin, or both. Every refusal is checked before anything is deleted: the base or
   * default branch, a protected branch, an open MR, someone else's branch without the typed name. Local goes first;
   * each part reports on its own, so a remote failure after a local delete is said as it is.
   */
  async delete(body: BranchDeleteBody): Promise<BranchDeleteResult> {
    const { repo: repoId, branch, local, remote, force = false, confirmName } = body;
    const list = await this.list(repoId);
    const row = list.rows.find((r) => r.name === branch);
    if (!row)
      throw new ActionError(404, 'branch_not_found', `${branch} is not a branch of this repo.`);
    if (row.isBase)
      throw new ActionError(422, 'base_branch', 'The base branch is never deleted from Relay.');
    if (local) {
      if (!list.workspaceId) {
        throw new ActionError(
          404,
          'no_workspace',
          'No workspace on this Mac holds this repository.',
        );
      }
      if (!row.local) throw new ActionError(409, 'not_local', `${branch} is not on this Mac.`);
      if (row.current) {
        throw new ActionError(
          409,
          'branch_checked_out_here',
          `${branch} is checked out in the workspace: switch it to another branch first.`,
        );
      }
    }
    if (remote) {
      if (!list.sources.remote.ok) {
        throw new ActionError(503, 'gitlab_unavailable', list.sources.remote.message);
      }
      if (!row.remote) throw new ActionError(409, 'not_remote', `${branch} is not on origin.`);
      if (row.protected) {
        throw new ActionError(409, 'branch_protected', `${branch} is protected on GitLab.`);
      }
      if (row.mr) {
        throw new ActionError(
          409,
          'branch_has_mr',
          `!${row.mr.iid} is still open from ${branch}: merge or close it first.`,
          { iid: row.mr.iid },
        );
      }
      if (row.mine !== true && confirmName !== branch) {
        throw new ActionError(
          409,
          'confirm_name_required',
          'This branch is not yours (or Relay cannot tell): type its name to delete it on origin.',
        );
      }
    }

    const result: BranchDeleteResult = {
      local: { state: 'skipped' },
      remote: { state: 'skipped' },
      sha: row.sha,
    };
    const failed = (e: unknown) => {
      if (e instanceof CockpitHostError || e instanceof ActionError) {
        return { state: 'failed' as const, code: e.code, message: e.message };
      }
      if (e instanceof GitlabApiError) {
        const st = gitlabState(e);
        return st.ok
          ? { state: 'failed' as const, code: 'gitlab_failed', message: e.message }
          : { state: 'failed' as const, code: st.code, message: st.message };
      }
      return {
        state: 'failed' as const,
        code: 'failed',
        message: e instanceof Error ? e.message : 'Delete failed.',
      };
    };

    if (local && list.workspaceId) {
      try {
        const r = await this.d.host.wsDeleteBranch(
          this.d.workspaces.ref(list.workspaceId),
          branch,
          force,
        );
        result.sha = r.sha;
        result.local = { state: 'deleted' };
        this.d.audit.write({
          actor: 'user',
          action: 'branch.deleteLocal',
          targetType: 'branch',
          targetId: `${repoId}:${branch}`,
          before: { sha: r.sha, force },
          after: null,
        });
      } catch (e) {
        if (e instanceof CockpitHostError && e.code === 'not_found') {
          throw new ActionError(
            409,
            'agent_outdated',
            'Restart `pnpm agent` on the Mac to delete local branches.',
          );
        }
        // An unmerged branch is a question for the user, not a partial result: nothing was deleted yet.
        if (e instanceof CockpitHostError && e.code === 'branch_unmerged') {
          throw new ActionError(409, e.code, e.message, e.details);
        }
        result.local = failed(e);
        return result;
      }
    }

    if (remote) {
      try {
        const svc = GitlabService.forRepo(this.d.config, repoId, {
          http: this.d.http,
          store: this.d.store,
          log: this.d.log,
        });
        const out = await guardedWrite(
          { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
          {
            actor: 'user',
            action: 'branch.delete',
            targetType: 'branch',
            targetId: `${repoId}:${branch}`,
            confirmed: true,
            before: { sha: row.sha, author: row.authorEmail, mine: row.mine },
            after: null,
            run: () => svc.deleteBranch(branch),
          },
        );
        result.remote = { state: out.dryRun ? 'simulated' : 'deleted' };
      } catch (e) {
        result.remote = failed(e);
      }
    }

    const goneLocal = !row.local || result.local.state === 'deleted';
    const goneRemote = !row.remote || result.remote.state === 'deleted';
    if (goneLocal && goneRemote) removeCardLink(this.d.config, repoId, branch);
    this.d.log.info(
      { repoId, branch, local: result.local.state, remote: result.remote.state },
      'branch deleted',
    );
    return result;
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
