import { z } from 'zod';
import { AiGeneratedBySchema, ExplainChangeOutputSchema } from './ai';
import { MR_CHAT_MAX_HISTORY, MrChatMessageSchema } from './mrCreate';
import { DeckSourceSchema } from './reviewDeck';

/**
 * Code Review assist: "Explain" (a chat about why a file changed) and "Propose changes" (an agent prompt for a file or
 * the whole branch) in the classic review. Only GitLab sources (MR or branch compare); the client holds the chat.
 */
export const ReviewAssistSourceSchema = z.discriminatedUnion('kind', [
  DeckSourceSchema.options[0],
  DeckSourceSchema.options[1],
]);
export type ReviewAssistSource = z.infer<typeof ReviewAssistSourceSchema>;

export const ReviewExplainRequestSchema = z
  .object({
    source: ReviewAssistSourceSchema,
    file: z.string().min(1).max(1000),
    history: z.array(MrChatMessageSchema).max(MR_CHAT_MAX_HISTORY),
    /** Absent on the first turn: "why did this file change?". */
    question: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export type ReviewExplainRequest = z.infer<typeof ReviewExplainRequestSchema>;

export const ReviewExplainResultSchema = ExplainChangeOutputSchema.extend({
  generatedBy: AiGeneratedBySchema,
});
export type ReviewExplainResult = z.infer<typeof ReviewExplainResultSchema>;

export const ReviewProposeRequestSchema = z
  .object({
    source: ReviewAssistSourceSchema,
    scope: z.enum(['file', 'branch']),
    /** Required when `scope` is `file`. */
    file: z.string().min(1).max(1000).optional(),
    request: z.string().trim().min(1).max(8_000),
    /** An already written (maybe edited) prompt: send it as is, without a new AI call. */
    prompt: z.string().trim().min(1).max(60_000).optional(),
    /** true = also send to the branch's agent session. */
    send: z.boolean().default(false),
  })
  .strict()
  .refine((r) => r.scope === 'branch' || Boolean(r.file), {
    message: 'file is required for a file-scoped proposal',
    path: ['file'],
  });
export type ReviewProposeRequest = z.infer<typeof ReviewProposeRequestSchema>;

export const ReviewProposeResultSchema = z.object({
  prompt: z.string(),
  sent: z.boolean(),
  sessionId: z.string().nullable(),
  /** The workspace the prompt went to (for the session link). */
  workspaceId: z.string().nullable(),
  reason: z.string().nullable(),
  /** Null when an existing prompt was sent without a new AI call. */
  generatedBy: AiGeneratedBySchema.nullable(),
});
export type ReviewProposeResult = z.infer<typeof ReviewProposeResultSchema>;
