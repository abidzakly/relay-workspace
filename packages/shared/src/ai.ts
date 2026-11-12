import { z } from 'zod';

/**
 * AI templates. Each template has ONE output schema, validated with zod whichever engine
 * produced it (Claude CLI headless on the Mac, or the Anthropic API fallback). Schemas stay structurally simple
 * (objects, strings, enums, arrays) so they also work as structured-output formats; ranges are checked after parsing.
 */

export const AI_TEMPLATES = [
  'triage',
  'quiz-cards',
  'explain-hunk',
  'grade-teachback',
  'request-change',
  'request-change-batch',
  'mr-summary',
  'mr-chat',
  'turn-summary',
  'base-suggest',
  'explain-thread',
] as const;
export const AiTemplateSchema = z.enum(AI_TEMPLATES);
export type AiTemplate = z.infer<typeof AiTemplateSchema>;

export const AI_ENGINES = ['claude_cli', 'anthropic_api', 'cursor_cli'] as const;
export type AiEngine = (typeof AI_ENGINES)[number];

/** Settings keys for the per-feature agent/model choice: `default` plus one per template. */
export const AI_MODEL_KEYS = ['default', ...AI_TEMPLATES] as const;
export type AiModelKey = (typeof AI_MODEL_KEYS)[number];
export const AiModelChoiceSchema = z.object({
  /** Preferred agent (tried first); unset = automatic (Claude, then Cursor). */
  engine: z.enum(AI_ENGINES).optional(),
  /** Model id for that agent; unset = built-in default. */
  model: z
    .string()
    .regex(/^[a-z0-9.-]{1,64}$/i)
    .optional(),
});
export type AiModelChoice = z.infer<typeof AiModelChoiceSchema>;
export const AiModelsSchema = z.partialRecord(z.enum(AI_MODEL_KEYS), AiModelChoiceSchema);
export type AiModels = z.infer<typeof AiModelsSchema>;

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export const AgentEffortSchema = z.enum(AGENT_EFFORTS);
export type AgentEffort = z.infer<typeof AgentEffortSchema>;

const AgentModelIdSchema = z.string().regex(/^[a-z0-9.-]{1,64}$/i);

/**
 * Models of interactive agent sessions. A Claude session plans on `planModel` and switches to `execModel` +
 * `execEffort` when the user approves the plan. Cursor keeps `cursorModel` (no approval channel to hook).
 */
export const AgentModelsSchema = z.object({
  planModel: AgentModelIdSchema.default('claude-opus-5-5'),
  execModel: AgentModelIdSchema.default('claude-sonnet-5-5'),
  execEffort: AgentEffortSchema.default('medium'),
  /** On Approve: `ask` offers the execution model next to "keep the plan model"; `auto` switches silently. */
  execSwitch: z.enum(['ask', 'auto']).default('ask'),
  cursorModel: AgentModelIdSchema.default('composer-2.5-fast'),
});
export type AgentModels = z.infer<typeof AgentModelsSchema>;

