import { z } from 'zod';
import { BranchNameSchema, EpochMsSchema, RepoIdSchema } from './common';
import { AiGeneratedBySchema, HunkTierSchema, QuizCardSchema, ExplainHunkOutputSchema } from './ai';
import { DiffFileSchema } from './review';

/**
 * Review Deck: swipe-to-understand review. One card = one hunk; trivial hunks are folded
 * into one "Bulk ack" card; a few critical hunks get a quiz / teach-back card; a boss card closes the deck.
 * State is saved on the server (resume) and tied to the diff SHA (notes go "stale" when the diff changes).
 */

export const DECK_SOURCE_KINDS = ['mr', 'compare', 'local'] as const;
export const DeckSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mr'), repoId: RepoIdSchema, iid: z.number().int().positive() }),
  z.object({
    kind: z.literal('compare'),
    repoId: RepoIdSchema,
    from: BranchNameSchema,
    to: BranchNameSchema,
  }),
  z.object({
    kind: z.literal('local'),
    workspaceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    mode: z.enum(['working', 'branch', 'turn']),
    /** `branch` mode: base branch (default: the workspace's). `turn`: the checkpoint number. */
    base: z.string().max(200).optional(),
  }),
]);
export type DeckSource = z.infer<typeof DeckSourceSchema>;

/** Stable text key of a source (the deck id is derived from it). */
export function deckSourceKey(s: DeckSource): string {
  if (s.kind === 'mr') return `mr:${s.repoId}:${s.iid}`;
  if (s.kind === 'compare') return `compare:${s.repoId}:${s.from}...${s.to}`;
  return `local:${s.workspaceId}:${s.mode}:${s.base ?? ''}`;
}

export const DeckHunkSchema = z.object({
  /** `<fileIndex>:<hunkIndex>`. */
  id: z.string(),
  file: z.string(),
  fileIndex: z.number().int().nonnegative(),
  hunkIndex: z.number().int().nonnegative(),
  /** The `@@ … @@` header line. */
  header: z.string(),
  /** Unified diff text of this hunk (header included). */
  text: z.string(),
  adds: z.number().int().nonnegative(),
  dels: z.number().int().nonnegative(),
  tier: HunkTierSchema,
  reason: z.string(),
  group: z.string(),
});
export type DeckHunk = z.infer<typeof DeckHunkSchema>;

export const DeckCardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bulk'),
    id: z.literal('bulk'),
    hunkIds: z.array(z.string()),
    files: z.array(z.object({ path: z.string(), group: z.string(), hunkIds: z.array(z.string()) })),
  }),
  z.object({ kind: z.literal('hunk'), id: z.string(), hunk: DeckHunkSchema }),
  z.object({ kind: z.literal('quiz'), id: z.string(), quiz: QuizCardSchema }),
  z.object({ kind: z.literal('boss'), id: z.literal('boss'), question: z.string() }),
]);
export type DeckCard = z.infer<typeof DeckCardSchema>;

/** `fix` = accepted without a card: the hunk came from an agent fix of this deck's own notes. */
export const CARD_VERDICTS = ['understood', 'explained', 'issue', 'answered', 'fix'] as const;
export const CardVerdictSchema = z.enum(CARD_VERDICTS);
export type CardVerdict = z.infer<typeof CardVerdictSchema>;

export const DeckNoteSchema = z.object({
  id: z.string().min(1).max(64),
  file: z.string(),
  hunkId: z.string(),
  /** New-side line numbers (old side when only deletions). */
  lines: z.array(z.number().int().positive()).max(500),
  text: z.string().min(1).max(4000),
  /** `saved` = for later; `sent` = sent to the agent; `stale` = the diff changed since. */
  status: z.enum(['saved', 'sent', 'stale', 'done']),
  /** The line text at the first marked line, used to re-anchor when the diff changes. */
  anchorText: z.string().max(500).nullable(),
  createdAt: EpochMsSchema,
});
export type DeckNote = z.infer<typeof DeckNoteSchema>;

