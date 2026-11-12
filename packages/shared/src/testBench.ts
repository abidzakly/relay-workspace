import { z } from 'zod';
import { EpochMsSchema } from './common';

/**
 * Test Bench: before an MR is opened, the branch is run on a real device and
 * checked against the card's Acceptance Criteria and its Figma design. Ticks live in THIS app only; Notion's
 * checkboxes are never written (QA starts from a clean card).
 */

/** One Acceptance Criterion read from the Notion page body. */
export const AcItemSchema = z.object({
  /** Notion block id. */
  id: z.string(),
  /** Stable key: hash of the normalized text. A tick is tied to it, so editing the AC text in Notion clears the tick. */
  key: z.string(),
  text: z.string(),
  /** Notion's own checkbox (QA's state). Shown, never written. */
  notionChecked: z.boolean(),
  /** "… — reason: why" written in Notion. */
  reason: z.string().nullable(),
  /** The heading this item sits under. */
  section: z.string().nullable(),
  kind: z.enum(['todo', 'bullet']),
  parentId: z.string().nullable(),
});
export type AcItem = z.infer<typeof AcItemSchema>;

export const CardBodySchema = z.object({
  cardId: z.string(),
  ac: z.array(AcItemSchema),
  /** First figma.com link in the body, unless a manual override is set. */
  figmaUrl: z.string().nullable(),
  /** `override` = set by hand in this app. */
  figmaSource: z.enum(['notion', 'override', 'none']),
  docLinks: z.array(z.string()),
  description: z.string(),
  /** Notion `last_edited_time` the body was read at. */
  lastEditedAt: EpochMsSchema,
  fetchedAt: EpochMsSchema,
  /** The body had more blocks than the reader follows. */
  truncated: z.boolean(),
});
export type CardBody = z.infer<typeof CardBodySchema>;

export const AC_STATES = ['untested', 'pass', 'fail', 'blocked', 'excused'] as const;
export const AcStateSchema = z.enum(AC_STATES);
export type AcState = z.infer<typeof AcStateSchema>;

export const CHECK_ACTORS = ['human', 'ai'] as const;
export const CheckActorSchema = z.enum(CHECK_ACTORS);

/** A tick on an AC or on a regression check (`target` = `ac:<key>` or `finding:<id>`). */
export const AcCheckSchema = z.object({
  cardId: z.string(),
  target: z.string(),
  state: AcStateSchema,
  by: CheckActorSchema,
  runId: z.string().nullable(),
  /** HEAD sha the check was made on. A different HEAD shows "changed since verified" but keeps the tick. */
  verifiedSha: z.string().nullable(),
  note: z.string(),
  evidencePath: z.string().nullable(),
  updatedAt: EpochMsSchema,
});
export type AcCheck = z.infer<typeof AcCheckSchema>;

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** open → fixing (sent to an agent) → fixed (a commit with its trailer landed) → verified (retest passed). */
export const FINDING_STATUSES = ['open', 'fixing', 'fixed', 'verified', 'wontfix'] as const;
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  repoId: z.string(),
  branch: z.string(),
  title: z.string(),
  severity: FindingSeveritySchema,
  /** The AC it breaks, when there is one. */
  acKey: z.string().nullable(),
  steps: z.string(),
  expected: z.string(),
  actual: z.string(),
  screenshotPath: z.string().nullable(),
  source: CheckActorSchema,
  status: FindingStatusSchema,
  runId: z.string().nullable(),
  fixCommitSha: z.string().nullable(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingInputSchema = z.object({
  title: z.string().trim().min(3).max(200),
  severity: FindingSeveritySchema.default('major'),
  acKey: z.string().max(80).nullable().default(null),
  steps: z.string().max(4000).default(''),
  expected: z.string().max(2000).default(''),
  actual: z.string().max(2000).default(''),
});
export type FindingInput = z.infer<typeof FindingInputSchema>;

export const FindingPatchSchema = FindingInputSchema.partial().extend({
  status: z.enum(['open', 'verified', 'wontfix']).optional(),
});
export type FindingPatch = z.infer<typeof FindingPatchSchema>;

export const RUN_MODES = ['manual', 'ai'] as const;
export const RUN_STATUSES = ['active', 'paused', 'done', 'aborted'] as const;
export const RUN_VERDICTS = ['ready', 'not_ready'] as const;

export const TestRunSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  repoId: z.string(),
  branch: z.string(),
  headSha: z.string(),
  mode: z.enum(RUN_MODES),
  status: z.enum(RUN_STATUSES),
  verdict: z.enum(RUN_VERDICTS).nullable(),
  summary: z.string(),
  /** Why an AI run is paused for a human (OTP, login, a permission dialog …). */
  waitingFor: z.string().nullable(),
  deviceSerial: z.string().nullable(),
  startedAt: EpochMsSchema,
  endedAt: EpochMsSchema.nullable(),
});
export type TestRun = z.infer<typeof TestRunSchema>;

/** What the server decides from the ticks and the findings. The client never computes this on its own. */
export const BenchReadinessSchema = z.object({
  ready: z.boolean(),
  /** Human-readable blockers ("2 AC untested", "1 open finding"). */
  blockers: z.array(z.string()),
  counts: z.object({
    ac: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    blocked: z.number().int(),
    untested: z.number().int(),
    regressions: z.number().int(),
    openFindings: z.number().int(),
  }),
});
export type BenchReadiness = z.infer<typeof BenchReadinessSchema>;