/** Models the session pickers offer, per interactive agent (a custom id can still be set in Settings). */
export const AGENT_MODEL_CHOICES = {
  claude: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
  cursor: [{ id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' }],
} as const;

/** Which agent and model produced an AI answer, shown next to the answer. */
export const AiGeneratedBySchema = z.object({ engine: z.enum(AI_ENGINES), model: z.string() });
export type AiGeneratedBy = z.infer<typeof AiGeneratedBySchema>;

const ENGINE_LABELS: Record<AiEngine, string> = {
  claude_cli: 'Claude Code',
  anthropic_api: 'Anthropic API',
  cursor_cli: 'Cursor',
};
const MODEL_LABELS: Readonly<Record<string, string>> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'composer-2.5-fast': 'Composer 2.5 Fast',
};

/** "Sonnet 5.5" for a known model id, else the id. */
export const agentModelLabel = (id: string): string => MODEL_LABELS[id] ?? id;

/** e.g. "Cursor · Composer 2.5 Fast". An unlisted model shows its id. */
export function aiGeneratedByLabel(by: AiGeneratedBy): string {
  return `${ENGINE_LABELS[by.engine]} · ${MODEL_LABELS[by.model] ?? by.model}`;
}

export const HUNK_TIERS = ['trivial', 'normal', 'critical'] as const;
export const HunkTierSchema = z.enum(HUNK_TIERS);
export type HunkTier = z.infer<typeof HunkTierSchema>;

export const TriageOutputSchema = z.object({
  hunks: z.array(
    z.object({
      id: z.string(),
      tier: HunkTierSchema,
      reason: z.string(),
      /** e.g. "import/format", "generated", "logic". */
      group: z.string(),
    }),
  ),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export const QUIZ_KINDS = ['predict', 'why', 'spot'] as const;
export const QuizCardSchema = z.object({
  hunkId: z.string(),
  file: z.string(),
  kind: z.enum(QUIZ_KINDS),
  question: z.string(),
  /** Empty = teach-back (free text answer graded by `grade-teachback`). */
  choices: z.array(z.string()),
  /** For multiple choice: the exact correct choice; for teach-back: the reference answer. */
  answer: z.string(),
  explanation: z.string(),
});
export type QuizCard = z.infer<typeof QuizCardSchema>;
export const QuizCardsOutputSchema = z.object({ cards: z.array(QuizCardSchema) });
export type QuizCardsOutput = z.infer<typeof QuizCardsOutputSchema>;

export const ExplainHunkOutputSchema = z.object({
  tldr: z.string(),
  detail: z.string(),
  risks: z.array(z.string()),
});
export type ExplainHunkOutput = z.infer<typeof ExplainHunkOutputSchema>;

export const GradeTeachbackOutputSchema = z.object({
  /** 0–3 (checked after parsing). */
  score: z.number().int(),
  missed: z.string(),
  correction: z.string(),
});
export type GradeTeachbackOutput = z.infer<typeof GradeTeachbackOutputSchema>;

export const RequestChangeOutputSchema = z.object({ prompt: z.string() });
export type RequestChangeOutput = z.infer<typeof RequestChangeOutputSchema>;

export const MrSummaryOutputSchema = z.object({
  summary: z.string(),
  bullets: z.array(z.string()),
  risks: z.array(z.string()),
});
export type MrSummaryOutput = z.infer<typeof MrSummaryOutputSchema>;
export const MrSummaryResultSchema = MrSummaryOutputSchema.extend({
  generatedBy: AiGeneratedBySchema,
});
export type MrSummaryResult = z.infer<typeof MrSummaryResultSchema>;

export const MrChatOutputSchema = z.object({ answer: z.string() });
export type MrChatOutput = z.infer<typeof MrChatOutputSchema>;
export const MrChatResultSchema = MrChatOutputSchema.extend({ generatedBy: AiGeneratedBySchema });
export type MrChatResult = z.infer<typeof MrChatResultSchema>;

export const TurnSummaryOutputSchema = z.object({
  headline: z.string(),
  files: z.array(z.string()),
});
export type TurnSummaryOutput = z.infer<typeof TurnSummaryOutputSchema>;

export const BaseSuggestOutputSchema = z.object({ base: z.string(), reason: z.string() });
export type BaseSuggestOutput = z.infer<typeof BaseSuggestOutputSchema>;
export const BaseSuggestResultSchema = BaseSuggestOutputSchema.extend({
  /** Null when there was only one candidate, so no AI ran. */
  generatedBy: AiGeneratedBySchema.nullable(),
});
export type BaseSuggestResult = z.infer<typeof BaseSuggestResultSchema>;

/** A reviewer's thread checked against what the MR changes: is the point valid, and what to tell the reviewer. */
export const ExplainThreadOutputSchema = z.object({
  verdict: z.enum(['valid', 'partly', 'addressed', 'mismatch', 'unclear']),
  summary: z.string(),
  whatChanged: z.string(),
  suggestedReply: z.string(),
});
export type ExplainThreadOutput = z.infer<typeof ExplainThreadOutputSchema>;
export const ExplainThreadResultSchema = ExplainThreadOutputSchema.extend({
  generatedBy: AiGeneratedBySchema,
});
export type ExplainThreadResult = z.infer<typeof ExplainThreadResultSchema>;

export const AI_OUTPUT_SCHEMAS = {
  triage: TriageOutputSchema,
  'quiz-cards': QuizCardsOutputSchema,
  'explain-hunk': ExplainHunkOutputSchema,
  'grade-teachback': GradeTeachbackOutputSchema,
  'request-change': RequestChangeOutputSchema,
  'request-change-batch': RequestChangeOutputSchema,
  'mr-summary': MrSummaryOutputSchema,
  'mr-chat': MrChatOutputSchema,
  'turn-summary': TurnSummaryOutputSchema,
  'base-suggest': BaseSuggestOutputSchema,
  'explain-thread': ExplainThreadOutputSchema,
} as const satisfies Record<AiTemplate, z.ZodType>;
export type AiOutput<T extends AiTemplate> = z.infer<(typeof AI_OUTPUT_SCHEMAS)[T]>;

/** Range checks the structured-output schemas leave out. Returns a reason, or null when fine. */
export function aiOutputProblem(template: AiTemplate, out: unknown): string | null {
  if (template === 'grade-teachback') {
    const s = (out as GradeTeachbackOutput).score;
    if (s < 0 || s > 3) return 'score must be 0–3';
  }
  if (template === 'mr-chat' && !(out as MrChatOutput).answer.trim()) return 'the answer is empty';
  if (template === 'quiz-cards') {
    for (const c of (out as QuizCardsOutput).cards) {
      if (c.choices.length > 0 && !c.choices.includes(c.answer))
        return 'answer is not one of the choices';
    }
  }
  return null;
}

export const AiEngineStatusSchema = z.object({
  /** Which engine answers now (`none` = AI features are off). */
  engine: z.enum(['claude_cli', 'anthropic_api', 'cursor_cli', 'none']),
  reason: z.string().nullable(),
});
export type AiEngineStatus = z.infer<typeof AiEngineStatusSchema>;
