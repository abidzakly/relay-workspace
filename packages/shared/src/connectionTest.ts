import { z } from 'zod';

/**
 * Result of a connection test (`/api/settings/test-notion|test-drive`).
 * A flat checklist the Settings UI renders as-is. Tests are READ-ONLY calls, so dry-run does not apply.
 * Nothing in here may carry a secret (tokens, private keys, access tokens).
 */
export const CHECK_STATUSES = ['pass', 'warn', 'fail', 'skip'] as const;
/** `skip` = not run because an earlier check it depends on failed, or not needed for this config. */
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CHECK_GROUPS = ['gitlab', 'webhook', 'notion', 'drive', 'ai'] as const;
export const CheckGroupSchema = z.enum(CHECK_GROUPS);
export type CheckGroup = z.infer<typeof CheckGroupSchema>;

export const CheckSchema = z.object({
  /** Stable id, e.g. `gitlab.scope`, `notion.prop.estimation`. */
  id: z.string().min(1),
  group: CheckGroupSchema,
  label: z.string().min(1),
  status: CheckStatusSchema,
  message: z.string(),
  /** What the user should do about a warn/fail. */
  hint: z.string().optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const CheckSummarySchema = z.object({
  pass: z.int().nonnegative(),
  warn: z.int().nonnegative(),
  fail: z.int().nonnegative(),
  skip: z.int().nonnegative(),
});
export type CheckSummary = z.infer<typeof CheckSummarySchema>;

/** Notion facts discovered by the test (nothing secret). Later parts store/use these. */
export const NotionDetectedSchema = z.object({
  titleProp: z.object({ name: z.string(), id: z.string() }).optional(),
  statusProp: z
    .object({
      name: z.string(),
      id: z.string(),
      /** Decides the PATCH body key: `{status:{id}}` vs `{select:{id}}`. */
      type: z.enum(['status', 'select']),
    })
    .optional(),
  /** Configured status name -> Notion option (matched case/whitespace-insensitively). */
  statusOptions: z.array(z.object({ configured: z.string(), name: z.string(), id: z.string() })),
});
export type NotionDetected = z.infer<typeof NotionDetectedSchema>;

export const ConnectionTestResultSchema = z.object({
  /** True when no check failed (warnings are OK). */
  ok: z.boolean(),
  summary: CheckSummarySchema,
  checks: z.array(CheckSchema),
  testedAt: z.int().nonnegative(),
  notion: NotionDetectedSchema.optional(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export function summarizeChecks(checks: readonly Pick<Check, 'status'>[]): CheckSummary {
  const s: CheckSummary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) s[c.status] += 1;
  return s;
}

export function buildTestResult(
  checks: Check[],
  now: number,
  extra: { notion?: NotionDetected } = {},
): ConnectionTestResult {
  const summary = summarizeChecks(checks);
  return {
    ok: summary.fail === 0,
    summary,
    checks,
    testedAt: now,
    ...(extra.notion ? { notion: extra.notion } : {}),
  };
}

/** Case/whitespace-insensitive name comparison key (Notion property + option names). */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