export const DeckCardStateSchema = z.object({
  verdict: CardVerdictSchema,
  /** Teach-back / boss score 0–3, multiple choice: 3 = right, 0 = wrong. */
  score: z.number().int().min(0).max(3).nullable(),
  at: EpochMsSchema,
});
export type DeckCardState = z.infer<typeof DeckCardStateSchema>;

export const DeckStateSchema = z.object({
  cursor: z.number().int().nonnegative(),
  cards: z.record(z.string(), DeckCardStateSchema),
  notes: z.array(DeckNoteSchema).max(200),
  completedAt: EpochMsSchema.nullable(),
  /**
   * The branch head this deck's cards cover: commits after it are what a push added. Absent on older decks and on local
   * ones. Optional rather than defaulted: `DeckStatePatchSchema` would fill a default into every partial save.
   */
  headSha: z.string().nullable().optional(),
});
export type DeckState = z.infer<typeof DeckStateSchema>;

export const DeckPayloadSchema = z.object({
  deckId: z.string(),
  source: DeckSourceSchema,
  title: z.string(),
  subtitle: z.string(),
  diffSha: z.string(),
  files: z.array(DiffFileSchema),
  cards: z.array(DeckCardSchema),
  state: DeckStateSchema,
  /** How triage / quiz were produced. */
  ai: z.object({
    engine: z.enum(['claude_cli', 'anthropic_api', 'cursor_cli', 'none']),
    triage: z.enum(['ai', 'heuristic']),
    quiz: z.enum(['ai', 'none']),
    /** Null when no AI ran, or on a deck built before this was recorded. */
    triageBy: AiGeneratedBySchema.nullable(),
    quizBy: AiGeneratedBySchema.nullable(),
    note: z.string().nullable(),
  }),
  truncated: z.boolean(),
  /** Workspace / repo the "send to agent" action targets (null = none known). */
  agentTarget: z.object({ workspaceId: z.string() }).nullable(),
  /** Why this open threw the old deck away: the branch history was rewritten (force-push) or the user asked. */
  rebuilt: z.enum(['rewritten', 'manual']).nullable().default(null),
});
export type DeckPayload = z.infer<typeof DeckPayloadSchema>;

export const DeckOpenRequestSchema = z.object({
  source: DeckSourceSchema,
  /** Throw away cards, progress and notes and build the deck again. */
  rebuild: z.boolean().default(false),
});
export const DeckStatePatchSchema = DeckStateSchema.partial().strict();
export type DeckStatePatch = z.infer<typeof DeckStatePatchSchema>;
/** A client's save names the diff it was shown: a verdict means nothing on a deck rebuilt from another diff. */
export const DeckStateSaveRequestSchema = z.strictObject({
  ...DeckStatePatchSchema.shape,
  diffSha: z.string().min(1).max(64),
});
const ExplainQuestion = z.string().max(2000).optional();
/** What to explain: a hunk card, every change of a file, or the lines marked in a file (new-side line numbers). */
export const DeckExplainRequestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('hunk'), hunkId: z.string().max(40), question: ExplainQuestion }),
  z.object({
    scope: z.literal('file'),
    file: z.string().min(1).max(1000),
    question: ExplainQuestion,
  }),
  z.object({
    scope: z.literal('selection'),
    file: z.string().min(1).max(1000),
    lines: z.array(z.int().positive()).min(1).max(500),
    question: ExplainQuestion,
  }),
]);
export type DeckExplainRequest = z.infer<typeof DeckExplainRequestSchema>;
export const DeckExplainResultSchema = ExplainHunkOutputSchema.extend({
  cached: z.boolean(),
  generatedBy: AiGeneratedBySchema,
});
export type DeckExplainResult = z.infer<typeof DeckExplainResultSchema>;
export const DeckGradeRequestSchema = z.object({
  cardId: z.string().max(40),
  answer: z.string().min(1).max(4000),
});
export const DeckGradeResultSchema = z.object({
  score: z.number().int().min(0).max(3),
  missed: z.string(),
  correction: z.string(),
  generatedBy: AiGeneratedBySchema,
});
export type DeckGradeResult = z.infer<typeof DeckGradeResultSchema>;
export const DeckRequestChangeRequestSchema = z.object({
  /** One note, or several for a single combined prompt. */
  noteIds: z.array(z.string().max(64)).min(1).max(200),
  /** true = also send to the workspace's agent session. */
  send: z.boolean().default(false),
});
export const DeckRequestChangeResultSchema = z.object({
  prompt: z.string(),
  sent: z.boolean(),
  sessionId: z.string().nullable(),
  reason: z.string().nullable(),
  generatedBy: AiGeneratedBySchema,
});
export type DeckRequestChangeResult = z.infer<typeof DeckRequestChangeResultSchema>;

