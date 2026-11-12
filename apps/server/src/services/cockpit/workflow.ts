import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  DeckStateSchema,
  type BaseSuggestResult,
  type CardContentPreview,
  type CardStartAttachment,
  type DeckSource,
  type ExplainThreadResult,
  parseFigmaUrl,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import { cardBodies, mrs, reviewDecks } from '../../db/schema';
import type { FigmaNodeSpec, FigmaService } from '../figma/figmaService';
import type { FigmaSnapshotStore } from '../figma/snapshotStore';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import type { AiService } from '../ai/aiService';
import { AiError } from '../ai/provider';
import { extractLinks, openLinks } from './linkContext';
import { GitlabService } from '../gitlabService';
import type { HttpClient } from '../httpClient';
import { mapGitlabError } from '../mrActions';
import { listCards } from '../notionStore';
import type { ReadyForMrService } from '../readyForMr';
import { threadCode } from '../threadCode';
import type { CardContentService, CardContent } from './cardContent';
import type { CockpitHost } from './host';
import type { ExistingBranch } from './workflowOps';
import type { CockpitSessionService, SessionView } from './sessionService';
import {
  cardStartPrompt,
  explainThreadVars,
  extractUploads,
  threadPrompt,
  type ThreadAgentMode,
} from './threadPrompt';
import type { WorkspaceService } from './workspaces';

/**
 * the "needs your attention" inbox, and card start (branch from the right base + an agent
 * session primed with the card and the workflow rules).
 */

export interface AttentionItem {
  kind: 'agent_waiting' | 'turn_review' | 'ready_for_mr' | 'saved_note';
  title: string;
  detail: string;
  /** Dashboard path. */
  to: string;
  at: number;
}

/** Open branches the AI base suggestion looks into (each costs one GitLab compare). */
const SUGGEST_CANDIDATES_MAX = 12;
const SUGGEST_FILES_MAX = 60;

const AGENT_KINDS = new Set(['claude', 'cursor']);

export class CockpitWorkflowService {
  constructor(
    private readonly d: {
      store: AppDb;
      host: CockpitHost;
      workspaces: WorkspaceService;
      sessions: CockpitSessionService;
      ready: ReadyForMrService;
      config: ConfigStore;
      http: HttpClient;
      log: Logger;
      ai: AiService;
      cardContent?: CardContentService;
      /** Reads the card's Figma nodes so the agent gets exact design values, not only pictures. */
      figma?: FigmaService;
      /** Each card's last Figma read, used while the bridge is down. */
      figmaSnapshots?: FigmaSnapshotStore;
      /** Called after files were saved for an agent, so cleanup knows what each attachment folder belongs to. */
      onAttachments?: (a: {
        group: string;
        workspaceId: string;
        kind: 'card' | 'thread' | 'finding';
        refId: string;
      }) => void;
    },
  ) {}

  private gitlab(repoId: string): GitlabService {
    try {
      return GitlabService.forRepo(this.d.config, repoId, {
        http: this.d.http,
        store: this.d.store,
        log: this.d.log,
      });
    } catch {
      throw new ActionError(
        409,
        'gitlab_not_configured',
        'GitLab is not configured for this repo.',
      );
    }
  }

  /**
   * Figma nodes of a card: the Test Bench link (hand-set or found in the body), the frames mapped to its ACs, then
   * any other Figma node link in the card body. Deduped, at most `FIGMA_NODES_MAX`. Links without a node are skipped:
   * a whole file is too big to hand over.
   */
  private figmaTargets(
    cardId: string,
    content: CardContent | null,
    dialogLinks: string | null,
  ): { fileKey: string; nodeId: string; label: string | null }[] {
    if (!this.d.figma) return [];
    const out = new Map<string, { fileKey: string; nodeId: string; label: string | null }>();
    const add = (fileKey: string, nodeId: string | null, label: string | null) => {
      if (!nodeId || out.size >= FIGMA_NODES_MAX) return;
      const k = `${fileKey}:${nodeId}`;
      if (!out.has(k)) out.set(k, { fileKey, nodeId, label });
    };
    for (const l of dialogLinks ? extractLinks(dialogLinks, FIGMA_NODES_MAX) : []) {
      const p = parseFigmaUrl(l);
      if (p) add(p.fileKey, p.nodeId, 'from the Start dialog');
    }
    const row = this.d.store.db
      .select()
      .from(cardBodies)
      .where(eq(cardBodies.cardId, cardId))
      .get();
    const benchUrl =
      row?.figmaOverride ?? (row?.body as { figmaUrl?: string | null } | undefined)?.figmaUrl;
    const bench = benchUrl ? parseFigmaUrl(benchUrl) : null;
    if (bench) {
      add(bench.fileKey, bench.nodeId, 'the card link');
      for (const [ac, nodeId] of Object.entries(row?.frames ?? {})) add(bench.fileKey, nodeId, ac);
    }
    const links = content
      ? [...content.card.links, ...extractLinks(content.card.markdown, 50)]
      : [];
    for (const l of links) {
      const p = parseFigmaUrl(l);
      if (p) add(p.fileKey, p.nodeId, 'linked in the card');
    }
    return [...out.values()];
  }

