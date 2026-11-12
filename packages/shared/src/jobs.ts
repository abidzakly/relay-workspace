import { z } from 'zod';
import {
  EpochMsSchema,
  FlavorSchema,
  JsonSchema,
  ReleaseRefSchema,
  RepoIdSchema,
  VersionSchema,
} from './common';
import { EngineSchema } from './config';

export const JOB_KINDS = ['release', 'build'] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

/**
 * staging | prod | custom version.
 * NOTE: only `staging` is ever eligible for auto-share to QA; the share rule must treat every
 * other mode (including `custom`) as NOT shareable until the human decides otherwise.
 */
export const JOB_MODES = ['staging', 'prod', 'custom'] as const;
export const JobModeSchema = z.enum(JOB_MODES);
export type JobMode = z.infer<typeof JobModeSchema>;

export const JOB_STATUSES = [
  'queued',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Release engine steps, in order. Build jobs may use a subset. */
export const JOB_STEP_NAMES = [
  'PREFLIGHT',
  'FIND_OPEN_MR',
  'SYNC_BASE',
  'COMPUTE_VERSION',
  'CREATE_BRANCH',
  'BUMP_PUBSPEC',
  'COMMIT',
  'PUSH',
  'CREATE_MR',
  'AWAIT_REVIEW',
  'MERGE',
  'CLEANUP',
  'TAG',
  'BUILD',
  'UPLOAD',
  'SHARE',
  'NOTION',
  'DONE',
] as const;
export const JobStepNameSchema = z.enum(JOB_STEP_NAMES);
export type JobStepName = z.infer<typeof JobStepNameSchema>;

export const JOB_STEP_STATUSES = [
  'pending',
  'running',
  'paused',
  'succeeded',
  'failed',
  'skipped',
] as const;
export const JobStepStatusSchema = z.enum(JOB_STEP_STATUSES);
export type JobStepStatus = z.infer<typeof JobStepStatusSchema>;

/** A release or build run. `state` is the persisted, resumable bag. */
export const JobSchema = z.object({
  id: z.string().min(1),
  repoId: RepoIdSchema,
  kind: JobKindSchema,
  engine: EngineSchema,
  mode: JobModeSchema,
  status: JobStatusSchema,
  currentStep: JobStepNameSchema.nullable(),
  /** New version (validated: it ends up in git/flutter argv). */
  version: VersionSchema.nullable(),
  prevVersion: VersionSchema.nullable(),
  /** Version branch (validated: it ends up in git argv). A prod branch contains `+`. */
  branch: ReleaseRefSchema.nullable(),
  mrIid: z.number().int().positive().nullable(),
  flavor: FlavorSchema.nullable(),
  dryRun: z.boolean(),
  state: z.record(z.string(), JsonSchema),
  error: z.string().nullable(),
  /** A build job spawned by a release job points back to it. */
  parentJobId: z.string().min(1).nullable(),
  createdAt: EpochMsSchema,
  startedAt: EpochMsSchema.nullable(),
  finishedAt: EpochMsSchema.nullable(),
  updatedAt: EpochMsSchema,
});
export type Job = z.infer<typeof JobSchema>;

export const JobStepSchema = z.object({
  id: z.number().int().positive(),
  jobId: z.string().min(1),
  /** 0-based order within the job. */
  seq: z.number().int().nonnegative(),
  name: JobStepNameSchema,
  status: JobStepStatusSchema,
  startedAt: EpochMsSchema.nullable(),
  finishedAt: EpochMsSchema.nullable(),
  /** Captured, secret-free log output for this step. */
  log: z.string(),
  /** Step result needed to resume (commit sha, MR iid, …). */
  output: z.record(z.string(), JsonSchema).nullable(),
  error: z.string().nullable(),
});
export type JobStep = z.infer<typeof JobStepSchema>;

// ───────────────────────────── Builds ─────────────────────────────

/** Which commands run: staging = APK, prod = APK + AAB. */
export const BUILD_MODES = ['staging', 'prod'] as const;
export const BuildModeSchema = z.enum(BUILD_MODES);
export type BuildMode = z.infer<typeof BuildModeSchema>;

export const BuildArtifactSchema = z.object({
  kind: z.enum(['apk', 'aab']),
  /** `<AppName> <FlavorLabel> v<version>.apk`. */
  fileName: z.string().min(1),
  /** The copy under `data/apks/<repo>/`. It outlives a `flutter clean`. */
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type BuildArtifact = z.infer<typeof BuildArtifactSchema>;

/**
 * The BUILD step's output on a build job. `mode` is the job's own, so a `custom` release stays `custom` here: the
 * prod rule reads this, and only `staging` may be uploaded or shared.
 */
export const BuildResultSchema = z.object({
  mode: JobModeSchema,
  buildMode: BuildModeSchema,
  /** Null only for a dry run on a repo with no clone. */
  flavor: FlavorSchema.nullable(),
  /** Null only for a dry run on a repo with no clone. */
  version: VersionSchema.nullable(),
  /** The commands as run, or as they would have run in a dry run. */
  commands: z.array(z.string()),
  /** Empty in a dry run: nothing was built. */
  artifacts: z.array(BuildArtifactSchema),
  dryRun: z.boolean(),
});
export type BuildResult = z.infer<typeof BuildResultSchema>;

/** `flavor` null: the UI must ask (both or neither of main_staging and main_development). Never guessed. */
export const FlavorDetectionSchema = z.object({
  flavor: FlavorSchema.nullable(),
  reason: z.enum([
    'requested',
    'configured',
    'production',
    'only_staging',
    'only_development',
    'both',
    'neither',
  ]),
  /** Flavors the user may pick: each `lib/main_<flavor>.dart` found, except production. */
  candidates: z.array(FlavorSchema),
});
export type FlavorDetection = z.infer<typeof FlavorDetectionSchema>;

// ───────────────────────────── Build API ─────────────────────────────

/** Standalone builds only: `custom` and a parent job are for the release pipeline, which calls the queue directly. */
export const BuildStartRequestSchema = z
  .object({
    repo: RepoIdSchema,
    mode: BuildModeSchema,
    /** The user's choice after 409 `flavor_choice_required`. */
    flavor: FlavorSchema.nullish(),
  })
  .strict();
export type BuildStartRequest = z.infer<typeof BuildStartRequestSchema>;

/** One open MR merged into a QA preview build, kept on the job as `state.integration`. */
export const PreviewMrSchema = z.object({
  iid: z.number().int().positive(),
  branch: z.string().min(1),
  title: z.string(),
});
export type PreviewMr = z.infer<typeof PreviewMrSchema>;

/** QA preview: the open MRs merged locally in order, a local staging bump, nothing pushed. */
export const BuildPreviewRequestSchema = z
  .object({
    repo: RepoIdSchema,
    mrIids: z.array(z.number().int().positive()).min(1).max(50),
    flavor: FlavorSchema.nullish(),
  })
  .strict();
export type BuildPreviewRequest = z.infer<typeof BuildPreviewRequestSchema>;

export interface PreviewCandidate extends PreviewMr {
  draft: boolean;
  hasConflicts: boolean;
  /** Position in merge order, from 1. */
  order: number;
  parentBranch: string | null;
  webUrl: string | null;
}
export interface PreviewCandidates {
  baseBranch: string;
  items: PreviewCandidate[];
}

/** Same-origin link to a file under `data/apks/`. Served on the private listener only. */
export const apkDownloadPath = (repoId: string, fileName: string) =>
  `/apks/${encodeURIComponent(repoId)}/${encodeURIComponent(fileName)}`;

/**
 * What `jobs.state.upload` holds once a staging APK reached Drive, or was simulated in a dry run (null file id and link).
 * - `anyone`: anyone with the link can open it.
 * - `restricted`: `drive.anyoneWithLink` is off, so QA needs access to the folder.
 * - `failed`: the file is on Drive, but setting anyone-with-the-link failed.
 */
export const BuildUploadSchema = z.object({
  dryRun: z.boolean(),
  fileId: z.string().min(1).nullable(),
  webViewLink: z.string().min(1).nullable(),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  linkAccess: z.enum(['anyone', 'restricted', 'failed', 'simulated']),
  at: EpochMsSchema,
});
export type BuildUpload = z.infer<typeof BuildUploadSchema>;

/** Upload and share state of a build. `eligible` is only for showing the buttons: the server decides again on each call. */
export const BuildShareViewSchema = z.object({
  eligible: z.boolean(),
  /** Null unless an upload is in progress. */
  uploading: z
    .object({
      sentBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    })
    .nullable(),
  upload: BuildUploadSchema.nullable(),
  uploadError: z.string().nullable(),
});
export type BuildShareView = z.infer<typeof BuildShareViewSchema>;

/** `POST /api/share/:jobId`. The local link works only where the dashboard runs, so it is left out unless asked for. */
export const ShareRequestSchema = z.object({ includeLocalLink: z.boolean().optional() }).strict();
export type ShareRequest = z.infer<typeof ShareRequestSchema>;

/** Nothing has been sent: WhatsApp needs a human to open this link and press send. */
export const ShareResultSchema = z.object({
  dryRun: z.boolean(),
  message: z.string(),
  whatsappUrl: z.string().min(1),
  linkAccess: BuildUploadSchema.shape.linkAccess,
});
export type ShareResult = z.infer<typeof ShareResultSchema>;

/** An artifact as the UI sees it: a link, not a path on the server's disk. */
export const BuildArtifactViewSchema = BuildArtifactSchema.omit({ path: true }).extend({
  url: z.string().min(1),
  /** False when the file has since been removed from `data/apks/`. */
  available: z.boolean(),
});
export type BuildArtifactView = z.infer<typeof BuildArtifactViewSchema>;

export const BuildViewSchema = z.object({
  job: JobSchema,
  /** A cancel was asked for and the processes have not stopped yet: the job is still `running`. */
  cancelling: z.boolean(),
  /** 1 = next in line. Null unless the job is waiting. */
  queuePosition: z.number().int().positive().nullable(),
  /** Empty until the job has succeeded, and in a dry run. */
  artifacts: z.array(BuildArtifactViewSchema),
  share: BuildShareViewSchema,
});
export type BuildView = z.infer<typeof BuildViewSchema>;

/** Answer of `GET /api/builds`: newest first. */
export const BuildListSchema = z.object({
  runningJobId: z.string().nullable(),
  items: z.array(BuildViewSchema),
});
export type BuildList = z.infer<typeof BuildListSchema>;

/** Per-job SSE stream of a build's log. Named frames, each with JSON data. A line's `id` is its sequence number. */
export const buildLogPath = (jobId: string) => `/api/builds/${encodeURIComponent(jobId)}/log`;
/** `{ line }`: one line of output, redacted, possibly with ANSI sequences. */
export const BUILD_FRAME_LINE = 'line';
/** `{ reason }`: some output is missing here. */
export const BUILD_FRAME_TRUNCATED = 'truncated';
/** The job is over and nothing more will come: the client closes, or it would reconnect. */
export const BUILD_FRAME_END = 'end';
/**
 * - `buffer`: a live run's oldest lines have left its in-memory buffer (2 MB).
 * - `stored`: the job is over, and only the newest 64 KB of its log was kept.
 * - `gap`: the job ended during a reconnect, and its stored log is too cut to tell what was missed.
 */
export const BUILD_LOG_TRUNCATIONS = ['buffer', 'stored', 'gap'] as const;
export type BuildLogTruncation = (typeof BUILD_LOG_TRUNCATIONS)[number];

// ───────────────────────────── Release API ─────────────────────────────

export const ReleaseStartRequestSchema = z
  .object({
    mode: JobModeSchema,
    /** The user's edit of the preview. Staging also takes a bare number (the alpha number). */
    version: z.string().min(1).max(100).nullish(),
    /** Default: the engine set in Settings. */
    engine: EngineSchema.optional(),
  })
  .strict();
export type ReleaseStartRequest = z.infer<typeof ReleaseStartRequestSchema>;

/** `flavor`: the user's choice, when BUILD stopped at `flavor_choice_required`. */
export const ReleaseResumeRequestSchema = z.object({ flavor: FlavorSchema.optional() }).strict();
export type ReleaseResumeRequest = z.infer<typeof ReleaseResumeRequestSchema>;

export const ReleasePreviewQuerySchema = z.object({
  mode: JobModeSchema,
  version: z.string().min(1).max(100).optional(),
});
export type ReleasePreviewQuery = z.infer<typeof ReleasePreviewQuerySchema>;

/** What COMPUTE_VERSION would produce now. */
export const ReleasePreviewSchema = z.object({
  mode: z.enum(['staging', 'prod']),
  current: z.string(),
  proposed: z.string(),
  newVersion: z.string(),
  commitVersion: z.string(),
  overridden: z.boolean(),
  branch: z.string(),
  commitMessage: z.string(),
  tag: z.string(),
});
export type ReleasePreview = z.infer<typeof ReleasePreviewSchema>;

/**
 * A live PTY run waiting at a prompt. `enter`: `vu`'s review prompt, the one input the dashboard sends. `other`: anything
 * else that looks like a question (a token, a commit author). It is shown and never answered.
 */
export const PtyPromptSchema = z.object({
  kind: z.enum(['enter', 'other']),
  text: z.string(),
});
export type PtyPrompt = z.infer<typeof PtyPromptSchema>;

/** Answer of `GET /api/release-engines`. */
export const ReleaseEnginesSchema = z.object({
  current: EngineSchema,
  pty: z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
    /** The release command the custom engine runs (`RELEASE_COMMAND`, else `vu`), where it runs. */
    command: z.string().nullable().optional(),
  }),
});
export type ReleaseEngines = z.infer<typeof ReleaseEnginesSchema>;

/** Per-job SSE stream of a PTY run's terminal output. Named frames, each with JSON data. */
export const ptyStreamPath = (jobId: string) => `/api/release/${encodeURIComponent(jobId)}/stream`;
/** `{ data }`: terminal bytes, redacted. */
export const PTY_FRAME_OUTPUT = 'output';
/** `{ dropped }`: the oldest output is gone from the buffer. */
export const PTY_FRAME_TRUNCATED = 'truncated';
/** The run is over and nothing more will come: the client closes, or it would reconnect. */
export const PTY_FRAME_END = 'end';
/** The size of the pseudo-terminal, which the panel must match. */
export const PTY_COLS = 100;
export const PTY_ROWS = 30;

/** What the NOTION step changed by itself: the release's Complete cards. */
export const ReleaseNotionAutoSchema = z.object({
  updated: z.number().int().nonnegative(),
  skippedNotComplete: z.number().int().nonnegative(),
  /** Cards that could not be read or written. */
  failed: z.array(z.object({ title: z.string(), message: z.string() })),
  /** Simulated: nothing reached Notion. */
  dryRun: z.boolean(),
  /** The whole batch was refused, so no card was changed. */
  error: z.string().nullable(),
});
export type ReleaseNotionAuto = z.infer<typeof ReleaseNotionAutoSchema>;

/**
 * The NOTION step's outcome: the cards noted before the version bump, with their status as cached now. Those it could not
 * change stay open to the bulk endpoints after the job has ended.
 */
export const ReleaseNotionOfferSchema = z.object({
  offeredAt: EpochMsSchema,
  /** The pending list could not be told when it was noted, so an empty list does not mean nothing was pending. */
  pendingUnknown: z.boolean(),
  readyStatus: z.string(),
  /** Null for a release from before the step changed cards by itself: all of its cards wait for a review. */
  auto: ReleaseNotionAutoSchema.nullable(),
  cards: z.array(
    z.object({
      cardId: z.string().min(1),
      title: z.string(),
      /** Null when the card has no status, or is no longer cached. */
      status: z.string().nullable(),
      ready: z.boolean(),
    }),
  ),
});
export type ReleaseNotionOffer = z.infer<typeof ReleaseNotionOfferSchema>;

/** Answer of every release job route. */
export const ReleaseJobViewSchema = z.object({
  job: JobSchema,
  steps: z.array(JobStepSchema),
  /** A cancel was asked for and the step in progress has not stopped yet: the job is still `running`. */
  cancelling: z.boolean(),
  /** Only while a PTY run is waiting at a prompt. */
  ptyPrompt: PtyPromptSchema.nullable(),
  /** Null until the NOTION step has run. Always null for a PTY job. */
  notion: ReleaseNotionOfferSchema.nullable(),
});
export type ReleaseJobView = z.infer<typeof ReleaseJobViewSchema>;