/**
 * What the branch's commits since the deck mean for its review. `incomplete` = not finished; `current` = nothing new;
 * `fix_only` = every new commit fixes a note of this deck, so the review stands; `new_commits` = others need a review.
 */
export const DeckReviewSchema = z.enum(['incomplete', 'current', 'fix_only', 'new_commits']);
export type DeckReview = z.infer<typeof DeckReviewSchema>;

export const DeckStatusSchema = z.object({
  review: DeckReviewSchema,
  /** Commits that need a review; null when they could not be read. */
  newCommits: z.number().int().nonnegative().nullable(),
  /** The diff on the branch now: differs from the payload's once a push has changed it. */
  diffSha: z.string(),
  notes: z.array(DeckNoteSchema),
  /** Where the work goes after the deck. */
  next: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('create_mr'), repoId: z.string(), branch: z.string() }),
      z.object({
        kind: z.literal('open_mr'),
        repoId: z.string(),
        iid: z.number().int().positive(),
      }),
    ])
    .nullable(),
});
export type DeckStatus = z.infer<typeof DeckStatusSchema>;

export const DeckSummarySchema = z.object({
  understood: z.number().int().nonnegative(),
  explained: z.number().int().nonnegative(),
  issues: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  xpAwarded: z.number().int().nonnegative(),
  notes: z.array(DeckNoteSchema),
});
export type DeckSummary = z.infer<typeof DeckSummarySchema>;

// ───────────────────────────── pure helpers ─────────────────────────────

/** Hunks covered by the state: a hunk card, or a bulk card's hunks, with any verdict. */
export function coveredHunks(
  cards: readonly DeckCard[],
  state: Pick<DeckState, 'cards'>,
): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    if (!state.cards[c.id]) continue;
    if (c.kind === 'hunk') out.add(c.hunk.id);
    if (c.kind === 'bulk') for (const h of c.hunkIds) out.add(h);
  }
  return out;
}

/** 0–1 share of hunks touched. A deck is done only at 1 (no XP for speed). */
export function deckCoverage(cards: readonly DeckCard[], state: Pick<DeckState, 'cards'>): number {
  let total = 0;
  for (const c of cards) total += c.kind === 'hunk' ? 1 : c.kind === 'bulk' ? c.hunkIds.length : 0;
  if (total === 0) return 1;
  return coveredHunks(cards, state).size / total;
}

/** Per-file coverage for the ring legend. */
export function fileCoverage(
  cards: readonly DeckCard[],
  state: Pick<DeckState, 'cards'>,
): { path: string; done: number; total: number }[] {
  const covered = coveredHunks(cards, state);
  const by = new Map<string, { path: string; done: number; total: number }>();
  const add = (path: string, id: string) => {
    const e = by.get(path) ?? { path, done: 0, total: 0 };
    e.total += 1;
    if (covered.has(id)) e.done += 1;
    by.set(path, e);
  };
  for (const c of cards) {
    if (c.kind === 'hunk') add(c.hunk.file, c.hunk.id);
  }
  for (const c of cards) {
    if (c.kind === 'bulk') for (const f of c.files) for (const id of f.hunkIds) add(f.path, id);
  }
  return [...by.values()];
}