  /**
   * One Figma node for a card: read live and saved as the card's snapshot; when the bridge or the plugin is away, the
   * saved snapshot (`savedAt` set). Throws when neither is there.
   */
  private async figmaNode(
    cardId: string,
    fileKey: string,
    nodeId: string,
  ): Promise<{ spec: FigmaNodeSpec; png: Buffer | null; savedAt: number | null }> {
    const figma = this.d.figma!;
    try {
      const spec = await figma.nodeSpec(fileKey, nodeId);
      const png = await figma.image(fileKey, nodeId, { force: true }).catch(() => null);
      await this.d.figmaSnapshots?.save(cardId, spec, png).catch((e: unknown) => {
        this.d.log.warn({ cardId, nodeId, err: (e as Error).message }, 'figma snapshot not saved');
      });
      return { spec, png, savedAt: null };
    } catch (err) {
      const snap = await this.d.figmaSnapshots?.get(cardId, fileKey, nodeId).catch(() => null);
      if (snap) return snap;
      throw err;
    }
  }

  /** A running agent would have its files swapped underneath it. */
  private async refuseWhileAgentRuns(workspaceId: string): Promise<void> {
    const live = (await this.d.sessions.list()).some(
      (s) => s.workspaceId === workspaceId && AGENT_KINDS.has(s.kind) && s.state !== 'exited',
    );
    if (live) {
      throw new ActionError(
        409,
        'agent_running',
        'An agent session is still running in this workspace. Stop it first: switching branch would change its files.',
      );
    }
  }

  /** A workspace another card cannot start in right now: an agent runs there, or its tree has changes. */
  private async busy(workspaceId: string): Promise<boolean> {
    const live = (await this.d.sessions.list()).some(
      (s) => s.workspaceId === workspaceId && AGENT_KINDS.has(s.kind) && s.state !== 'exited',
    );
    if (live) return true;
    const status = await this.d.host.wsStatus(this.d.workspaces.ref(workspaceId));
    return status.dirty.length > 0;
  }

  /**
   * Stashes or discards a workspace's uncommitted changes so a card can start there (Start dialog, on `ws_dirty`).
   * Refused while an agent runs in it: its files would vanish from under it.
   */
  async cleanTree(
    workspaceId: string,
    mode: 'stash' | 'discard',
  ): Promise<{ mode: 'stash' | 'discard'; stash: string | null }> {
    await this.refuseWhileAgentRuns(workspaceId);
    const r = await this.d.host.wsCleanTree(this.d.workspaces.ref(workspaceId), mode);
    this.d.log.info({ workspaceId, mode, stash: r.stash }, 'workspace tree cleared');
    return r;
  }

  /** Puts a workspace on a branch, refusing when that would pull it from under a running agent. */
  private async ensureBranch(workspaceId: string, branch: string): Promise<{ synced: boolean }> {
    const ref = this.d.workspaces.ref(workspaceId);
    const status = await this.d.host.wsStatus(ref);
    if (status.branch !== branch) await this.refuseWhileAgentRuns(workspaceId);
    return this.d.host.wsCheckoutBranch(ref, branch);
  }

