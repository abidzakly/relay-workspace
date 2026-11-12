/* eslint-disable no-control-regex -- control characters are matched on purpose: these values end up in argv */
import { z } from 'zod';
import { AgentModelsSchema, AiModelsSchema, AiTemplateSchema } from './ai';
import { promptOverrideProblem } from './aiPrompts';
import { FeaturesSchema } from './features';
import {
  BranchNameSchema,
  BranchPrefixSchema,
  FlavorSchema,
  RepoIdSchema,
  UsernameSchema,
} from './common';

/**
 * Three shapes exist for each config:
 *  - full     : what the server holds in memory / accepts on write (contains secrets)
 *  - stored   : what goes into the DB JSON column (secrets removed; they live encrypted elsewhere)
 *  - public   : what the API returns (secrets replaced by `*Set` booleans). Secrets are NEVER returned.
 */

export const SecretSchema = z.string().min(1).max(4096);

// ───────────────────────────── shared enums / defaults ─────────────────────────────

export const NOTIFICATION_EVENTS = [
  'approved',
  'comment',
  'reply',
  'merged',
  'pipelineFailed',
  'buildDone',
  'mismatch',
  'slaWarn',
  'slaBreach',
  /** A pushed branch matches a card's Branch formula and has no MR yet. */
  'readyForMr',
  /** A cockpit agent session finished / waits for input. */
  'agentDone',
  /** Reviews: you were asked to review, or mentioned, on a merge request. */
  'reviewRequested',
] as const;
export const NotificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

export const DEFAULT_CARD_STATUSES = [
  'Backlog',
  'Next Up',
  'In Progress',
  'Complete',
  'Ready to Test',
  'On Feedback',
  'Issues',
] as const;

export const ENGINES = ['node', 'pty'] as const;
export const EngineSchema = z.enum(ENGINES);
export type Engine = z.infer<typeof EngineSchema>;

export const APPROVAL_MODES = ['approvals_api', 'award_emoji', 'note_keyword'] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

// ───────────────────────────── 3.1 Global ─────────────────────────────

const NotionPropsSchema = z.object({
  /** "auto" = detect the title property. */
  title: z.string().min(1).default('auto'),
  /** "auto" = detect `status` type, else `select` named "Status" (like nts). */
  status: z.string().min(1).default('auto'),
  type: z.string().min(1).default('Type'),
  assignee: z.string().min(1).default('Assignee'),
  estimation: z.string().min(1).default('Estimation'),
  branchName: z.string().min(1).default('Branch name'),
  parent: z.string().min(1).default('Parent item'),
  /** Read only when `sla.assignedAtSource` is `property`; a missing one is not a schema problem. */
  assignedAt: z.string().min(1).default('Assigned at'),
  /** Optional. Maps to the connected repo(s) listing it in `productDomains` (shareable). */
  productDomain: z.string().min(1).default('Product Domain'),
  /** Optional. Complexity 1-6 (see `pointEffort`). */
  point: z.string().min(1).default('Point'),
  /** Optional. Cards sharing a value form one sprint. */
  sprint: z.string().min(1).default('Select Sprint'),
  /** Optional. Relation to the card's sub-tasks (the inverse of `parent`). */
  subTasks: z.string().min(1).default('Sub-task'),
});

/**
 * How statuses group for KPI and "needs action" purposes. Names compare case/space-insensitively.
 *  - complete : the "Complete" role (dev done, MR in review), whatever the workspace spells it
 *  - done     : reached Ready to Test or later (task completion KPI); also never an open SLA timer
 *  - inactive : not actionable work (parked or closed): never surfaced as focus or needs-action
 */
const StatusGroupsSchema = z.object({
  complete: z.array(z.string().min(1)).default(['Complete', 'Completed']),
  done: z
    .array(z.string().min(1))
    .default(['Ready to Test', 'Hold Test', 'On Testing', 'Done', 'Archived']),
  inactive: z
    .array(z.string().min(1))
    .default(['Archived', 'Done', 'Backlog', 'Draft', 'Assign to PM']),
  /** Left out of the completion-rate denominator (work that was never committed to). */
  uncommitted: z.array(z.string().min(1)).default(['Backlog', 'Draft', 'Assign to PM']),
});
export type StatusGroups = z.infer<typeof StatusGroupsSchema>;