export const TestBenchStateSchema = z.object({
  repoId: z.string(),
  branch: z.string(),
  /** Local HEAD of the workspace, or the pushed sha when no workspace has the branch. */
  headSha: z.string().nullable(),
  card: z.object({ id: z.string(), title: z.string(), url: z.string().nullable() }).nullable(),
  body: CardBodySchema.nullable(),
  /** Why the body could not be read (Notion down, not configured …). */
  bodyError: z.string().nullable(),
  checks: z.array(AcCheckSchema),
  findings: z.array(FindingSchema),
  /** Figma frame chosen per AC (`acKey` → node id). */
  frames: z.record(z.string(), z.string()),
  latestRun: TestRunSchema.nullable(),
  readiness: BenchReadinessSchema,
  /** The latest run is `ready` AND was made on the current HEAD. This is what the Create MR gate reads. */
  testOk: z.boolean(),
});
export type TestBenchState = z.infer<typeof TestBenchStateSchema>;

/** An opened bench that is not finished yet: the sidebar's "Continue testing". */
export const OpenBenchSchema = z.object({
  repoId: z.string(),
  branch: z.string(),
  cardTitle: z.string(),
  openedAt: z.number().int(),
  passed: z.number().int(),
  ac: z.number().int(),
});
export type OpenBench = z.infer<typeof OpenBenchSchema>;

export const SetCheckSchema = z.object({
  target: z.string().regex(/^(ac|finding):[A-Za-z0-9_-]{1,80}$/),
  state: AcStateSchema,
  note: z.string().max(1000).default(''),
});
export type SetCheck = z.infer<typeof SetCheckSchema>;

export const FinishRunSchema = z.object({
  verdict: z.enum(RUN_VERDICTS),
  summary: z.string().max(8000).default(''),
});

/** The fixup / squash trailer that ties a fix commit to a finding. */
export const TEST_FINDING_TRAILER = 'Test-Finding';

// ── Figma (C1)

export const FigmaFrameSchema = z.object({
  /** Node id, `12:34`. */
  id: z.string(),
  name: z.string(),
  page: z.string(),
});
export type FigmaFrame = z.infer<typeof FigmaFrameSchema>;

export const FigmaFramesSchema = z.object({
  fileKey: z.string(),
  fileName: z.string(),
  lastModified: z.string().nullable(),
  frames: z.array(FigmaFrameSchema),
  truncated: z.boolean(),
});
export type FigmaFrames = z.infer<typeof FigmaFramesSchema>;

/** The Figma MCP bridge: is its process up, and which Figma files have the plugin open right now. */
export const FigmaBridgeStatusSchema = z.object({
  /** `down` = the bridge process could not be started or has stopped. */
  bridge: z.enum(['up', 'down']),
  files: z.array(z.object({ fileKey: z.string(), fileName: z.string() })),
  error: z.string().nullable(),
});
export type FigmaBridgeStatus = z.infer<typeof FigmaBridgeStatusSchema>;

/** `fileKey` and `nodeId` (`1:23` form) of a figma.com design link; null when it is not one. */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  // /design/:key/…, /file/:key/…, /proto/:key/…, /design/:key/branch/:branchKey/…
  const kinds = ['design', 'file', 'proto'];
  const at = parts.findIndex((p) => kinds.includes(p));
  if (at < 0 || !parts[at + 1]) return null;
  const branchAt = parts.indexOf('branch', at + 2);
  const fileKey = branchAt > 0 && parts[branchAt + 1] ? parts[branchAt + 1]! : parts[at + 1]!;
  if (!/^[A-Za-z0-9]{10,64}$/.test(fileKey)) return null;
  const raw = u.searchParams.get('node-id');
  const nodeId = raw ? raw.replace('-', ':') : null;
  return { fileKey, nodeId: nodeId && /^\d+:\d+$/.test(nodeId) ? nodeId : null };
}

const px = z.number().int().min(0).max(10_000);
const ascii = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x20-\x7e]+$/, 'printable ASCII only');
const findText = z.string().min(1).max(200);

/**
 * One action of the AI tester. Element actions take `n` from the latest screen list; the server
 * turns it into pixels, waits for the screen to settle, and answers with what changed plus any new app errors.
 */
export const BenchActSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap_element'), n: z.number().int().min(0).max(5_000) }),
  z.object({
    kind: z.literal('type_into'),
    n: z.number().int().min(0).max(5_000),
    text: ascii,
    clear: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('scroll_until'),
    text: findText,
    direction: z.enum(['down', 'up']).default('down'),
    maxSwipes: z.number().int().min(1).max(15).default(8),
  }),
  z.object({
    kind: z.literal('wait_for'),
    text: findText,
    gone: z.boolean().default(false),
    timeoutMs: z.number().int().min(500).max(20_000).default(8_000),
  }),
  z.object({
    kind: z.literal('key'),
    key: z.enum(['back', 'home', 'app_switch', 'enter', 'delete', 'tab']),
  }),
  z.object({ kind: z.literal('tap'), x: px, y: px }),
  z.object({
    kind: z.literal('swipe'),
    x1: px,
    y1: px,
    x2: px,
    y2: px,
    ms: z.number().int().min(50).max(5_000).default(300),
  }),
  z.object({ kind: z.literal('type_text'), text: ascii }),
  z.object({ kind: z.literal('restart_app') }),
]);
export type BenchAct = z.infer<typeof BenchActSchema>;