  /** The workspace an agent works on for a deck, on the deck's branch. Null = no workspace holds the repo. */
  async prepareDeckBranch(source: DeckSource): Promise<{ workspaceId: string } | null> {
    if (source.kind === 'local') return { workspaceId: source.workspaceId };
    const workspaceId = this.d.workspaces.forRepo(source.repoId);
    if (!workspaceId) return null;
    let branch = source.kind === 'compare' ? source.to : null;
    if (source.kind === 'mr') {
      const mr = this.d.store.db
        .select({ sourceBranch: mrs.sourceBranch })
        .from(mrs)
        .where(and(eq(mrs.repoId, source.repoId), eq(mrs.iid, source.iid)))
        .get();
      if (!mr) throw new ActionError(404, 'mr_not_found', 'This MR is not in the cache.');
      branch = mr.sourceBranch;
    }
    if (branch) await this.ensureBranch(workspaceId, branch);
    return { workspaceId };
  }

  async attention(): Promise<{ items: AttentionItem[] }> {
    const items: AttentionItem[] = [];
    let sessions: SessionView[] = [];
    try {
      sessions = await this.d.sessions.list();
    } catch {
      /* host unreachable: the other sources still count */
    }
    for (const s of sessions) {
      if (!s.waiting) continue;
      const files = s.turn?.files ?? 0;
      if (files > 0 && s.turn?.reviewed) continue;
      if (files > 0) {
        items.push({
          kind: 'turn_review',
          title: s.turn?.headline ?? `${s.title}: ${files} file${files === 1 ? '' : 's'} changed`,
          detail: `Agent turn ready to review · ${s.workspaceId}`,
          to: `/review/local/${encodeURIComponent(s.workspaceId)}/deck?mode=turn${s.turn?.checkpoint ? `&base=${s.turn.checkpoint}` : ''}`,
          at: s.lastOutputAt ?? s.startedAt,
        });
      } else {
        items.push({
          kind: 'agent_waiting',
          title: `${s.title} is waiting for input`,
          detail: s.workspaceId,
          to: `/cockpit?session=${s.id}`,
          at: s.lastOutputAt ?? s.startedAt,
        });
      }
    }
    for (const r of this.d.ready.list()) {
      items.push({
        kind: 'ready_for_mr',
        title: r.branch,
        detail: `Ready for an MR · ${r.repoName}`,
        to: `/mr-create/${encodeURIComponent(r.repoId)}?branch=${encodeURIComponent(r.branch)}`,
        at: r.pushedAt,
      });
    }
    for (const row of this.d.store.db.select().from(reviewDecks).all()) {
      const st = DeckStateSchema.safeParse(row.state);
      if (!st.success) continue;
      for (const n of st.data.notes) {
        if (n.status !== 'saved' && n.status !== 'stale') continue;
        items.push({
          kind: 'saved_note',
          title: n.text.slice(0, 120),
          detail: `${row.title} · ${n.file}${n.lines[0] ? `:${n.lines[0]}` : ''}${n.status === 'stale' ? ' (stale)' : ''}`,
          to: deckRoute(row.source as DeckSource),
          at: n.createdAt,
        });
      }
    }
    items.sort((a, b) => b.at - a.at);
    return { items };
  }

  /** Base choices for a card start: the workspace base, then branches with an open MR, then pushed ones without an MR. */
  bases(workspaceId: string): { name: string; label: string }[] {
    const w = this.d.workspaces.get(workspaceId);
    const out = [{ name: w.defaultBase, label: `${w.defaultBase} (base branch)` }];
    if (!w.repoId) return out;
    const open = this.d.store.db
      .select({ repoId: mrs.repoId, branch: mrs.sourceBranch, iid: mrs.iid })
      .from(mrs)
      .where(inArray(mrs.state, ['opened', 'locked']))
      .all()
      .filter((m) => m.repoId === w.repoId && m.branch !== w.defaultBase)
      .sort((a, b) => a.branch.localeCompare(b.branch));
    for (const m of open) {
      out.push({ name: `origin/${m.branch}`, label: `${m.branch} (open MR !${m.iid})` });
    }
    const withMr = new Set(open.map((m) => m.branch));
    const pushed = this.d.ready
      .branchHeads(w.repoId)
      .map((h) => h.branch)
      .filter((b) => !withMr.has(b) && b !== w.defaultBase)
      .sort();
    for (const b of new Set(pushed)) {
      out.push({ name: `origin/${b}`, label: `${b} (pushed, no MR yet)` });
    }
    return out;
  }