const notionFields = {
  /** Encrypted at rest; never returned by the API. */
  token: SecretSchema.optional(),
  dataSourceId: z.string().min(1).optional(),
  version: z.string().min(1).default('2025-09-03'),
  props: NotionPropsSchema.prefault({}),
  statuses: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULT_CARD_STATUSES]),
  readyStatus: z.string().min(1).default('Ready to Test'),
  /**
   * Extra spellings that identify ME on a card's Assignee (Notion display name, e-mail or user id), besides
   * `gitlab.myUsername`. Compared case/space/punctuation-insensitively. Used for `assigned_at_first_seen`.
   */
  assigneeAliases: z.array(z.string().min(1).max(200)).max(20).default([]),
  statusGroups: StatusGroupsSchema.prefault({}),
  /** Where Acceptance Criteria live in a card body (Test Bench). */
  ac: z
    .object({
      /** Headings whose items are AC. Case-insensitive substring; 3 letters or fewer must match a whole word. */
      headings: z
        .array(z.string().trim().min(1).max(80))
        .min(1)
        .max(20)
        .default(['Acceptance Criteria', 'Definition of Done', 'QA']),
      /** "Login works — reason: SSO is down": the text after the marker is the reason. */
      reasonMarker: z.string().trim().min(1).max(40).default('reason:'),
    })
    .prefault({}),
};

const SlaSchema = z.object({
  /** Days allowed per card Type. Keys are Notion `Type` option names. */
  rules: z
    .record(z.string(), z.int().positive())
    .default({ Issues: 3, Feedback: 3, 'New Feature': 5, Improvement: 3 }),
  unit: z.enum(['calendar', 'working']).default('calendar'),
  bugRatioMax: z.number().min(0).max(1).default(0.3),
  /** `all` = every card of the month; `completed` = only completed ones. */
  bugRatioDenominator: z.enum(['all', 'completed']).default('all'),
  /** The Notion `Type` option names the ratio and the quota count. */
  bugType: z.string().min(1).default('Issues'),
  researchType: z.string().min(1).default('Research'),
  researchMinPerMonth: z.int().nonnegative().default(1),
  assignedAtSource: z.enum(['firstSeen', 'property']).default('firstSeen'),
  /** Task completion rate target (cards that reached Ready to Test or later / committed cards). */
  completionTarget: z.number().min(0).max(1).default(0.9),
});

/** MR timing escalation (>2d amber, >4d red, configurable). Hours since the MR was opened. */
const MrTimingSchema = z
  .object({
    amberAfterHours: z
      .number()
      .positive()
      .max(24 * 365)
      .default(48),
    redAfterHours: z
      .number()
      .positive()
      .max(24 * 365)
      .default(96),
  })
  .refine((t) => t.redAfterHours > t.amberAfterHours, {
    message: 'redAfterHours must be greater than amberAfterHours',
    path: ['redAfterHours'],
  });

