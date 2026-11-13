import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  AiGeneratedBySchema,
  DeckCardSchema,
  DeckStateSchema,
  deckCoverage,
  deckSourceKey,
  type AiGeneratedBy,
  type DeckCard,
  type DeckCardState,
  type DeckExplainRequest,
  type DeckExplainResult,
  type DeckGradeResult,
  type DeckHunk,
  type DeckNote,
  type DeckPayload,
  type DeckRequestChangeResult,
  type DeckReview,
  type DeckSource,
  type DeckState,
  type DeckStatePatch,
  type DeckStatus,
  type DeckSummary,
  type DiffFile,
  type HunkTier,
} from '@relay/shared';
import { z } from 'zod';
import type { AppDb } from '../../db';
import { reviewDecks } from '../../db/schema';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import type { AiService } from '../ai/aiService';
import { splitHunks, tierHunks, type SplitHunk } from './hunks';

/**
 * Review Deck service. Builds the card list once per diff SHA (AI triage + quiz when an
 * engine is available, heuristics otherwise), persists the user's progress, and answers the deck's AI actions.
 */

export class DeckError extends ActionError {
  constructor(status: number, code: string, message?: string) {
    super(status, code, message);
    this.name = 'DeckError';
  }
}

export interface DeckDiff {
  title: string;
  subtitle: string;
  files: DiffFile[];
  truncated: boolean;
  /** Newest commit of the diff, where it comes from a branch. */
  headSha?: string | null;
  /** Notion card context for quiz questions. */
  card: { title: string; status: string | null; url: string | null } | null;
  agentTarget: { workspaceId: string } | null;
}

export type DeckDiffReader = (source: DeckSource) => Promise<DeckDiff>;

/** Commits of `from...to` on a repo, newest first. `truncated` = the list is not complete. */
export type DeckCommitReader = (
  repoId: string,
  from: string,
  to: string,
) => Promise<{ commits: { id: string; message: string }[]; truncated: boolean }>;

/** Sends a prompt to the workspace's agent session. */
export type AgentSender = (workspaceId: string, prompt: string) => Promise<{ sessionId: string }>;

/**
 * Gets the deck's workspace ready for an agent: on an MR or compare deck that means the deck's branch. Null = no
 * workspace holds this repo. Throws when the branch cannot be switched (an agent is running on another one).
 */
export type AgentBranchPreparer = (source: DeckSource) => Promise<{ workspaceId: string } | null>;

export interface ReviewDeckDeps {
  store: AppDb;
  log: Logger;
  ai: AiService;
  readDiff: DeckDiffReader;
  readCommits?: DeckCommitReader;
  /** XP on completion (gamification `deckCompleted` / `issueFound`). Returns XP awarded. */
  award?: (deckId: string, diffSha: string, issueNoteIds: readonly string[]) => number;
  sendToAgent?: AgentSender;
  prepareAgentBranch?: AgentBranchPreparer;
  /** Branch a local deck's workspace is on, with its repo and HEAD. Null when unknown or not on a feature branch. */
  localBranch?: (
    workspaceId: string,
  ) => Promise<{ repoId: string; branch: string; head: string | null } | null>;
  /** Repo a workspace holds. */
  repoOfWorkspace?: (workspaceId: string) => string | null;
  /** The user finished a deck of a workspace (turn decks name their checkpoint in `base`). */
  onLocalReviewed?: (workspaceId: string, base?: string) => void;
  /** An open MR of a branch. */
  openMrOf?: (repoId: string, branch: string) => number | null;
  now?: () => number;
}

const MAX_QUIZ = 6;
const MAX_TRIAGE_CHARS = 120_000;
const BOSS_QUESTION =
  'Explain this change end to end: what is the input or trigger, what changes in each layer, and what is the effect on the user or the data?';

type SplitLike = Pick<DeckHunk, 'text'>;
const StoredCards = z.array(DeckCardSchema);
const AiInfo = z.object({
  engine: z.enum(['claude_cli', 'anthropic_api', 'cursor_cli', 'none']),
  triage: z.enum(['ai', 'heuristic']),
  quiz: z.enum(['ai', 'none']),
  note: z.string().nullable(),
  /** Absent on decks stored before this was recorded. */
  triageBy: AiGeneratedBySchema.nullable().default(null),
  quizBy: AiGeneratedBySchema.nullable().default(null),
});

const emptyState = (): DeckState => ({ cursor: 0, cards: {}, notes: [], completedAt: null });

