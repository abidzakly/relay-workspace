import { z } from 'zod';
import { EpochMsSchema, RepoIdSchema } from './common';
import { WebhookEventStatusSchema } from './events';

/**
 * Project-hook management (`POST /api/repos/:id/webhook/register`).
 * Shapes of what the dashboard API returns; the GitLab payloads behind them follow GitLab's
 * documented Project Hooks API and are UNVERIFIED against the live instance.
 */

/** The four events we subscribe to (GitLab flag names). Everything else is switched off. */
export const HOOK_EVENT_FLAGS = [
  'merge_requests_events',
  'note_events',
  'pipeline_events',
  'push_events',
] as const;
export type HookEventFlag = (typeof HOOK_EVENT_FLAGS)[number];

export const WebhookHookSummarySchema = z.object({
  id: z.number().int(),
  url: z.string(),
  /** Its path ends with `/webhook/<repoId>`: a hook this dashboard created (possibly with an old base URL). */
  ours: z.boolean(),
  /** `url` equals the URL we would register right now. */
  urlMatches: z.boolean(),
  events: z.object({
    merge_requests: z.boolean(),
    note: z.boolean(),
    pipeline: z.boolean(),
    push: z.boolean(),
  }),
  /** Events we do NOT want that are switched on (e.g. `tag_push_events`). */
  extraEvents: z.array(z.string()),
  sslVerification: z.boolean().nullable(),
  /** GitLab's `alert_status` (`executable | disabled | temporarily_disabled`), when the version has it. */
  alertStatus: z.string().nullable(),
});
export type WebhookHookSummary = z.infer<typeof WebhookHookSummarySchema>;

export const WEBHOOK_STATES = ['registered', 'outdated', 'disabled', 'missing', 'unknown'] as const;
export const WebhookStateSchema = z.enum(WEBHOOK_STATES);
export type WebhookState = z.infer<typeof WebhookStateSchema>;

export const WebhookProblemSchema = z.enum([
  'public_url_missing',
  'public_url_not_https',
  'gitlab_host_missing',
]);
export type WebhookProblem = z.infer<typeof WebhookProblemSchema>;

export const WebhookStatusSchema = z.object({
  repoId: RepoIdSchema,
  /** `<publicBaseUrl>/webhook/<repoId>`; null while the public URL is unusable (`problem`). */
  expectedUrl: z.string().nullable(),
  problem: WebhookProblemSchema.nullable(),
  state: WebhookStateSchema,
  /** All project hooks (so a stale ngrok URL or a foreign hook is visible). Never carries a token. */
  hooks: z.array(WebhookHookSummarySchema),
  /** Last delivery we stored for this repo (webhook health panel). */
  lastEvent: z
    .object({
      receivedAt: EpochMsSchema,
      objectKind: z.string().nullable(),
      status: WebhookEventStatusSchema,
    })
    .nullable(),
  /** Why the hook list could not be read (secret-free). */
  gitlabError: z.object({ kind: z.string(), message: z.string() }).nullable(),
});
export type WebhookStatus = z.infer<typeof WebhookStatusSchema>;

export const WEBHOOK_OUTCOMES = ['created', 'updated', 'unchanged', 'failed'] as const;
export const WebhookOutcomeSchema = z.enum(WEBHOOK_OUTCOMES);
export type WebhookOutcome = z.infer<typeof WebhookOutcomeSchema>;

export const WebhookRegisterResultSchema = z.object({
  repoId: RepoIdSchema,
  outcome: WebhookOutcomeSchema,
  /** true = global dry-run: GitLab was NOT called; `outcome` is what WOULD have happened. */
  dryRun: z.boolean(),
  url: z.string().nullable(),
  hookId: z.number().int().nullable(),
  auditId: z.number().int().nullable(),
  error: z.object({ kind: z.string(), message: z.string() }).nullable(),
});
export type WebhookRegisterResult = z.infer<typeof WebhookRegisterResultSchema>;

export const WebhookRegisterAllResultSchema = z.object({
  dryRun: z.boolean(),
  results: z.array(WebhookRegisterResultSchema),
});
export type WebhookRegisterAllResult = z.infer<typeof WebhookRegisterAllResultSchema>;