const globalCommon = {
  publicBaseUrl: HttpUrlSchema.optional(),
  /** On at first start: writes to GitLab, Notion and Drive are previewed until this is switched off. */
  dryRun: z.boolean().default(true),
  gitlab: z
    .object({
      host: HttpUrlSchema.optional(),
      myUsername: UsernameSchema.optional(),
    })
    .prefault({}),
  drive: z
    .object({
      serviceAccountKeyPath: z
        .string()
        .min(1)
        .default('data/credentials/drive-service-account.json'),
      anyoneWithLink: z.boolean().default(true),
    })
    .prefault({}),
  sla: SlaSchema.prefault({}),
  mrTiming: MrTimingSchema.prefault({}),
  notifications: z
    .object({
      events: z.array(NotificationEventSchema).default([...NOTIFICATION_EVENTS]),
      ignoreOwn: z.boolean().default(true),
    })
    .prefault({}),
  engine: EngineSchema.default('node'),
  /**
   * KPI presets, each with its own switch. Off hides that part of the KPI page; the numbers are still kept.
   *  - pointsAsHours: a card's Point is read as estimated hours (effort, sprint load).
   *  - researchQuota: a minimum of Research cards per month.
   *  - bugRatio: a maximum share of bug cards per month.
   */
  kpi: z
    .object({
      pointsAsHours: z.boolean().default(true),
      researchQuota: z.boolean().default(true),
      bugRatio: z.boolean().default(true),
    })
    .prefault({}),
  sprint: z
    .object({
      /** Hours one sprint can hold (the harbor's waterline). */
      capacityHours: z.number().positive().max(10_000).default(40),
    })
    .prefault({}),
  /** Agent + model per AI feature (`default` applies to every feature without its own entry). */
  aiModels: AiModelsSchema.default({}),
  /** Settings > AI prompts: replaces a template's built-in prompt. Its `{{placeholders}}` must stay the same. */
  aiPrompts: z
    .partialRecord(AiTemplateSchema, z.string().trim().min(1).max(50_000))
    .superRefine((prompts, ctx) => {
      for (const [template, text] of Object.entries(prompts)) {
        const problem = text ? promptOverrideProblem(template as never, text) : null;
        if (problem) ctx.addIssue({ code: 'custom', path: [template], message: problem });
      }
    })
    .default({}),
  /** Interactive coding agent for new sessions started by "Fix with agent" / "Review" (Deck, Test Bench, MR threads). */
  agentPreference: z.enum(['claude', 'cursor']).default('claude'),
  /**
   * Claude sessions plan on `planModel`; when a plan is approved the session switches to `execModel` (and
   * `execEffort`). Cursor runs in a TUI without an approval channel, so it keeps one model (`cursorModel`).
   */
  agentModels: AgentModelsSchema.prefault({}),
  /** Storage cleanup (no AI): run the safe rules once a day. Branches, APKs and clones always wait for a click. */
  storageCleanup: z.object({ auto: z.boolean().default(true) }).prefault({}),
  /** Which parts of the dashboard are switched on (Settings > General > Features). */
  features: FeaturesSchema.prefault({}),
  /**
   * Asked once on first start: does your work include releasing and building a mobile app? `true` switches Release
   * and Builds on, `false` off (web and backend teams usually ship through CI/CD). null = not asked yet. Change it
   * any time under Settings > General > Features.
   */
  profile: z
    .object({
      releasesMobileApp: z.boolean().nullable().default(null),
      /**
       * Windows only, asked first: `native` = keep running on Windows with the WSL-only features off, `wsl` = the user
       * moves the install into WSL. null = not asked (or not Windows).
       */
      windowsMode: z.enum(['native', 'wsl']).nullable().default(null),
    })
    .prefault({}),
  reviews: z
    .object({
      /** Check GitLab to-dos once a minute for projects no webhook reaches. Off = webhooks and the Refresh button only. */
      poll: z.boolean().default(true),
    })
    .prefault({}),
};

function readyStatusInStatuses(n: { statuses: string[]; readyStatus: string }): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  return n.statuses.some((s) => norm(s) === norm(n.readyStatus));
}
const READY_MSG = { message: 'readyStatus must be one of statuses', path: ['readyStatus'] };

