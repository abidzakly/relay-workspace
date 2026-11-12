import { z } from 'zod';
import { NotionIdSchema, RepoIdSchema } from './common';
import { MrDerivedStateSchema } from './mr';
import type { Card } from './card';
import type { Mr } from './mr';

/**
 * Severity ↔ icons:
 *  ok = ✅, info = 💡, warn = ⚠️, action = 🟠 (awaiting release/build), critical = 🔴
 */
export const SEVERITIES = ['ok', 'info', 'warn', 'action', 'critical'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * One-click fixes suggested by a rule. A Fix is only a *suggestion*; applying it is always
 * user-confirmed, audited and undoable (never automatic).
 */
export const FixSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_card_status'),
    cardId: NotionIdSchema,
    to: z.string().min(1),
  }),
  z.object({ type: z.literal('start_release'), repoId: RepoIdSchema }),
  z.object({ type: z.literal('build_and_share'), repoId: RepoIdSchema }),
  /** Opens the linker dialog (link / create MR, resolve mismatch or duplicate). */
  z.object({
    type: z.literal('open_linker'),
    cardId: NotionIdSchema.nullable(),
    repoId: RepoIdSchema.nullable(),
    mrIid: z.number().int().positive().nullable(),
  }),
  z.object({ type: z.literal('set_parent'), cardId: NotionIdSchema }),
  /** "link child" (orphan On Feedback card): pick an Issues card and set ITS parent to `parentId`. */
  z.object({ type: z.literal('link_child'), parentId: NotionIdSchema }),
  /** "add link to MR description" (weak link). */
  z.object({
    type: z.literal('add_notion_link_to_mr'),
    repoId: RepoIdSchema,
    mrIid: z.number().int().positive(),
    cardId: NotionIdSchema,
  }),
  /** "rename MR title to branch name" (weak link). */
  z.object({
    type: z.literal('rename_mr_title'),
    repoId: RepoIdSchema,
    mrIid: z.number().int().positive(),
    cardId: NotionIdSchema,
  }),
]);
export type Fix = z.infer<typeof FixSchema>;
export type FixType = Fix['type'];

/**
 * Result of evaluating one rule for one (card, MR). Both statuses are carried so the UI can
 * always render `Notion: Complete │ GitLab: merged ✓` side by side.
 */
export const VerdictSchema = z.object({
  ruleId: z.string().min(1),
  severity: SeveritySchema,
  message: z.string(),
  cardId: NotionIdSchema.nullable(),
  repoId: RepoIdSchema.nullable(),
  mrIid: z.number().int().positive().nullable(),
  notionStatus: z.string().nullable(),
  mrState: MrDerivedStateSchema,
  /** Display titles so the UI needs no join. */
  cardTitle: z.string().nullable(),
  mrTitle: z.string().nullable(),
  /** Both sides, preformatted: `Notion: Complete │ GitLab: merged ✓` = `${notion}` / `${gitlab}`. */
  sides: z.object({ notion: z.string(), gitlab: z.string() }),
  /** Extra, situational text (e.g. "3 of 3 child Issues are Ready to Test"). */
  detail: z.string().nullable(),
  /** Primary one-click fix: only a suggestion, applying it is user-confirmed, audited and undoable. */
  fix: FixSchema.nullable(),
  /** Other valid fixes (e.g. "→ In Progress / Issues"). */
  alternatives: z.array(FixSchema),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Rule object contract: `{ when(card, mr, ctx) → boolean, severity, message, fix }`.
 * `Ctx` is supplied by the rule engine (siblings, child Issues, release facts…); its concrete
 * shape is owned by the syncHealth service, so it is generic here.
 */
export interface Rule<Ctx = unknown> {
  id: string;
  severity: Severity;
  message: string;
  when(card: Card | null, mr: Mr | null, ctx: Ctx): boolean;
  fix?(card: Card | null, mr: Mr | null, ctx: Ctx): Fix | null;
  /** Other valid fixes besides `fix`. */
  alternatives?(card: Card | null, mr: Mr | null, ctx: Ctx): Fix[];
  /** Situational text appended to `message`. */
  detail?(card: Card | null, mr: Mr | null, ctx: Ctx): string | null;
}