export function diffShaOf(files: readonly DiffFile[]): string {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\0${f.diff ?? ''}\0`);
  return h.digest('hex');
}

export const deckIdOf = (source: DeckSource): string =>
  createHash('sha256').update(deckSourceKey(source)).digest('hex').slice(0, 24);

/** New-side line numbers of a hunk's lines, in order. Pure. */
export function hunkLines(
  h: Pick<DeckHunk, 'text'>,
): { no: number; kind: '+' | '-' | ' '; text: string }[] {
  const lines = h.text.split('\n');
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(lines[0] ?? '');
  let oldNo = Number(m?.[1] ?? 1);
  let newNo = Number(m?.[2] ?? 1);
  const out: { no: number; kind: '+' | '-' | ' '; text: string }[] = [];
  for (const l of lines.slice(1)) {
    const k = l[0];
    if (k === '+') out.push({ no: newNo++, kind: '+', text: l.slice(1) });
    else if (k === '-') out.push({ no: oldNo++, kind: '-', text: l.slice(1) });
    else if (k === ' ') {
      out.push({ no: newNo, kind: ' ', text: l.slice(1) });
      newNo++;
      oldNo++;
    }
  }
  return out;
}

/** Re-anchors notes after the diff changed: same file + same anchor text → new lines; else `stale`. Pure. */
export function reanchorNotes(notes: readonly DeckNote[], hunks: readonly DeckHunk[]): DeckNote[] {
  return notes.map((n) => {
    if (n.status === 'done') return n;
    if (n.anchorText) {
      for (const h of hunks) {
        if (h.file !== n.file) continue;
        const hit = hunkLines(h).find((l) => l.kind !== '-' && l.text === n.anchorText);
        if (hit) {
          const shift = hit.no - (n.lines[0] ?? hit.no);
          return {
            ...n,
            hunkId: h.id,
            lines: n.lines.map((x) => x + shift).filter((x) => x > 0),
            status: n.status === 'stale' ? 'saved' : n.status,
          };
        }
      }
    }
    // A sent note's lines are often gone because the fix removed them: that is not a reason to send it again.
    return n.status === 'sent' ? n : { ...n, status: 'stale' };
  });
}

const DECK_NOTE_TRAILER = /^Deck-Note:[ \t]*(\S+)[ \t]*$/gim;

/**
 * Splits new commits by their `Deck-Note` trailers (`deliveryInstructions`). A commit without a trailer of this deck
 * counts as unrelated, so an agent forgetting one costs a review card, never a skipped review. Pure.
 */
export function classifyNewCommits(
  commits: readonly { message: string }[],
  noteIds: ReadonlySet<string>,
): { review: 'current' | 'fix_only' | 'new_commits'; newCommits: number; fixedNoteIds: string[] } {
  const fixed = new Set<string>();
  let unrelated = 0;
  for (const c of commits) {
    const ids = [...c.message.matchAll(DECK_NOTE_TRAILER)]
      .map((m) => m[1]!)
      .filter((id) => noteIds.has(id));
    if (ids.length === 0) unrelated += 1;
    for (const id of ids) fixed.add(id);
  }
  return {
    review: commits.length === 0 ? 'current' : unrelated === 0 ? 'fix_only' : 'new_commits',
    newCommits: unrelated,
    fixedNoteIds: [...fixed],
  };
}

const withFixed = (notes: readonly DeckNote[], fixedNoteIds: readonly string[]): DeckNote[] =>
  notes.map((n) => (fixedNoteIds.includes(n.id) ? { ...n, status: 'done' as const } : n));

/** A hunk's identity across diffs: its file and lines. Not its id (a position) or header (line numbers shift). */
const hunkKey = (h: { file: string; text: string }): string =>
  `${h.file}\0${h.text.slice(h.text.indexOf('\n') + 1)}`;

/** New hunk id → the unchanged hunk it was on the previous deck. Pure. */
export function matchUnchangedHunks(
  prior: readonly DeckCard[],
  hunks: readonly SplitHunk[],
): Map<string, DeckHunk> {
  const byKey = new Map<string, DeckHunk[]>();
  for (const c of prior) {
    if (c.kind !== 'hunk') continue;
    const k = hunkKey(c.hunk);
    byKey.set(k, [...(byKey.get(k) ?? []), c.hunk]);
  }
  const out = new Map<string, DeckHunk>();
  for (const h of hunks) {
    const old = byKey.get(hunkKey(h))?.shift();
    if (old) out.set(h.id, old);
  }
  return out;
}

/** A bulk card holds no hunk text: it counts as unchanged when it lists the same files and hunk counts. */
const bulkShape = (c: Extract<DeckCard, { kind: 'bulk' }>): string =>
  c.files.map((f) => `${f.path}\0${f.hunkIds.length}`).join('\n');

/** Card order: bulk ack first, then hunks in file order, each critical hunk followed by its quiz, boss last. Pure. */
export function buildCards(
  hunks: readonly DeckHunk[],
  quiz: readonly z.infer<typeof DeckCardSchema>[] = [],
): DeckCard[] {
  const trivial = hunks.filter((h) => h.tier === 'trivial');
  const rest = hunks.filter((h) => h.tier !== 'trivial');
  const cards: DeckCard[] = [];
  if (trivial.length > 0) {
    const files = new Map<string, { path: string; group: string; hunkIds: string[] }>();
    for (const h of trivial) {
      const f = files.get(h.file) ?? { path: h.file, group: h.group, hunkIds: [] };
      f.hunkIds.push(h.id);
      files.set(h.file, f);
    }
    cards.push({
      kind: 'bulk',
      id: 'bulk',
      hunkIds: trivial.map((h) => h.id),
      files: [...files.values()],
    });
  }
  for (const h of rest) {
    cards.push({ kind: 'hunk', id: `h:${h.id}`, hunk: h });
    for (const q of quiz) if (q.kind === 'quiz' && q.quiz.hunkId === h.id) cards.push(q);
  }
  if (rest.length > 0) cards.push({ kind: 'boss', id: 'boss', question: BOSS_QUESTION });
  return cards;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (dipotong)` : s);

