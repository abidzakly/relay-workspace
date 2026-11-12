import { eq } from 'drizzle-orm';
import {
  type DeckSource,
  type DiffFile,
  ancestorsOf,
  DeckStateSchema,
  type MrChatMessage,
  type MrChatResult,
  type MrSummaryResult,
  type MrChatRequest,
  type MrCreateNotion,
  type MrCreatePreview,
  type MrCreateRequest,
  type MrCreateResult,
  type MrSummaryOutput,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { reviewDecks } from '../db/schema';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { ownCommitsCompare } from './deck/diffSources';
import { deckIdOf } from './deck/reviewDeck';
import { guardedWrite } from './dryRun';
import { GitlabReleaseApi } from './gitlabRelease';
import { GitlabApiError, GitlabService } from './gitlabService';
import type { HttpClient } from './httpClient';
import { buildMrPayload, mrTemplate } from './mrTemplate';
import { mapGitlabError } from './mrActions';
import { listCards } from './notionStore';
import type { AiService } from './ai/aiService';

/**
 * Create MR from the app. `preview` reads GitLab LIVE (commits base...branch, open MRs
 * into base, pushed heads without MR) and shows exactly what will be sent; `create` re-checks and writes through
 * `guardedWrite` (dry-run + audit). A parent branch WITHOUT an MR blocks creation: make the parent's MR first.
 */

export class MrCreateError extends ActionError {
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'MrCreateError';
  }
}

export interface MrCreateDeps {
  config: ConfigStore;
  store: AppDb;
  audit: AuditWriter;
  http: HttpClient;
  log: Logger;
  bus?: EventBus;
  /** Pushed heads without MR (ReadyForMrService.branchHeads). */
  branchHeads: (repoId: string) => { branch: string; sha: string }[];
  /** For the AI summary on the confirmation screen (not the MR description). */
  ai?: AiService;
  /** Whether a finished deck covers the branch's diff as it is now. Without it, only "was a deck finished" is known. */
  deckReview?: (
    source: DeckSource,
    diff: { files: DiffFile[]; headSha: string | null },
  ) => Promise<{ reviewed: boolean; stale: boolean }>;
  /**
   * "1 MR = 1 commit": squash the branch onto its stacked parent (or the base) and push once
   * with a lease, right before the MR is created. null = nothing done (no workspace has the branch).
   */
  squash?: (
    repoId: string,
    branch: string,
    parentBranch: string | null,
  ) => Promise<{ oldHead: string; newHead: string; squashed: number; pushed: boolean } | null>;
  /** Test Bench gate: a `ready` run on the current HEAD. Without it, no device test is asked. */
  testGate?: (repoId: string, branch: string) => Promise<{ testOk: boolean; stale: boolean }>;
  /**
   * After a real MR exists: set the branch's Notion card to Completed unless it already is.
   * Must not throw; a Notion failure must not undo the MR.
   */
  markCompleted?: (cardId: string) => Promise<MrCreateNotion>;
}

const MAX_CHAT_HISTORY_CHARS = 30_000;

/** The conversation as prompt text; when too long the newest part is kept. Pure. */
export function renderChatHistory(history: readonly MrChatMessage[]): string {
  if (history.length === 0) return '(belum ada)';
  return history
    .map((m) => `${m.role === 'user' ? 'User' : 'Asisten'}: ${m.text}`)
    .join('\n\n')
    .slice(-MAX_CHAT_HISTORY_CHARS);
}

/** The summary the user is chatting about, as prompt text. Pure. */
export function renderSummary(s: MrSummaryOutput): string {
  const list = (title: string, items: readonly string[]) =>
    items.length > 0 ? [`${title}:`, ...items.map((i) => `- ${i}`)] : [];
  return [s.summary, ...list('Poin', s.bullets), ...list('Risiko', s.risks)].join('\n');
}

export class MrCreateService {
  constructor(private readonly d: MrCreateDeps) {}

