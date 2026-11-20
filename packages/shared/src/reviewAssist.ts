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
    /** Other changed files whose diffs the AI should see for this question. */
    mentions: z.array(z.string().min(1).max(1000)).max(8).default([]),
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
    scope: z.enum(['files', 'branch']),
    /** Required when `scope` is `files`. */
    files: z.array(z.string().min(1).max(1000)).max(20).default([]),
    /** What should change. May be empty when a conversation is attached: the AI takes it from there. */
    request: z.string().trim().max(8_000).default(''),
    /** The Explain discussion this change comes from (its conclusions shape the prompt). */
    conversation: z.array(MrChatMessageSchema).max(MR_CHAT_MAX_HISTORY).default([]),
    /** An already written (maybe edited) prompt: send it as is, without a new AI call. */
    prompt: z.string().trim().min(1).max(60_000).optional(),
    /** true = also send to the branch's agent session. */
    send: z.boolean().default(false),
  })
  .strict()
  .refine((r) => r.scope === 'branch' || r.files.length > 0, {
    message: 'pick at least one file',
    path: ['files'],
  })
  .refine((r) => Boolean(r.prompt || r.request || r.conversation.length), {
    message: 'say what should change, or start from an Explain chat',
    path: ['request'],
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