const MAX_BATCH_CHARS = 60_000;

const noteLines = (n: DeckNote) =>
  n.lines.length ? `${n.lines[0]}–${n.lines[n.lines.length - 1]}` : '-';

/** Added by the server, not the AI: the trailers are how a pushed commit is later matched to its notes. */
export function deliveryInstructions(noteIds: readonly string[]): string {
  return [
    'Wajib untuk setiap commit perubahan ini: akhiri pesan commit dengan trailer berikut, persis satu baris per ID:',
    ...noteIds.map((id) => `Deck-Note: ${id}`),
    '',
    'Setelah commit, push ke branch saat ini dengan `git push`, tanpa force.',
  ].join('\n');
}

export class ReviewDeckService {
  constructor(private readonly d: ReviewDeckDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private row(deckId: string) {
    return this.d.store.db.select().from(reviewDecks).where(eq(reviewDecks.deckId, deckId)).get();
  }

  private loaded(deckId: string) {
    const r = this.row(deckId);
    if (!r) throw new DeckError(404, 'deck_not_found', 'Deck not found: open it again.');
    const cards = StoredCards.parse(r.cards);
    const state = DeckStateSchema.parse(r.state);
    return { r, cards, state };
  }

  private async triage(hunks: SplitHunk[]): Promise<{
    tiers: Map<string, { tier: HunkTier; reason: string; group: string }>;
    by: AiGeneratedBy | null;
  }> {
    const open = tierHunks(hunks, null).filter((h) => h.tier !== 'trivial');
    if (open.length === 0) return { tiers: new Map(), by: null };
    const text = clip(
      open.map((h) => `### id=${h.id} file=${h.file}\n${h.text}`).join('\n\n'),
      MAX_TRIAGE_CHARS,
    );
    const { output, generatedBy } = await this.d.ai.run('triage', { hunks: text });
    return {
      tiers: new Map(
        output.hunks.map((x) => [x.id, { tier: x.tier, reason: x.reason, group: x.group }]),
      ),
      by: generatedBy,
    };
  }

  private async quiz(
    hunks: DeckHunk[],
    card: DeckDiff['card'],
  ): Promise<{ cards: DeckCard[]; by: AiGeneratedBy | null }> {
    // At most one question per file, critical hunks only, 3–6 per deck.
    const seen = new Set<string>();
    const pick: DeckHunk[] = [];
    for (const h of hunks) {
      if (h.tier !== 'critical' || seen.has(h.file)) continue;
      seen.add(h.file);
      pick.push(h);
      if (pick.length >= MAX_QUIZ) break;
    }
    if (pick.length === 0) return { cards: [], by: null };
    const { output, generatedBy } = await this.d.ai.run('quiz-cards', {
      card: card ? `${card.title} [${card.status ?? '-'}] ${card.url ?? ''}` : '(tidak ada card)',
      hunks: clip(
        pick.map((h) => `### id=${h.id} file=${h.file}\n${h.text}`).join('\n\n'),
        MAX_TRIAGE_CHARS,
      ),
    });
    const ids = new Set(pick.map((h) => h.id));
    const perFile = new Set<string>();
    const quizCards = output.cards
      .filter((q) => ids.has(q.hunkId) && !perFile.has(q.hunkId) && perFile.add(q.hunkId))
      .slice(0, MAX_QUIZ)
      .map((q, i) => ({ kind: 'quiz' as const, id: `q:${i}:${q.hunkId}`, quiz: q }));
    return { cards: quizCards, by: generatedBy };
  }

  /** Opens (or resumes) the deck of a source. Rebuilds cards only when the diff changed. */
  async open(source: DeckSource, opts: { rebuild?: boolean } = {}): Promise<DeckPayload> {
    const diff = await this.d.readDiff(source);
    const deckId = deckIdOf(source);
    const diffSha = diffShaOf(diff.files);
    // A manual rebuild ignores everything the stored deck knows.
    let prior = opts.rebuild ? undefined : this.row(deckId);
    let rebuilt: 'rewritten' | 'manual' | null = opts.rebuild ? 'manual' : null;
    let cards: DeckCard[];
    let ai: z.infer<typeof AiInfo>;
    let state: DeckState = prior ? DeckStateSchema.parse(prior.state) : emptyState();

    // A deck whose AI step failed (limit, engine down) is rebuilt on the next open, so it does not stay heuristic.
    const priorAiInfo = prior ? AiInfo.parse(prior.ai) : null;
    let degraded = !!priorAiInfo && priorAiInfo.triage === 'heuristic' && priorAiInfo.note !== null;

    if (prior && prior.diffSha === diffSha && !degraded) {
      cards = StoredCards.parse(prior.cards);
      ai = AiInfo.parse(prior.ai);
      const headSha = diff.headSha ?? null;
      if ((state.headSha ?? null) !== headSha)
        state = this.writeState(deckId, { ...state, headSha });
    } else {
      let assessed = prior ? await this.assess(prior, state, diff) : null;
      if (assessed?.rewritten) {
        // Force-push: old hunks, verdicts and notes belong to commits that are gone. Start from nothing.
        prior = undefined;
        assessed = null;
        state = emptyState();
        degraded = false;
        rebuilt = 'rewritten';
      }
      const fixOnly = assessed?.review === 'fix_only';
      const priorCards = prior ? StoredCards.parse(prior.cards) : [];
      const priorAi = prior ? AiInfo.parse(prior.ai) : null;
      const split = splitHunks(diff.files);
      const unchanged = matchUnchangedHunks(priorCards, split);
      // Verdicts follow `unchanged`; a degraded deck has no AI result to keep, so it re-triages every hunk.
      const changed = degraded ? split : split.filter((h) => !unchanged.has(h.id));
      const tiers = new Map(
        degraded
          ? []
          : [...unchanged].map(([id, h]) => [
              id,
              { tier: h.tier, reason: h.reason, group: h.group },
            ]),
      );
      // A fix of the deck's own notes is accepted without review, so it needs no AI either.
      const status = fixOnly ? null : await this.d.ai.status();
      let triaged = false;
      let triageBy: AiGeneratedBy | null = priorAi?.triageBy ?? null;
      let quizBy: AiGeneratedBy | null = priorAi?.quizBy ?? null;
      let note: string | null = status?.engine === 'none' ? status.reason : null;
      if (status && status.engine !== 'none') {
        try {
          const result = await this.triage(changed);
          for (const [id, t] of result.tiers) tiers.set(id, t);
          triaged = true;
          triageBy = result.by ?? triageBy;
        } catch (e) {
          note = `AI triage failed: ${(e as Error).message}`;
          this.d.log.warn({ deckId, err: (e as Error).message }, 'deck triage failed');
        }
      }
      const hunks = tierHunks(split, tiers);

      // Questions on unchanged hunks stay, under the hunk's new position.
      const newIdOf = new Map([...unchanged].map(([id, h]) => [h.id, id]));
      const priorCardIdOf = new Map<string, string>();
      let quiz: DeckCard[] = [];
      for (const c of priorCards) {
        const hunkId = c.kind === 'quiz' ? newIdOf.get(c.quiz.hunkId) : undefined;
        if (c.kind !== 'quiz' || !hunkId) continue;
        const id = `q:${quiz.length}:${hunkId}`;
        priorCardIdOf.set(id, c.id);
        quiz.push({ ...c, id, quiz: { ...c.quiz, hunkId } });
      }
      if (triaged) {
        try {
          const quizzed = await this.quiz(
            degraded ? hunks : hunks.filter((h) => !unchanged.has(h.id)),
            diff.card,
          );
          quiz = [...quiz, ...quizzed.cards];
          quizBy = quizzed.by ?? quizBy;
        } catch (e) {
          note = `AI quiz failed: ${(e as Error).message}`;
        }
      }
      const built = buildCards(hunks, quiz);
      ai = {
        engine: status?.engine ?? priorAi?.engine ?? 'none',
        triage: triaged || priorAi?.triage === 'ai' ? 'ai' : 'heuristic',
        quiz: quiz.length > 0 ? 'ai' : 'none',
        note,
        triageBy,
        quizBy: quiz.length > 0 ? quizBy : null,
      };

      // Verdicts stay on code that did not change.
      const verdicts: Record<string, DeckCardState> = {};
      const priorBulk = priorCards.find((c) => c.kind === 'bulk');
      const reviewNeeded = changed.some(
        (h) => hunks.find((x) => x.id === h.id)?.tier !== 'trivial',
      );
      for (const c of built) {
        const priorId =
          c.kind === 'hunk'
            ? unchanged.has(c.hunk.id) && `h:${unchanged.get(c.hunk.id)!.id}`
            : c.kind === 'quiz'
              ? priorCardIdOf.get(c.id)
              : c.kind === 'bulk'
                ? priorBulk?.kind === 'bulk' && bulkShape(priorBulk) === bulkShape(c) && 'bulk'
                : !reviewNeeded && 'boss';
        const kept = priorId ? state.cards[priorId] : undefined;
        if (kept) verdicts[c.id] = kept;
        else if (fixOnly && c.kind !== 'quiz') {
          verdicts[c.id] = { verdict: 'fix', score: null, at: this.now() };
        }
      }
      // Reviewed cards first: the deck then resumes on exactly what is still to review.
      cards = [...built.filter((c) => verdicts[c.id]), ...built.filter((c) => !verdicts[c.id])];
      state = {
        cursor: built.filter((c) => verdicts[c.id]).length,
        cards: verdicts,
        notes: withFixed(reanchorNotes(state.notes, hunks), assessed?.fixedNoteIds ?? []),
        completedAt: fixOnly ? state.completedAt : null,
        headSha: diff.headSha ?? null,
      };
      const values = {
        deckId,
        sourceKey: deckSourceKey(source),
        source,
        title: diff.title,
        subtitle: diff.subtitle,
        diffSha,
        cards,
        ai,
        state,
        updatedAt: this.now(),
      };
      this.d.store.db
        .insert(reviewDecks)
        .values(values)
        .onConflictDoUpdate({ target: reviewDecks.deckId, set: values })
        .run();
    }
    return {
      deckId,
      source,
      title: diff.title,
      subtitle: diff.subtitle,
      diffSha,
      files: diff.files,
      cards,
      state,
      ai,
      truncated: diff.truncated,
      agentTarget: diff.agentTarget,
      rebuilt,
    };
  }

  /**
   * Client progress (client-authoritative for its own deck). Notes keep server-side `sent` status. A client passes the
   * diff it was shown: card ids are positions, so a tab left open across a rebuild would mark other hunks as reviewed.
   */
  saveState(deckId: string, patch: DeckStatePatch, shownDiffSha?: string): DeckState {
    const { r, state } = this.loaded(deckId);
    if (shownDiffSha !== undefined && shownDiffSha !== r.diffSha) {
      throw new DeckError(409, 'deck_diff_changed', 'The diff changed: load the new deck.');
    }
    // A client's copy of a note can predate the send, so it never takes back what the server recorded.
    const recorded = new Map(state.notes.map((n) => [n.id, n.status] as const));
    const notes = patch.notes?.map((n) => {
      const status = recorded.get(n.id);
      return status === 'sent' || status === 'done' ? { ...n, status } : n;
    });
    return this.writeState(
      r.deckId,
      DeckStateSchema.parse({ ...state, ...patch, ...(notes ? { notes } : {}) }),
    );
  }

  private writeState(deckId: string, next: DeckState): DeckState {
    this.d.store.db
      .update(reviewDecks)
      .set({ state: next, updatedAt: this.now() })
      .where(eq(reviewDecks.deckId, deckId))
      .run();
    return next;
  }

  private hunk(cards: readonly DeckCard[], hunkId: string): DeckHunk {
    for (const c of cards) if (c.kind === 'hunk' && c.hunk.id === hunkId) return c.hunk;
    throw new DeckError(404, 'hunk_not_found', 'This hunk is not in the deck.');
  }

  /** "Explain with AI": one hunk, a whole file's changes, or the lines the user marked in a file. */
  async explain(deckId: string, req: DeckExplainRequest): Promise<DeckExplainResult> {
    if (req.scope === 'hunk') return this.explainHunk(deckId, req.hunkId, req.question);
    const { cards } = this.loaded(deckId);
    const hunks = cards.flatMap((c) =>
      c.kind === 'hunk' && c.hunk.file === req.file ? [c.hunk] : [],
    );
    if (hunks.length === 0) {
      throw new DeckError(404, 'file_not_found', 'This file has no hunks in the deck.');
    }
    let label: string;
    let body: string;
    let context = '(hanya perubahan ini)';
    if (req.scope === 'file') {
      label = `${req.file} (seluruh perubahan file)`;
      body = clip(hunks.map((h) => h.text).join('\n'), MAX_TRIAGE_CHARS / 4);
    } else {
      const wanted = new Set(req.lines);
      const picked: string[] = [];
      const owners: SplitLike[] = [];
      for (const h of hunks) {
        const hit = hunkLines(h).filter((l) => l.kind !== '-' && wanted.has(l.no));
        if (hit.length === 0) continue;
        owners.push(h);
        picked.push(...hit.map((l) => `${l.no}${l.kind === '+' ? ' +' : '  '} ${l.text}`));
      }
      if (picked.length === 0) {
        throw new DeckError(422, 'lines_not_found', 'None of the selected lines are in the diff.');
      }
      label = `${req.file} (baris terpilih)`;
      body = clip(picked.join('\n'), 12_000);
      context = clip(owners.map((h) => h.text).join('\n'), 6000);
    }
    const { output, cached, generatedBy } = await this.d.ai.run('explain-hunk', {
      file: label,
      question: req.question?.trim() || '(tidak ada)',
      hunk: body,
      context,
    });
    return { ...output, cached, generatedBy };
  }

  private async explainHunk(
    deckId: string,
    hunkId: string,
    question?: string,
  ): Promise<DeckExplainResult> {
    const { cards } = this.loaded(deckId);
    const h = this.hunk(cards, hunkId);
    const neighbours = cards
      .filter(
        (c): c is Extract<DeckCard, { kind: 'hunk' }> =>
          c.kind === 'hunk' && c.hunk.file === h.file && c.hunk.id !== h.id,
      )
      .map((c) => c.hunk.text)
      .join('\n');
    const { output, cached, generatedBy } = await this.d.ai.run('explain-hunk', {
      file: h.file,
      question: question?.trim() || '(tidak ada)',
      hunk: h.text,
      context: clip(neighbours, 6000) || '(hanya hunk ini)',
    });
    return { ...output, cached, generatedBy };
  }

  async grade(deckId: string, cardId: string, answer: string): Promise<DeckGradeResult> {
    const { cards } = this.loaded(deckId);
    const card = cards.find((c) => c.id === cardId);
    if (!card || (card.kind !== 'quiz' && card.kind !== 'boss')) {
      throw new DeckError(404, 'card_not_found', 'Only quiz and boss cards are graded.');
    }
    const vars =
      card.kind === 'quiz'
        ? {
            question: card.quiz.question,
            reference: card.quiz.answer,
            answer,
            hunk: this.hunk(cards, card.quiz.hunkId).text,
          }
        : {
            question: card.question,
            reference: '(tidak ada jawaban acuan: nilai dari diff)',
            answer,
            hunk: clip(
              cards
                .filter((c): c is Extract<DeckCard, { kind: 'hunk' }> => c.kind === 'hunk')
                .map((c) => `### ${c.hunk.file}\n${c.hunk.text}`)
                .join('\n\n'),
              // Grading needs the gist of the MR, not every line: a smaller prompt answers sooner.
              30_000,
            ),
          };
    const { output, generatedBy } = await this.d.ai.run('grade-teachback', vars, { fresh: true });
    return { ...output, generatedBy };
  }

  private async requestPrompt(cards: readonly DeckCard[], notes: readonly DeckNote[]) {
    const hunkText = (n: DeckNote) => {
      const c = cards.find((x) => x.kind === 'hunk' && x.hunk.id === n.hunkId);
      return c && c.kind === 'hunk' ? c.hunk.text : '(hunk tidak ditemukan)';
    };
    const [only] = notes;
    if (only && notes.length === 1) {
      return this.d.ai.run('request-change', {
        file: only.file,
        lines: noteLines(only),
        notes: only.text,
        hunk: hunkText(only),
      });
    }
    return this.d.ai.run('request-change-batch', {
      items: clip(
        notes
          .map(
            (n, i) =>
              `### Catatan ${i + 1}\nFile: ${n.file}  Baris: ${noteLines(n)}\nCatatan:\n${n.text}\nHunk:\n${hunkText(n)}`,
          )
          .join('\n\n'),
        MAX_BATCH_CHARS,
      ),
    });
  }

  /** The workspace a send goes to, on the deck's branch. */
  private async agentWorkspace(source: DeckSource): Promise<string | null> {
    if (this.d.prepareAgentBranch) {
      return (await this.d.prepareAgentBranch(source))?.workspaceId ?? null;
    }
    return source.kind === 'local' ? source.workspaceId : null;
  }

  async requestChange(
    deckId: string,
    noteIds: readonly string[],
    send: boolean,
  ): Promise<DeckRequestChangeResult> {
    const { r, cards, state } = this.loaded(deckId);
    const wanted = state.notes.filter((n) => noteIds.includes(n.id));
    if (wanted.length === 0) throw new DeckError(404, 'note_not_found', 'Note not found.');
    const notes = wanted.filter((n) => n.status === 'saved' || n.status === 'stale');
    if (notes.length === 0) {
      throw new DeckError(409, 'note_already_sent', 'These notes were already sent to the agent.');
    }
    // Before the AI call: a refused branch switch should not cost one.
    const ws = send ? await this.agentWorkspace(r.source as DeckSource) : null;
    const { output, generatedBy } = await this.requestPrompt(cards, notes);
    const ids = notes.map((n) => n.id);
    const prompt = `${output.prompt}\n\n${deliveryInstructions(ids)}`;
    if (!send) return { prompt, sent: false, sessionId: null, reason: null, generatedBy };
    if (!ws || !this.d.sendToAgent) {
      return {
        prompt,
        sent: false,
        sessionId: null,
        reason: ws ? 'Agent sessions are not available.' : 'No workspace is linked to this deck.',
        generatedBy,
      };
    }
    const { sessionId } = await this.d.sendToAgent(ws, prompt);
    // Read again: the deck may have been saved during the slow calls above.
    const latest = this.loaded(deckId).state;
    this.writeState(deckId, {
      ...latest,
      notes: latest.notes.map((n) => (ids.includes(n.id) ? { ...n, status: 'sent' as const } : n)),
    });
    return { prompt, sent: true, sessionId, reason: null, generatedBy };
  }

  /** The commits a push added on top of what the deck covers. Null when they cannot be told apart. */
  private async commitsSince(
    source: DeckSource,
    state: DeckState,
    headSha: string | null | undefined,
  ): Promise<{ message: string }[] | 'rewritten' | null> {
    if (source.kind === 'local' || !this.d.readCommits || !state.headSha || !headSha) return null;
    try {
      // Commits only the deck's old head has: a push on top leaves none, a force-push leaves the replaced ones.
      if (state.headSha !== headSha) {
        const back = await this.d
          .readCommits(source.repoId, headSha, state.headSha)
          .catch(() => null);
        if (back && back.commits.length > 0) return 'rewritten';
      }
      const r = await this.d.readCommits(source.repoId, state.headSha, headSha);
      return r.truncated ? null : r.commits;
    } catch (e) {
      this.d.log.debug({ err: (e as Error).message }, 'deck commit read failed');
      return null;
    }
  }

  /** What the branch as it is now means for a deck's review. */
  private async assess(
    r: NonNullable<ReturnType<ReviewDeckService['row']>>,
    state: DeckState,
    diff: Pick<DeckDiff, 'files' | 'headSha'>,
  ): Promise<{
    review: DeckReview;
    newCommits: number | null;
    fixedNoteIds: string[];
    /** The branch no longer contains the commit the deck covered (force-push). */
    rewritten?: true;
  }> {
    if (diffShaOf(diff.files) === r.diffSha) {
      return {
        review: state.completedAt === null ? 'incomplete' : 'current',
        newCommits: 0,
        fixedNoteIds: [],
      };
    }
    const commits = await this.commitsSince(r.source as DeckSource, state, diff.headSha);
    if (commits === 'rewritten') {
      return {
        review: state.completedAt === null ? 'incomplete' : 'new_commits',
        newCommits: null,
        fixedNoteIds: [],
        rewritten: true,
      };
    }
    const found = commits && classifyNewCommits(commits, new Set(state.notes.map((n) => n.id)));
    // The diff moved without a commit to explain it (a rewritten branch): only a review can tell what changed.
    const result =
      found && found.review !== 'current'
        ? found
        : { review: 'new_commits' as const, newCommits: null, fixedNoteIds: [] };
    return state.completedAt === null ? { ...result, review: 'incomplete' } : result;
  }

  /** Records notes a pushed commit fixed. */
  private markFixed(deckId: string, state: DeckState, fixedNoteIds: readonly string[]): DeckNote[] {
    const open = state.notes.some((n) => fixedNoteIds.includes(n.id) && n.status !== 'done');
    return open
      ? this.writeState(deckId, { ...state, notes: withFixed(state.notes, fixedNoteIds) }).notes
      : state.notes;
  }

  /** Where a deck stands against its branch, and where the work goes next. */
  async status(deckId: string): Promise<DeckStatus> {
    const { r, state } = this.loaded(deckId);
    const source = r.source as DeckSource;
    if (source.kind === 'local') {
      const lb = await this.d.localBranch?.(source.workspaceId).catch(() => null);
      const iid = lb ? (this.d.openMrOf?.(lb.repoId, lb.branch) ?? null) : null;
      return {
        review: state.completedAt === null ? 'incomplete' : 'current',
        newCommits: 0,
        diffSha: r.diffSha,
        notes: state.notes,
        next: !lb
          ? null
          : iid
            ? { kind: 'open_mr', repoId: lb.repoId, iid }
            : { kind: 'create_mr', repoId: lb.repoId, branch: lb.branch },
      };
    }
    const diff = await this.d.readDiff(source);
    const a = await this.assess(r, state, diff);
    return {
      review: a.review,
      newCommits: a.newCommits,
      diffSha: diffShaOf(diff.files),
      notes: this.markFixed(deckId, state, a.fixedNoteIds),
      next:
        source.kind === 'mr'
          ? { kind: 'open_mr', repoId: source.repoId, iid: source.iid }
          : { kind: 'create_mr', repoId: source.repoId, branch: source.to },
    };
  }

  /** A finished local deck (Cockpit chat review) of this repo that covered exactly this branch head. */
  private reviewedLocally(source: DeckSource, headSha: string | null | undefined): boolean {
    if (!headSha || source.kind === 'local' || !this.d.repoOfWorkspace) return false;
    for (const row of this.d.store.db.select().from(reviewDecks).all()) {
      const s = row.source as DeckSource;
      if (s.kind !== 'local' || this.d.repoOfWorkspace(s.workspaceId) !== source.repoId) continue;
      const st = DeckStateSchema.safeParse(row.state);
      if (st.success && st.data.completedAt !== null && st.data.headSha === headSha) return true;
    }
    return false;
  }

  /** The Create MR gate: does a finished deck cover this diff, and if not, did commits overtake one? */
  async branchReview(
    source: DeckSource,
    diff: Pick<DeckDiff, 'files' | 'headSha'>,
  ): Promise<{ reviewed: boolean; stale: boolean }> {
    const deckId = deckIdOf(source);
    const r = this.row(deckId);
    if (!r) return { reviewed: this.reviewedLocally(source, diff.headSha), stale: false };
    const state = DeckStateSchema.parse(r.state);
    const a = await this.assess(r, state, diff);
    this.markFixed(deckId, state, a.fixedNoteIds);
    const reviewed = a.review === 'current' || a.review === 'fix_only';
    if (!reviewed && this.reviewedLocally(source, diff.headSha))
      return { reviewed: true, stale: false };
    return { reviewed, stale: a.review === 'new_commits' };
  }

  /** Finishes a deck at 100% coverage: XP once per (deck, diff), summary for the end screen. */
  complete(deckId: string): DeckSummary {
    const { r, cards, state } = this.loaded(deckId);
    const coverage = deckCoverage(cards, state);
    if (coverage < 1) {
      throw new DeckError(
        409,
        'deck_incomplete',
        'Every hunk must be touched before the deck is done.',
      );
    }
    const verdicts = Object.values(state.cards);
    const issues = state.notes.filter((n) => n.status !== 'done');
    let xp = 0;
    if (!state.completedAt) {
      xp =
        this.d.award?.(
          deckId,
          r.diffSha,
          issues.map((n) => n.id),
        ) ?? 0;
      const source = r.source as DeckSource;
      this.saveState(deckId, { completedAt: this.now() });
      if (source.kind === 'local') {
        // The branch head this review covered: Create MR matches it against the pushed head.
        void this.d.localBranch?.(source.workspaceId).then(
          (lb) => {
            const cur = this.row(deckId);
            if (!lb?.head || !cur) return;
            this.saveState(deckId, { headSha: lb.head });
          },
          () => undefined,
        );
        this.d.onLocalReviewed?.(
          source.workspaceId,
          source.mode === 'turn' ? source.base : undefined,
        );
      }
    }
    return {
      understood: verdicts.filter((v) => v.verdict === 'understood').length,
      explained: verdicts.filter((v) => v.verdict === 'explained').length,
      issues: issues.length,
      coverage,
      xpAwarded: xp,
      notes: state.notes,
    };
  }
}