  private svc(repoId: string): GitlabService {
    if (!this.d.config.getRepo(repoId))
      throw new MrCreateError(404, 'repo_not_found', 'Unknown repository');
    try {
      return GitlabService.forRepo(this.d.config, repoId, {
        http: this.d.http,
        store: this.d.store,
        log: this.d.log,
      });
    } catch {
      throw new MrCreateError(409, 'gitlab_not_configured', 'GitLab host is not configured');
    }
  }

  private deckDone(repoId: string, base: string, branch: string): boolean {
    const row = this.d.store.db
      .select({ state: reviewDecks.state })
      .from(reviewDecks)
      .where(eq(reviewDecks.deckId, deckIdOf({ kind: 'compare', repoId, from: base, to: branch })))
      .get();
    const p = row ? DeckStateSchema.safeParse(row.state) : null;
    return !!p?.success && p.data.completedAt !== null;
  }

  async preview(repoId: string, branch: string): Promise<MrCreatePreview> {
    const repo = this.d.config.getRepo(repoId)!;
    const svc = this.svc(repoId);
    const base = repo.baseBranch;
    if (branch === base)
      throw new MrCreateError(422, 'base_branch', 'Pick a feature branch, not the base branch.');
    const card = listCards(this.d.store).find((c) => c.branchName?.trim() === branch) ?? null;
    const me = this.d.config.getGlobal().gitlab.myUsername ?? null;
    const template = mrTemplate({
      branch,
      targetBranch: base,
      notionUrl: card?.url ?? null,
      assignee: me,
      reviewers: repo.reviewers,
    });

    let compare, open;
    try {
      [compare, open] = await Promise.all([svc.compare(base, branch), svc.listOpenMrsInto(base)]);
    } catch (e) {
      return mapGitlabError(e);
    }
    const existing = open.mrs.find((m) => m.sourceBranch === branch) ?? null;
    const commits = compare.commits.map((c) => c.id.toLowerCase());
    const candidates = [
      ...open.mrs
        .filter((m) => m.sourceBranch !== branch)
        .map((m) => ({
          key: `!${m.iid}`,
          iid: m.iid as number | null,
          branch: m.sourceBranch,
          headSha: m.headSha ?? null,
        })),
      ...this.d
        .branchHeads(repoId)
        .filter((h) => h.branch !== branch && !open.mrs.some((m) => m.sourceBranch === h.branch))
        .map((h) => ({ key: `branch:${h.branch}`, iid: null, branch: h.branch, headSha: h.sha })),
    ];
    const anc = ancestorsOf({ key: 'self', headSha: commits[0] ?? null, commits }, candidates);
    // Parent first (deepest ancestor = appears last in the newest-first commit list).
    const idx = (h: string | null) => commits.indexOf((h ?? '').toLowerCase());
    anc.sort((a, b) => idx(b.headSha) - idx(a.headSha));

    const warnings: MrCreatePreview['warnings'] = [];
    const withoutMr = anc.filter((a) => a.iid === null);
    if (withoutMr.length > 0) {
      warnings.push({
        code: 'parent_without_mr',
        message: `Parent ${withoutMr.map((a) => a.branch).join(', ')} has no MR yet: create the parent MR first.`,
      });
    }
    if (anc.some((a) => a.iid !== null)) {
      warnings.push({
        code: 'stack_parent_open',
        message: `Stacked on ${anc
          .filter((a) => a.iid !== null)
          .map((a) => `!${a.iid}`)
          .join(', ')}: merge one at a time, parent first.`,
      });
    }
    if (!card?.url) {
      warnings.push({
        code: 'no_notion_url',
        message: 'No Notion card has this Branch formula.',
      });
    }
    const deckReview = this.d.deckReview
      ? await this.d.deckReview(
          { kind: 'compare', repoId, from: base, to: branch },
          {
            // Same scope as the deck itself: own commits only, so the diff SHA matches.
            files: (
              await ownCommitsCompare(svc, base, branch, () => this.d.branchHeads(repoId), compare)
            ).compare.files,
            headSha: compare.commits[0]?.id ?? null,
          },
        )
      : { reviewed: this.deckDone(repoId, base, branch), stale: false };
    return {
      repoId,
      branch,
      template,
      card: card
        ? { id: card.id, title: card.title, url: card.url ?? null, status: card.status ?? null }
        : null,
      commitCount: compare.commitCount,
      parents: anc.map((a) => ({ iid: a.iid, branch: a.branch })),
      stackPosition: anc.length + 1,
      warnings,
      blocked: withoutMr.length > 0 || !card?.url,
      deckCompleted: deckReview.reviewed,
      deckStale: deckReview.stale,
      existingMrIid: existing?.iid ?? null,
      ...(await this.testState(repoId, branch)),
    };
  }

