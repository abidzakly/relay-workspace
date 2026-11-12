import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigStore } from '../../config/store';
import { ActionError } from '../actionError';
import type { SquashResult, WsCommit } from '../cockpit/branchOps';
import type { CockpitHost } from '../cockpit/host';
import { testFixPrompt } from '../cockpit/threadPrompt';
import type { WorkspaceService } from '../cockpit/workspaces';
import type { TestBenchService } from './testBench';

/**
 * The Test Bench's links to the cockpit: send findings to an agent in the repo's workspace,
 * read the workspace's history for fix trailers, and squash the branch to one commit when the MR is created.
 */

export interface TestBenchFlowDeps {
  bench: TestBenchService;
  config: ConfigStore;
  host: Pick<CockpitHost, 'wsLog' | 'wsSquashForMr' | 'wsStatus' | 'wsSaveAttachment'>;
  /** `<data dir>/testbench`: AI evidence screenshots, copied into the workspace for the fixing agent. */
  evidenceDir?: string;
  workspaces: Pick<WorkspaceService, 'forRepo' | 'ref'>;
  /** Checks the branch out in the repo's workspace (the deck's `prepareDeckBranch`); null = no workspace. */
  prepareBranch: (
    repoId: string,
    branch: string,
    base: string,
  ) => Promise<{ workspaceId: string } | null>;
  sendToAgent: (
    workspaceId: string,
    prompt: string,
    opts: { returnTo?: string },
  ) => Promise<{ sessionId: string }>;
  hasOpenMr: (repoId: string, branch: string) => boolean;
  /** Called after a screenshot was saved for the agent (storage cleanup bookkeeping). */
  onAttachment?: (a: { group: string; workspaceId: string; findingId: string }) => void;
}

export class TestBenchFlow {
  constructor(private readonly d: TestBenchFlowDeps) {}

  private base(repoId: string): string {
    return this.d.config.getRepo(repoId)?.baseBranch ?? 'main';
  }

  /** The workspace that has `branch` checked out, or null. */
  private async workspaceOn(repoId: string, branch: string): Promise<string | null> {
    const id = this.d.workspaces.forRepo(repoId);
    if (!id) return null;
    const st = await this.d.host.wsStatus(this.d.workspaces.ref(id)).catch(() => null);
    return st?.branch === branch ? id : null;
  }

  async localCommits(repoId: string, branch: string): Promise<WsCommit[] | null> {
    const id = await this.workspaceOn(repoId, branch);
    if (!id) return null;
    return this.d.host.wsLog(this.d.workspaces.ref(id), `origin/${this.base(repoId)}`);
  }

  /** Sends the open findings (or the given ones) to an agent; they move to "fixing". */
  async fixWithAi(
    repoId: string,
    branch: string,
    findingIds?: string[],
  ): Promise<{ workspaceId: string; sessionId: string; findings: number; returnTo: string }> {
    const st = await this.d.bench.state(repoId, branch);
    if (!st.card) throw new ActionError(404, 'no_card', 'No Notion card has this Branch formula.');
    const pick = st.findings.filter((f) =>
      findingIds?.length ? findingIds.includes(f.id) : f.status === 'open',
    );
    if (!pick.length) throw new ActionError(409, 'nothing_to_fix', 'No open findings to fix.');
    const ws = await this.d.prepareBranch(repoId, branch, this.base(repoId));
    if (!ws) {
      throw new ActionError(409, 'no_workspace', 'Add a cockpit workspace for this repo first.');
    }
    const ac = new Map((st.body?.ac ?? []).map((a) => [a.key, a.text]));
    // The agent runs on the Mac and cannot read the dashboard's disk: hand it the screenshots as attachments.
    const shots = new Map<string, string>();
    const ref = this.d.workspaces.ref(ws.workspaceId);
    for (const f of pick) {
      if (
        !f.screenshotPath ||
        !this.d.evidenceDir ||
        !/^[0-9a-f-]{36}\/\d{3}\.png$/.test(f.screenshotPath)
      )
        continue;
      try {
        const png = await readFile(join(this.d.evidenceDir, f.screenshotPath));
        const group = createHash('sha256').update(f.id).digest('hex').slice(0, 16);
        const saved = await this.d.host.wsSaveAttachment(
          ref,
          group,
          'screen.png',
          png.toString('base64'),
        );
        shots.set(f.id, saved.path);
        this.d.onAttachment?.({ group, workspaceId: ws.workspaceId, findingId: f.id });
      } catch {
        /* the finding text is still enough to start */
      }
    }
    const prompt = testFixPrompt({
      card: { title: st.card.title, url: st.card.url },
      branch,
      mrOpen: this.d.hasOpenMr(repoId, branch),
      findings: pick.map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        acText: f.acKey ? (ac.get(f.acKey) ?? null) : null,
        steps: f.steps,
        expected: f.expected,
        actual: f.actual,
        screenshotPath: shots.get(f.id) ?? null,
      })),
    });
    const returnTo = `/test-bench/${repoId}?branch=${encodeURIComponent(branch)}`;
    const { sessionId } = await this.d.sendToAgent(ws.workspaceId, prompt, { returnTo });
    for (const f of pick) this.d.bench.setFindingStatus(f.id, 'fixing');
    return { workspaceId: ws.workspaceId, sessionId, findings: pick.length, returnTo };
  }

  /**
   * "1 MR = 1 commit": squash the branch onto `parentBranch` (a stacked parent) or the repo base, push once with a
   * lease, and carry a `ready` test run to the new HEAD. Refused when an MR is already open.
   */
  async squashForMr(
    repoId: string,
    branch: string,
    parentBranch: string | null,
  ): Promise<SquashResult | null> {
    if (this.d.hasOpenMr(repoId, branch)) {
      throw new ActionError(
        409,
        'mr_exists',
        'An MR is open for this branch: add commits instead of squashing.',
      );
    }
    const id = await this.workspaceOn(repoId, branch);
    // No workspace has the branch: it was pushed from elsewhere, nothing to squash here.
    if (!id) return null;
    const r = await this.d.host.wsSquashForMr(
      this.d.workspaces.ref(id),
      branch,
      `origin/${parentBranch ?? this.base(repoId)}`,
    );
    this.d.bench.carryRun(repoId, branch, r.oldHead, r.newHead);
    return r;
  }
}