/** Full config (includes notion.token). */
export const GlobalConfigSchema = z.object({
  ...globalCommon,
  notion: z.object(notionFields).refine(readyStatusInStatuses, READY_MSG).prefault({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

const { token: _notionToken, ...notionFieldsNoToken } = notionFields;

/** DB-stored JSON: no secrets. */
export const GlobalConfigStoredSchema = z.object({
  ...globalCommon,
  notion: z.object(notionFieldsNoToken).refine(readyStatusInStatuses, READY_MSG).prefault({}),
});
export type GlobalConfigStored = z.infer<typeof GlobalConfigStoredSchema>;

/** API-facing: secrets replaced by a boolean. */
export const GlobalConfigPublicSchema = z.object({
  ...globalCommon,
  notion: z.object({ ...notionFieldsNoToken, tokenSet: z.boolean() }),
});
export type GlobalConfigPublic = z.infer<typeof GlobalConfigPublicSchema>;

export function toStoredGlobalConfig(cfg: GlobalConfig): GlobalConfigStored {
  const { token: _t, ...notion } = cfg.notion;
  return { ...cfg, notion };
}

export function toPublicGlobalConfig(cfg: GlobalConfig): GlobalConfigPublic {
  const { token, ...notion } = cfg.notion;
  return { ...cfg, notion: { ...notion, tokenSet: token !== undefined && token.length > 0 } };
}

// ───────────────────────────── 3.2 Per-repo ─────────────────────────────

/** Safe `git clone` source: https/ssh/scp-like/file/absolute path. Never `-…` and never `ext::`. */
// Control characters are rejected on purpose (values end up in git argv).
export const CLONE_URL_RE =
  /^(?:https?:\/\/|ssh:\/\/|file:\/\/|git@[A-Za-z0-9.-]+:|\/)[^\s\u0000-\u001f]+$/;
export const CloneUrlSchema = z
  .string()
  .max(1024)
  .regex(CLONE_URL_RE, 'unsupported clone URL')
  .refine((s) => !s.startsWith('-'), 'clone URL must not start with "-"');

export const TAG_FORMAT_RE = /^[A-Za-z0-9._/-]*\{commitVersion\}[A-Za-z0-9._/-]*$/;

const noControlChars = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

const repoGitlabCommon = {
  projectId: z.int().positive(),
};

const repoCommon = {
  id: RepoIdSchema,
  name: z.string().trim().min(1).max(100).refine(noControlChars, 'control characters not allowed'),
  /** Off = this repo's cards stay off the Board. Sync, webhooks and releases keep working. */
  enabled: z.boolean().default(true),
  baseBranch: BranchNameSchema.default('main'),
  /** Merge gate: approved by ANY of these. At least one is required. */
  reviewers: z.array(UsernameSchema).min(1),
  approvalMode: ApprovalModeSchema.default('approvals_api'),
  /** Notion `Product Domain` values served by this repo (several repos may share one). Empty = none. */
  productDomains: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  /** Version MRs are "your call" unless this also applies the merge gate to them. */
  requireVersionMrApproval: z.boolean().default(false),
  versionBranchPrefix: BranchPrefixSchema.default('release/v'),
  /** MR assignee for version MRs; falls back to gitlab.myUsername when unset. */
  assignee: UsernameSchema.optional(),
  tagFormat: z
    .string()
    .max(100)
    .regex(TAG_FORMAT_RE, 'tagFormat must contain {commitVersion}')
    .default('v{commitVersion}'),
  /** Auto-managed (`~/.relay/clones/<id>`) when unset; or an existing clone. */
  localPath: z
    .string()
    .min(1)
    .max(1024)
    .refine((s) => !s.includes('\u0000') && !s.startsWith('-'), 'invalid path')
    .optional(),
  cloneUrl: CloneUrlSchema,
  partialClone: z.boolean().default(true),
  commitIdentity: z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine(noControlChars, 'control characters not allowed'),
      email: z.email(),
    })
    .optional(),
  flutter: z
    .object({
      useFvm: z.boolean().default(false),
      /** "auto" = detect from lib/main_*.dart. */
      stagingFlavor: FlavorSchema.default('auto'),
      appName: z.string().trim().min(1).max(100).nullable().default(null),
      cleanAfterUpload: z.boolean().default(false),
    })
    .prefault({}),
  drive: z
    .object({
      folderId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{5,100}$/, 'invalid Drive folder id')
        .optional(),
    })
    .prefault({}),
  qa: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      /** Digits only, international format without "+" (used in wa.me URL). */
      whatsapp: z
        .string()
        .regex(/^\d{6,15}$/, 'digits only, 6-15')
        .optional(),
      template: z
        .string()
        .max(2000)
        .default('Hi {qa}, {repo} {version} is ready.\nDrive: {drive}\nChanges:\n{changes}'),
    })
    .prefault({}),
};

/** Full repo config (includes secrets). */
export const RepoConfigSchema = z.object({
  ...repoCommon,
  gitlab: z.object({
    ...repoGitlabCommon,
    /** Encrypted at rest; never returned by the API. */
    token: SecretSchema,
    /** Auto-generated server-side when absent. Encrypted at rest; never returned. */
    webhookSecret: SecretSchema.optional(),
  }),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** DB-stored JSON: no secrets. */
export const RepoConfigStoredSchema = z.object({
  ...repoCommon,
  gitlab: z.object(repoGitlabCommon),
});
export type RepoConfigStored = z.infer<typeof RepoConfigStoredSchema>;

/** API-facing: secrets replaced by booleans. */
export const RepoConfigPublicSchema = z.object({
  ...repoCommon,
  gitlab: z.object({
    ...repoGitlabCommon,
    tokenSet: z.boolean(),
    webhookSecretSet: z.boolean(),
  }),
});
export type RepoConfigPublic = z.infer<typeof RepoConfigPublicSchema>;

export function toStoredRepoConfig(cfg: RepoConfig): RepoConfigStored {
  const { token: _t, webhookSecret: _w, ...gitlab } = cfg.gitlab;
  return { ...cfg, gitlab };
}

export function toPublicRepoConfig(cfg: RepoConfig): RepoConfigPublic {
  const { token, webhookSecret, ...gitlab } = cfg.gitlab;
  return {
    ...cfg,
    gitlab: { ...gitlab, tokenSet: token.length > 0, webhookSecretSet: !!webhookSecret },
  };
}