  private async testState(
    repoId: string,
    branch: string,
  ): Promise<{ testRequired: boolean; testOk: boolean; testStale: boolean }> {
    if (!this.d.testGate) return { testRequired: false, testOk: false, testStale: false };
    // Fails closed: a gate that cannot answer counts as "not tested".
    const g = await this.d.testGate(repoId, branch).catch(() => ({ testOk: false, stale: false }));
    return { testRequired: true, testOk: g.testOk, testStale: g.stale };
  }

  /** The AI engine plus the live card and diff of a branch, shared by the summary and its chat. */
  private async aiContext(repoId: string, branch: string) {
    const ai = this.d.ai;
    if (!ai) throw new MrCreateError(409, 'ai_unavailable', 'AI is not configured.');
    const repo = this.d.config.getRepo(repoId);
    const svc = this.svc(repoId);
    const compare = await svc.compare(repo!.baseBranch, branch).catch(mapGitlabError);
    const card = listCards(this.d.store).find((c) => c.branchName?.trim() === branch);
    const diff = compare.files
      .map((f) => `### ${f.path}\n${f.diff ?? '(binary / terlalu besar)'}`)
      .join('\n\n')
      .slice(0, 150_000);
    return { ai, diff, card: card ? `${card.title} ${card.url ?? ''}` : '(tidak ada card)' };
  }

  /** `mr-summary` for the confirmation screen. The MR description stays the Notion URL. */
  async summary(repoId: string, branch: string): Promise<MrSummaryResult> {
    const { ai, card, diff } = await this.aiContext(repoId, branch);
    const { output, generatedBy } = await ai.run('mr-summary', { card, diff });
    return { ...output, generatedBy };
  }

  /** `mr-chat`: a follow-up on the summary. The client holds the conversation; nothing is stored here. */
  async chat(req: MrChatRequest): Promise<MrChatResult> {
    const { ai, card, diff } = await this.aiContext(req.repo, req.branch);
    const { output, generatedBy } = await ai.run('mr-chat', {
      question: req.question,
      history: renderChatHistory(req.history),
      summary: renderSummary(req.summary),
      card,
      diff,
    });
    return { ...output, generatedBy };
  }

