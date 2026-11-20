import {
  deckSourceKey,
  type DiffFile,
  type ReviewAssistSource,
  type ReviewExplainRequest,
  type ReviewExplainResult,
  type ReviewProposeRequest,
  type ReviewProposeResult,
} from '@relay/shared';
import type { Logger } from '../../util/logger';
import type { AiService } from '../ai/aiService';
import {
  DeckError,
  type AgentBranchPreparer,
  type AgentSender,
  type DeckDiff,
  type DeckDiffReader,
} from '../deck/reviewDeck';
import { renderChatHistory } from '../mrCreate';

/**
 * Code Review assist (the classic review, not the deck): "Explain" is a chat about why a file changed, "Propose
 * changes" turns the reviewer's request into an agent prompt for one file or the whole branch, and can send it to the
 * branch's agent session. Nothing is stored: the client holds the conversation.
 */
export interface ReviewAssistDeps {
  log: Logger;
  ai: AiService;
  readDiff: DeckDiffReader;
  /** Commit messages of the source, newest first. Empty when unknown. */
  commitsOf?: (source: ReviewAssistSource) => Promise<string[]>;
  sendToAgent?: AgentSender;
  prepareAgentBranch?: AgentBranchPreparer;
  now?: () => number;
}

const DIFF_TTL_MS = 2 * 60_000;
const MAX_FILE_CHARS = 30_000;
const MAX_BRANCH_CHARS = 60_000;
const MAX_COMMITS_CHARS = 8_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (dipotong)` : s);

const fileText = (f: DiffFile) => {
  if (f.binary) return '(binary file)';
  if (f.tooLarge || f.collapsed) return '(diff too large to show)';
  return f.diff || '(no content changes)';
};

const titleOf = (d: DeckDiff) => [d.title, d.subtitle].filter(Boolean).join('\n') || '(tidak ada)';

export class ReviewAssistService {
  /** source key → diff, so a chat does not read GitLab on every turn. */
  private readonly diffs = new Map<string, { at: number; diff: Promise<DeckDiff> }>();

  constructor(private readonly d: ReviewAssistDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private diff(source: ReviewAssistSource): Promise<DeckDiff> {
    const key = deckSourceKey(source);
    const hit = this.diffs.get(key);
    if (hit && this.now() - hit.at < DIFF_TTL_MS) return hit.diff;
    for (const [k, v] of this.diffs) if (this.now() - v.at >= DIFF_TTL_MS) this.diffs.delete(k);
    const diff = this.d.readDiff(source);
    this.diffs.set(key, { at: this.now(), diff });
    diff.catch(() => this.diffs.delete(key));
    return diff;
  }

  private file(d: DeckDiff, path: string): DiffFile {
    const f = d.files.find((x) => x.path === path);
    if (!f) throw new DeckError(404, 'file_not_found', 'This file is not in the diff any more.');
    return f;
  }

  private async commits(source: ReviewAssistSource): Promise<string> {
    if (!this.d.commitsOf) return '(tidak diketahui)';
    try {
      const list = await this.d.commitsOf(source);
      return list.length
        ? clip(list.map((m) => `- ${m.trim()}`).join('\n'), MAX_COMMITS_CHARS)
        : '(tidak ada)';
    } catch (e) {
      this.d.log.debug({ err: (e as Error).message }, 'review assist commit read failed');
      return '(tidak diketahui)';
    }
  }

  async explain(req: ReviewExplainRequest): Promise<ReviewExplainResult> {
    const [d, commits] = await Promise.all([this.diff(req.source), this.commits(req.source)]);
    const f = this.file(d, req.file);
    const others = d.files.filter((x) => x.path !== f.path).map((x) => `- ${x.path}`);
    const { output, generatedBy } = await this.d.ai.run('explain-change-chat', {
      file: f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path,
      question: req.question?.trim() || '(tidak ada)',
      history: renderChatHistory(req.history),
      title: titleOf(d),
      commits,
      others: clip(others.join('\n'), 4_000) || '(tidak ada)',
      diff: clip(fileText(f), MAX_FILE_CHARS),
    });
    return { answer: output.answer, generatedBy };
  }

  private async agentWorkspace(source: ReviewAssistSource): Promise<string | null> {
    return this.d.prepareAgentBranch
      ? ((await this.d.prepareAgentBranch(source))?.workspaceId ?? null)
      : null;
  }

  async propose(req: ReviewProposeRequest): Promise<ReviewProposeResult> {
    // Before the AI call: a refused branch switch should not cost one.
    const ws = req.send ? await this.agentWorkspace(req.source) : null;
    let prompt = req.prompt?.trim();
    let generatedBy: ReviewProposeResult['generatedBy'] = null;
    if (!prompt) {
      const d = await this.diff(req.source);
      let scope: string;
      let diff: string;
      if (req.scope === 'file') {
        const f = this.file(d, req.file!);
        scope = `file ${f.path}`;
        diff = clip(`### ${f.path}\n${fileText(f)}`, MAX_FILE_CHARS);
      } else {
        scope = `whole branch (${d.files.length} files)`;
        diff = clip(
          d.files.map((f) => `### ${f.path}\n${fileText(f)}`).join('\n\n'),
          MAX_BRANCH_CHARS,
        );
      }
      const r = await this.d.ai.run(
        'propose-change',
        { scope, title: titleOf(d), request: req.request, diff },
        { fresh: true },
      );
      prompt = r.output.prompt.trim();
      generatedBy = r.generatedBy;
    }
    if (!req.send) {
      return { prompt, sent: false, sessionId: null, workspaceId: null, reason: null, generatedBy };
    }
    if (!ws || !this.d.sendToAgent) {
      return {
        prompt,
        sent: false,
        sessionId: null,
        workspaceId: ws,
        reason: ws
          ? 'Agent sessions are not available.'
          : 'No workspace on this Mac holds this repository.',
        generatedBy,
      };
    }
    const { sessionId } = await this.d.sendToAgent(ws, prompt);
    return { prompt, sent: true, sessionId, workspaceId: ws, reason: null, generatedBy };
  }
}
