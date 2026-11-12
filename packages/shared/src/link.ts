import { z } from 'zod';
import { EpochMsSchema, NotionIdSchema, RepoIdSchema } from './common';

/** How a card ↔ MR link was established. `manual` = linker dialog, user-confirmed. */
export const MATCH_BY = ['title', 'description', 'both', 'manual'] as const;
export const MatchBySchema = z.enum(MATCH_BY);
export type MatchBy = z.infer<typeof MatchBySchema>;

/**
 * Card ↔ MR link. Intentionally NOT unique per card or per MR: duplicates/mismatches
 * must be representable so they can be flagged (never auto-resolved). Unique per pair.
 */
export const LinkSchema = z.object({
  id: z.number().int().positive(),
  cardId: NotionIdSchema,
  repoId: RepoIdSchema,
  mrIid: z.number().int().positive(),
  matchBy: MatchBySchema,
  /** Set when this link participates in a mismatch / duplicate. */
  conflict: z.boolean(),
  createdAt: EpochMsSchema,
});
export type Link = z.infer<typeof LinkSchema>;

/**
 * Matcher outcome per (non-version) MR.
 *  strong           title key = description key = card A
 *  weak_title       only the title key hit            -> suggest "add link to MR description"
 *  weak_description only the description key hit      -> suggest "rename MR title to branch name"
 *  manual           a user-confirmed manual link decides (auto keys are ignored for this MR)
 *  mismatch         the keys point to different cards, or the title key is ambiguous (never auto-resolved)
 *  duplicate        2nd live MR for a card that already has one (never auto-resolved)
 *  orphan           neither key hit
 */
export const LINK_OUTCOMES = [
  'strong',
  'weak_title',
  'weak_description',
  'manual',
  'mismatch',
  'duplicate',
  'orphan',
] as const;
export const LinkOutcomeSchema = z.enum(LINK_OUTCOMES);
export type LinkOutcome = z.infer<typeof LinkOutcomeSchema>;

/** Why an MR is a `mismatch`. */
export const MISMATCH_REASONS = ['title_vs_description', 'ambiguous_title'] as const;
export type MismatchReason = (typeof MISMATCH_REASONS)[number];

/** Cosmetic fix hints for weak links. Applying one is always user-confirmed and audited (later part). */
export const LINK_SUGGESTIONS = ['add_description_link', 'rename_title_to_branch'] as const;
export type LinkSuggestion = (typeof LINK_SUGGESTIONS)[number];