  async create(req: MrCreateRequest): Promise<MrCreateResult> {
    const p = await this.preview(req.repoId, req.branch);
    if (p.existingMrIid !== null) {
      throw new MrCreateError(409, 'mr_exists', `An open MR already exists: !${p.existingMrIid}.`);
    }
    if (p.blocked) {
      throw new MrCreateError(
        409,
        'mr_create_blocked',
        p.warnings
          .filter((w) => w.code === 'parent_without_mr' || w.code === 'no_notion_url')
          .map((w) => w.message)
          .join(' '),
        { preview: p },
      );
    }
    if (!p.deckCompleted && !req.skipReviewReason) {
      throw new MrCreateError(
        409,
        'review_required',
        'Finish the Review Deck for this branch first, or skip it with a reason.',
      );
    }
    if (p.testRequired && !p.testOk && !req.skipTestReason) {
      throw new MrCreateError(
        409,
        'test_required',
        'Test the branch on a device (Test Bench) first, or skip it with a reason.',
      );
    }
    if (!p.template.assignee) {
      throw new MrCreateError(
        409,
        'identity_missing',
        'Set your GitLab username in Settings first.',
      );
    }
    const repo = this.d.config.getRepo(req.repoId)!;
    const host = this.d.config.getGlobal().gitlab.host!;
    const dry = this.d.config.isDryRun();
    // One commit per MR: squash before GitLab sees the MR (never in a dry run: it rewrites the branch).
    let squash: Awaited<ReturnType<NonNullable<MrCreateDeps['squash']>>> = null;
    if (!dry && this.d.squash) {
      // `parents` is deepest first: the direct parent is the last one.
      const parent = p.parents.at(-1)?.branch ?? null;
      try {
        squash = await this.d.squash(req.repoId, req.branch, parent);
      } catch (e) {
        if (e instanceof ActionError) throw e;
        const he = e as { code?: string; status?: number; message?: string };
        throw new MrCreateError(
          he.status && he.status < 500 ? he.status : 409,
          he.code ?? 'squash_failed',
          `Could not squash the branch to one commit: ${he.message ?? 'unknown error'}. The MR was not created.`,
        );
      }
    }
    const api = dry
      ? null
      : new GitlabReleaseApi(host, repo.gitlab.token, repo.gitlab.projectId, this.d.http);

    try {
      const out = await guardedWrite(
        { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
        {
          actor: 'user',
          action: 'mr.create',
          targetType: 'branch',
          targetId: `${req.repoId}:${req.branch}`,
          confirmed: true,
          before: { mr: null },
          after: {
            ...p.template,
            commitCount: p.commitCount,
            stackPosition: p.stackPosition,
            review: p.deckCompleted ? 'deck_completed' : 'skipped',
            ...(req.skipReviewReason ? { skipReviewReason: req.skipReviewReason } : {}),
            deviceTest: !p.testRequired ? 'not_required' : p.testOk ? 'passed' : 'skipped',
            ...(squash && squash.squashed > 1
              ? { squashed: { commits: squash.squashed, from: squash.oldHead, to: squash.newHead } }
              : {}),
            ...(p.testRequired && !p.testOk && req.skipTestReason
              ? { skipTestReason: req.skipTestReason }
              : {}),
          },
          reversible: false,
          afterResult: (r) => ({ iid: r.mr?.iid ?? null, existed: r.existed }),
          run: async () => {
            const id = async (u: string) => {
              const v = await api!.findUserId(u);
              if (v === null)
                throw new MrCreateError(422, 'gitlab_user_not_found', `GitLab has no user ${u}`);
              return v;
            };
            const assigneeId = await id(p.template.assignee!);
            const reviewerIds = [...new Set(await Promise.all(p.template.reviewers.map(id)))];
            try {
              const mr = await api!.createMr(
                buildMrPayload(p.template, { assigneeId, reviewerIds }),
              );
              return { mr, existed: false };
            } catch (e) {
              if (e instanceof GitlabApiError && e.status === 409)
                return { mr: null, existed: true };
              throw e;
            }
          },
        },
      );
      let iid = out.result?.mr?.iid ?? null;
      let webUrl = out.result?.mr?.webUrl ?? null;
      if (!out.dryRun) {
        const svc = this.svc(req.repoId);
        if (iid === null) {
          const found = (
            await svc.listMrs({ state: 'opened', sourceBranch: req.branch, maxPages: 1 })
          ).mrs[0];
          iid = found?.iid ?? null;
          webUrl = found?.webUrl ?? null;
        }
        if (iid !== null) {
          await svc.syncMr(iid).catch(() => undefined);
          this.d.bus?.emit({ type: 'mrs.changed', repoId: req.repoId, iids: [iid] });
        }
        this.d.bus?.emit({ type: 'cockpit.changed', what: 'ready' });
      }
      let notion: MrCreateNotion | null = null;
      if (!out.dryRun && iid !== null && p.card && this.d.markCompleted) {
        notion = await this.d.markCompleted(p.card.id).catch((e: unknown) => ({
          outcome: 'failed' as const,
          status: p.card?.status ?? null,
          error: e instanceof Error ? e.message : 'Could not update the Notion card',
        }));
      }
      return {
        dryRun: out.dryRun,
        auditId: out.audit.id,
        iid,
        webUrl,
        existed: out.result?.existed ?? false,
        notion,
      };
    } catch (e) {
      if (e instanceof ActionError) throw e;
      return mapGitlabError(e);
    }
  }
}
