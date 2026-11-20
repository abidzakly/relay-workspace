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
const MAX_MENTION_CHARS = 15_000;
const MAX_MENTIONS_CHARS = 40_000;
const MAX_MENTIONS = 8;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The other changed files a question is about: the ones picked with @, then any whose path or (unique) base name the
 * question names. The current file is not one of them. Pure.
 */
export function mentionedFiles(
  files: readonly DiffFile[],
  current: string,
  picked: readonly string[],
  question: string | undefined,
): DiffFile[] {
  const others = files.filter((f) => f.path !== current);
  const out = new Map<string, DiffFile>();
  for (const p of picked) {
    const f = others.find((x) => x.path === p);
    if (f) out.set(f.path, f);
  }
  if (question) {
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    const count = new Map<string, number>();
    for (const f of files) count.set(base(f.path), (count.get(base(f.path)) ?? 0) + 1);
    for (const f of others) {
      const names = count.get(base(f.path)) === 1 ? [f.path, base(f.path)] : [f.path];
      const hit = names.some((n) =>
        new RegExp(`(^|[^\\w./-])${escapeRe(n)}($|[^\\w/-])`).test(question),
      );
      if (hit) out.set(f.path, f);
    }
  }
  return [...out.values()].slice(0, MAX_MENTIONS);
}

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
    const mentioned = mentionedFiles(d.files, f.path, req.mentions, req.question).map(
      (m) => `### ${m.path}\n${clip(fileText(m), MAX_MENTION_CHARS)}`,
    );
    const { output, generatedBy } = await this.d.ai.run('explain-change-chat', {
      file: f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path,
      question: req.question?.trim() || '(tidak ada)',
      history: renderChatHistory(req.history),
      title: titleOf(d),
      commits,
      others: clip(others.join('\n'), 4_000) || '(tidak ada)',
      mentioned: mentioned.length
        ? clip(mentioned.join('\n\n'), MAX_MENTIONS_CHARS)
        : '(tidak ada)',
      diff: clip(fileText(f), MAX_FILE_CHARS),
    });
    return { ...output, generatedBy };
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
      if (req.scope === 'files') {
        const picked = [...new Set(req.files)].map((p) => this.file(d, p));
        scope =
          picked.length === 1
            ? `file ${picked[0]!.path}`
            : `${picked.length} files: ${picked.map((f) => f.path).join(', ')}`;
        diff = clip(
          picked.map((f) => `### ${f.path}\n${clip(fileText(f), MAX_FILE_CHARS)}`).join('\n\n'),
          MAX_BRANCH_CHARS,
        );
      } else {
        scope = `whole branch (${d.files.length} files)`;
        diff = clip(
          d.files.map((f) => `### ${f.path}\n${fileText(f)}`).join('\n\n'),
          MAX_BRANCH_CHARS,
        );
      }
      const r = await this.d.ai.run(
        'propose-change',
        {
          scope,
          title: titleOf(d),
          request: req.request || '(tidak ada: ambil dari diskusi)',
          conversation: req.conversation.length
            ? renderChatHistory(req.conversation)
            : '(tidak ada)',
          diff,
        },
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