  /**
   * "Let AI decide": which offered base suits this card, from the card's title and what each open branch changes. The
   * choice stays the user's: this only pre-selects one. A branch that cannot be read is still offered, without its files.
   */
  async suggestBase(input: { cardId: string; workspaceId: string }): Promise<BaseSuggestResult> {
    const cards = listCards(this.d.store);
    const card = cards.find((c) => c.id === input.cardId);
    if (!card) throw new ActionError(404, 'card_not_found', 'Card not found.');
    const w = this.d.workspaces.get(input.workspaceId);
    const bases = this.bases(input.workspaceId);
    if (bases.length === 1) {
      return {
        base: bases[0]!.name,
        reason: 'No open MR or pushed branch to stack on, so the base branch is the only choice.',
        generatedBy: null,
      };
    }
    const svc = this.gitlab(w.repoId!);
    const candidates = await Promise.all(
      bases.slice(0, SUGGEST_CANDIDATES_MAX + 1).map(async (b) => {
        if (b.name === w.defaultBase) return { name: b.name, label: b.label, isDefaultBase: true };
        const branch = b.name.replace(/^origin\//, '');
        const owner = cards.find((c) => c.branchName?.trim() === branch);
        const diff = await svc.compare(w.defaultBase, branch).catch(() => null);
        return {
          name: b.name,
          label: b.label,
          card: owner?.title ?? null,
          commits: diff?.commits.map((c) => c.title) ?? null,
          files: diff?.files.slice(0, SUGGEST_FILES_MAX).map((f) => f.path) ?? null,
        };
      }),
    );
    const parent = card.parentId ? cards.find((c) => c.id === card.parentId) : null;
    const { output, generatedBy } = await this.d.ai.run('base-suggest', {
      card: JSON.stringify({
        title: card.title,
        type: card.type,
        branch: card.branchName,
        parentCard: parent?.title ?? null,
      }),
      candidates: JSON.stringify(candidates, null, 1),
    });
    if (!bases.some((b) => b.name === output.base)) {
      throw new AiError('ai_bad_output', 'The AI picked a branch that is not on the list.');
    }
    return { ...output, generatedBy };
  }

  /**
   * "Explain with AI" on a reviewer's thread: does the comment fit what the MR's commits and changes do, and what to
   * tell the reviewer. Read-only and needs no workspace; the thread is re-read from GitLab, never taken from the browser.
   */
  async threadExplain(input: {
    repoId: string;
    iid: number;
    discussionId: string;
    /** Extra context from the user; links in it are opened. */
    context?: string | undefined;
  }): Promise<ExplainThreadResult> {
    const mr = this.d.store.db
      .select()
      .from(mrs)
      .where(and(eq(mrs.repoId, input.repoId), eq(mrs.iid, input.iid)))
      .get();
    if (!mr) throw new ActionError(404, 'mr_not_found', 'This MR is not in the cache.');
    const svc = this.gitlab(input.repoId);
    const threads = await svc.getReviewDiscussions(input.iid).catch(mapGitlabError);
    const discussion = threads.find((t) => t.id === input.discussionId);
    if (!discussion)
      throw new ActionError(404, 'thread_not_found', 'This thread no longer exists.');
    const [diffs, compared] = await Promise.all([
      svc.getMrDiffs(input.iid).catch(() => null),
      svc.compare(mr.targetBranch, mr.sourceBranch).catch(() => null),
    ]);
    const code = discussion.position ? threadCode(discussion.position, diffs?.files ?? null) : null;
    const links = input.context
      ? await openLinks(extractLinks(input.context), {
          http: this.d.http,
          gitlabHost: svc.host,
          gitlabItem: (path, kind, iid) => svc.getIssuable(path, kind, iid),
        })
      : [];
    const vars = explainThreadVars({
      mr,
      discussion,
      code,
      commits: (compared?.commits ?? []).map((c) => ({ id: c.id, message: c.message ?? c.title })),
      files: (diffs?.files ?? compared?.files ?? []).map((f) => ({ path: f.path, diff: f.diff })),
      discussions: threads,
      ...(input.context?.trim() ? { context: input.context.trim() } : {}),
      links,
    });
    const { output, generatedBy } = await this.d.ai.run('explain-thread', vars);
    return { ...output, generatedBy };
  }

  /**
   * "Review / Fix with agent" on a reviewer's thread: a NEW session on the MR's branch, primed with the thread, the code
   * it was left on and its attachments. The thread is re-read from GitLab here, never taken from the browser.
   */
  async threadAgent(input: {
    repoId: string;
    iid: number;
    discussionId: string;
    mode: ThreadAgentMode;
    agent?: 'claude' | 'cursor' | undefined;
    model?: string | undefined;
  }): Promise<{
    workspaceId: string;
    sessionId: string;
    branch: string;
    attachments: number;
    failedAttachments: number;
  }> {
    const workspaceId = this.d.workspaces.forRepo(input.repoId);
    if (!workspaceId) {
      throw new ActionError(
        409,
        'no_workspace',
        'No Cockpit workspace is linked to this repository. Add one in Settings → Workspaces.',
      );
    }
    const mr = this.d.store.db
      .select()
      .from(mrs)
      .where(and(eq(mrs.repoId, input.repoId), eq(mrs.iid, input.iid)))
      .get();
    if (!mr) throw new ActionError(404, 'mr_not_found', 'This MR is not in the cache.');

    const svc = this.gitlab(input.repoId);
    const threads = await svc.getReviewDiscussions(input.iid).catch(mapGitlabError);
    const discussion = threads.find((t) => t.id === input.discussionId);
    if (!discussion)
      throw new ActionError(404, 'thread_not_found', 'This thread no longer exists.');
    // The code is context: without the diff the agent still gets the path and line.
    const diffs = await svc.getMrDiffs(input.iid).catch(() => null);
    const code = discussion.position ? threadCode(discussion.position, diffs?.files ?? null) : null;

    const { synced } = await this.ensureBranch(workspaceId, mr.sourceBranch);
    const ref = this.d.workspaces.ref(workspaceId);

    const attachments: string[] = [];
    const failed: string[] = [];
    for (const u of extractUploads(discussion.notes.map((n) => n.body))) {
      try {
        const bytes = await svc.downloadUpload(u.secret, u.filename);
        const { path } = await this.d.host.wsSaveAttachment(
          ref,
          input.discussionId,
          `${u.secret.slice(0, 8)}-${u.filename}`,
          bytes.toString('base64'),
        );
        attachments.push(path);
        this.d.onAttachments?.({
          group: input.discussionId,
          workspaceId,
          kind: 'thread',
          refId: `${input.repoId}!${input.iid}#${input.discussionId}`,
        });
      } catch (e) {
        this.d.log.warn({ err: (e as Error).message }, 'thread attachment download failed');
        failed.push(u.url);
      }
    }

    const prompt = threadPrompt({
      mode: input.mode,
      mr: {
        iid: mr.iid,
        title: mr.title,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        webUrl: mr.webUrl,
      },
      discussion,
      code,
      attachments,
      failedAttachments: failed,
      branchSynced: synced,
    });
    const s = await this.d.sessions.startPreferred(workspaceId, {
      ...(input.agent ? { kind: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    await this.d.sessions.prompt(s.id, prompt);
    return {
      workspaceId,
      sessionId: s.id,
      branch: mr.sourceBranch,
      attachments: attachments.length,
      failedAttachments: failed.length,
    };
  }

  /** What Start with agent will send from the Notion card, for the dialog. */
  async cardContentPreview(
    cardId: string,
    opts: { force?: boolean } = {},
  ): Promise<CardContentPreview> {
    const card = listCards(this.d.store).find((c) => c.id === cardId);
    if (!card) throw new ActionError(404, 'card_not_found', 'Card not found.');
    if (!this.d.cardContent)
      throw new ActionError(409, 'notion_not_configured', 'Notion is not configured.');
    const c = await this.d.cardContent.read(card, opts).catch((e: unknown) => {
      throw new ActionError(
        502,
        'card_unreadable',
        `Could not read the card from Notion: ${(e as Error).message}`,
      );
    });
    return {
      excerpt: c.card.markdown.slice(0, PREVIEW_CHARS),
      chars: c.card.markdown.length,
      truncated: c.card.truncated,
      imageCount: c.assets.filter((a) => a.kind === 'image').length,
      fileCount: c.assets.filter((a) => a.kind === 'file').length,
      parent: c.parent ? { title: c.parent.title, chars: c.parent.markdown.length } : null,
      parentError: c.parentError,
      links: [...new Set([...c.card.links, ...(c.parent?.links ?? [])])].slice(0, 20),
    };
  }

  async cardStart(input: {
    cardId: string;
    workspaceId: string;
    base: string;
    agent: 'claude' | 'cursor' | null;
    /** Legacy spelling of `existing: 'replace'`. */
    replace?: boolean;
    /** The card's branch already exists: reset it to the base, or check it out as it is. Unset = refuse. */
    existing?: ExistingBranch;
    extraPrompt?: string;
    attachments?: readonly CardStartAttachment[];
    /** Figma node links typed in the Start dialog, on top of the card's own. */
    figmaUrl?: string;
    /**
     * 'auto' (bulk start): when the workspace is busy (an agent runs there, or it has uncommitted changes), the card
     * gets a git worktree of its own instead, so several agents can work at once.
     */
    worktree?: 'auto';
  }): Promise<{
    branch: string;
    sessionId: string | null;
    workspaceId: string;
    worktree: boolean;
  }> {
    const card = listCards(this.d.store).find((c) => c.id === input.cardId);
    if (!card) throw new ActionError(404, 'card_not_found', 'Card not found.');
    const branch = card.branchName?.trim();
    if (!branch)
      throw new ActionError(409, 'no_branch_formula', 'This card has no Branch formula.');
    if (!this.bases(input.workspaceId).some((b) => b.name === input.base)) {
      throw new ActionError(422, 'invalid_base', 'Pick one of the offered base branches.');
    }
    // Checked before anything changes on disk: a bad file must not leave a half-started card.
    const mine = (input.attachments ?? []).map((a, n) => ({ ...decodeAttachment(a), n: n + 1 }));
    let workspaceId = input.workspaceId;
    let started: { replaced: boolean; reused?: boolean };
    const existing = input.existing ?? (input.replace ? 'replace' : undefined);
    const isolate = input.worktree === 'auto' && (await this.busy(input.workspaceId));
    if (isolate) {
      const wt = await this.d.workspaces.addWorktree(
        input.workspaceId,
        branch,
        input.base,
        existing,
      );
      workspaceId = wt.workspace.id;
      started = wt;
    } else {
      await this.refuseWhileAgentRuns(input.workspaceId);
      started = await this.d.host.wsStartBranch(
        this.d.workspaces.ref(input.workspaceId),
        branch,
        input.base,
        existing,
      );
    }
    const done = { branch, workspaceId, worktree: isolate };
    if (!input.agent) return { ...done, sessionId: null };

    // The card body: a Notion failure never blocks the start, the agent is told and can ask.
    let content: CardContent | null = null;
    let bodyError: string | null = this.d.cardContent ? null : 'Notion is not configured';
    if (this.d.cardContent) {
      try {
        content = await this.d.cardContent.read(card);
      } catch (e) {
        bodyError = (e as Error).message;
        this.d.log.warn({ cardId: card.id, err: bodyError }, 'card start: body unreadable');
      }
    }

    const ref = this.d.workspaces.ref(workspaceId);
    const group = createHash('sha256')
      .update(`${card.id}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);
    const attachments: { path: string; source: 'card' | 'mine' | 'figma'; label: string }[] = [];
    const failed: string[] = [];
    if (content && this.d.cardContent && content.assets.length > 0) {
      const dl = await this.d.cardContent.downloadAssets(content);
      for (const f of dl.failed)
        failed.push(`${f.ref.kind} ${f.ref.n} from the card (${f.reason})`);
      for (const a of dl.ok) {
        try {
          const { path } = await this.d.host.wsSaveAttachment(ref, group, a.name, a.dataBase64);
          attachments.push({
            path,
            source: 'card',
            label: `[${a.ref.kind} ${a.ref.n}]${a.ref.caption ? ` ${a.ref.caption}` : ''}`,
          });
        } catch (e) {
          failed.push(`${a.ref.kind} ${a.ref.n} from the card (${(e as Error).message})`);
        }
      }
    }
    for (const t of this.figmaTargets(card.id, content, input.figmaUrl ?? null)) {
      const id = t.nodeId.replace(':', '-');
      const where = `Figma node ${t.nodeId}${t.label ? ` (${t.label})` : ''}`;
      let got: Awaited<ReturnType<CockpitWorkflowService['figmaNode']>>;
      try {
        got = await this.figmaNode(card.id, t.fileKey, t.nodeId);
      } catch (e) {
        failed.push(`${where} (${(e as Error).message})`);
        continue;
      }
      const note = got.savedAt
        ? `, saved ${new Date(got.savedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC while Figma was connected; the design may have changed since`
        : '';
      try {
        const json = JSON.stringify(got.spec, null, 1);
        if (json.length > FIGMA_SPEC_MAX_BYTES) {
          throw new Error(`its spec is ${Math.round(json.length / 1e6)} MB, over the 5 MB limit`);
        }
        const { path } = await this.d.host.wsSaveAttachment(
          ref,
          group,
          `figma-${id}.json`,
          Buffer.from(json).toString('base64'),
        );
        attachments.push({ path, source: 'figma', label: `${where}: full spec${note}` });
      } catch (e) {
        failed.push(`${where} spec (${(e as Error).message})`);
      }
      if (!got.png) {
        failed.push(`${where} image (Figma did not render it)`);
        continue;
      }
      try {
        const { path } = await this.d.host.wsSaveAttachment(
          ref,
          group,
          `figma-${id}.png`,
          got.png.toString('base64'),
        );
        attachments.push({ path, source: 'figma', label: `${where}: rendered image${note}` });
      } catch (e) {
        failed.push(`${where} image (${(e as Error).message})`);
      }
    }
    for (const m of mine) {
      try {
        const { path } = await this.d.host.wsSaveAttachment(
          ref,
          group,
          `user-${m.n}-${m.name}`,
          m.dataBase64,
        );
        attachments.push({ path, source: 'mine', label: m.name });
      } catch (e) {
        failed.push(`${m.name} (${(e as Error).message})`);
      }
    }
    if (attachments.length > 0)
      this.d.onAttachments?.({
        group,
        workspaceId: workspaceId,
        kind: 'card',
        refId: card.id,
      });

    const s = await this.d.sessions.start({
      workspaceId: workspaceId,
      kind: input.agent,
      cols: 100,
      rows: 30,
    });
    // Cursor runs in its TUI, which needs a moment to draw before the first prompt.
    if (input.agent === 'cursor') await new Promise((r) => setTimeout(r, 2_500));
    await this.d.sessions.prompt(
      s.id,
      cardStartPrompt({
        title: card.title,
        url: card.url ?? null,
        branchName: branch,
        base: input.base,
        replaced: started.replaced,
        reused: !!started.reused,
        body: content ? content.card : null,
        bodyError,
        parent: content?.parent ?? null,
        extraPrompt: input.extraPrompt ?? null,
        attachments,
        failedAttachments: failed,
      }),
    );
    return { ...done, sessionId: s.id };
  }
}

const PREVIEW_CHARS = 1_500;
const FIGMA_NODES_MAX = 6;
// The host agent takes 8 MB per request and the file travels as base64.
const FIGMA_SPEC_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** A user file from the Start dialog: real base64, at most 5 MB, a name safe to show and store. */
function decodeAttachment(a: CardStartAttachment): CardStartAttachment {
  const bytes = Buffer.from(a.dataBase64, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== a.dataBase64.replace(/\s/g, '')) {
    throw new ActionError(422, 'invalid_attachment', `${a.name} is not valid base64.`);
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new ActionError(413, 'attachment_too_large', `${a.name} is larger than 5 MB.`);
  }
  const name = a.name.replace(/[^\w.\- ]+/g, '_').slice(-100) || 'file';
  return { name, dataBase64: bytes.toString('base64') };
}

export function deckRoute(s: DeckSource): string {
  const e = encodeURIComponent;
  if (s.kind === 'mr') return `/review/mr/${e(`${s.repoId}!${s.iid}`)}/deck`;
  if (s.kind === 'compare')
    return `/review/compare/${e(s.repoId)}/deck?from=${e(s.from)}&to=${e(s.to)}`;
  return `/review/local/${e(s.workspaceId)}/deck?mode=${s.mode}${s.base ? `&base=${e(s.base)}` : ''}`;
}
