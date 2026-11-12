import { z } from 'zod';
import { AgentEffortSchema } from './ai';
import { EpochMsSchema, FlavorSchema, RepoIdSchema } from './common';

/** Mobile Dev Cockpit shared shapes. */

export const WorkspaceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const WORKSPACE_COLORS = [
  'amber',
  'emerald',
  'sky',
  'violet',
  'rose',
  'lime',
  'orange',
  'teal',
] as const;
export const WorkspaceColorSchema = z.enum(WORKSPACE_COLORS);
export type WorkspaceColor = z.infer<typeof WorkspaceColorSchema>;

export const WorkspaceSchema = z.object({
  id: WorkspaceIdSchema,
  name: z.string().min(1).max(60),
  /** Absolute path on the Mac (validated by the host against HOST_AGENT_WORKSPACE_ROOTS). */
  absPath: z.string().min(1).max(1024),
  repoId: RepoIdSchema.nullable(),
  defaultBase: z.string().min(1).max(200),
  color: WorkspaceColorSchema,
  createdAt: EpochMsSchema,
  /** 'worktree' = a git worktree of `parentId`, made so several cards can run agents at once. */
  kind: z.enum(['repo', 'worktree']).default('repo'),
  parentId: WorkspaceIdSchema.nullable().default(null),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Most cards one bulk start takes (each runs its own agent). */
export const BULK_START_MAX = 6;

export const WorkspaceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    absPath: z.string().trim().min(1).max(1024),
    repoId: RepoIdSchema.nullable().default(null),
    defaultBase: z.string().trim().min(1).max(200).default('main'),
    color: WorkspaceColorSchema.optional(),
  })
  .strict();
export type WorkspaceCreate = z.infer<typeof WorkspaceCreateSchema>;

export const WsStatusSchema = z.object({
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  head: z.string().nullable(),
  dirty: z.array(z.object({ path: z.string(), code: z.string() })),
});
export type WsStatusView = z.infer<typeof WsStatusSchema>;

export const WsFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  hash: z.string(),
  size: z.number(),
});
export type WsFile = z.infer<typeof WsFileSchema>;

export const WsFileWriteSchema = z
  .object({
    path: z.string().min(1).max(1024),
    content: z.string().max(1024 * 1024),
    /** Hash read before editing; null = new file. */
    expectedHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

// ───────────────────────────── sessions ─────────────────────────────

export const SESSION_KINDS = ['claude', 'cursor', 'shell', 'flutter'] as const;
export const SessionKindSchema = z.enum(SESSION_KINDS);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SESSION_STATES = ['running', 'idle', 'exited'] as const;

/**
 * A Claude session is a document, not a terminal (`claude -p` over stream-json). Output: one `ConversationEvent` JSON per
 * line on the session stream. Input: one `ConversationCommand` JSON per session input.
 */
export const CONVERSATION_MODES = ['plan', 'acceptEdits'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

export type ConversationEvent =
  | { k: 'user'; text: string }
  | { k: 'text'; text: string }
  | { k: 'tool'; id: string; name: string; summary: string }
  | { k: 'tool_done'; id: string; ok: boolean; output?: string }
  | {
      k: 'ask';
      /** The CLI's request id. */
      id: string;
      ask: 'plan' | 'question' | 'permission';
      tool: string;
      summary: string;
      /** The command or path a permission is about. */
      detail: string | null;
      plan: string | null;
      questions: {
        question: string;
        multiSelect: boolean;
        options: { label: string; description: string | null }[];
      }[];
      /** A permission can be remembered for this session. */
      canRemember: boolean;
      /** Plan only: the model the user may switch to on Approve (`execSwitch: 'ask'`). */
      exec?: { model: string; effort: string | null } | null;
    }
  | {
      k: 'ask_done';
      id: string;
      outcome:
        'approved' | 'revised' | 'rejected' | 'allowed' | 'denied' | 'answered' | 'cancelled';
    }
  | { k: 'turn'; outcome: 'done' | 'stopped' | 'failed'; message?: string }
  | { k: 'mode'; mode: ConversationMode }
  /** The model the session runs on: the start model, a picker change, or the exec switch after plan approval. */
  | { k: 'model'; model: string }
  | { k: 'notice'; level: 'info' | 'error'; text: string };

export const ConversationCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), text: z.string().min(1) }),
  z.object({
    type: z.literal('answer'),
    id: z.string().min(1).max(100),
    allow: z.boolean(),
    /** With `allow: false`: tells the agent why, or what to change in a plan. */
    message: z.string().max(20_000).optional(),
    /** With `allow: true`: also allow this for the rest of the session. */
    remember: z.boolean().optional(),
    /** Approving a plan: true = run it on the execution model, false = keep the planning model. */
    execModel: z.boolean().optional(),
    /** The chosen labels of a question, by question text. */
    answers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('mode'), mode: z.enum(CONVERSATION_MODES) }),
  z.object({ type: z.literal('model'), model: z.enum(['default', 'opus', 'sonnet', 'haiku']) }),
]);
export type ConversationCommand = z.infer<typeof ConversationCommandSchema>;

export const CockpitSessionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{8,64}$/),
  workspaceId: WorkspaceIdSchema,
  kind: SessionKindSchema,
  title: z.string(),
  state: z.enum(SESSION_STATES),
  /** Agent waits for input / finished its turn (output idle + prompt marker). */
  waiting: z.boolean(),
  exitCode: z.number().int().nullable(),
  startedAt: EpochMsSchema,
  lastOutputAt: EpochMsSchema.nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type CockpitSession = z.infer<typeof CockpitSessionSchema>;

/**
 * An AI device-test session: Claude with only the bench and Marionette MCP tools, no file edits
 * and no shell. The bench tools reach the dashboard on `benchUrl` with a token scoped to this one run.
 */
export const TEST_RUN_ENGINES = ['claude', 'cursor'] as const;
export const TestRunEngineSchema = z.enum(TEST_RUN_ENGINES);
export type TestRunEngine = z.infer<typeof TestRunEngineSchema>;
/** Cursor models an AI device test may use: Auto (balanced) and Composer 2.5 Fast, nothing else. */
export const CURSOR_TEST_MODELS = ['auto', 'composer-2.5-fast'] as const;
export const CursorTestModelSchema = z.enum(CURSOR_TEST_MODELS);
export type CursorTestModel = z.infer<typeof CursorTestModelSchema>;

export const TestRunProfileSchema = z
  .object({
    benchUrl: z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    runId: z.string().uuid(),
    engine: TestRunEngineSchema.default('claude'),
    /** `cursor` only. */
    cursorModel: CursorTestModelSchema.default('auto'),
  })
  .strict();
export type TestRunProfile = z.infer<typeof TestRunProfileSchema>;

/** `flutter run` build mode. Debug has no flag, so hot reload stays available. */
export const FLUTTER_RUN_MODES = ['debug', 'profile', 'release'] as const;
export const FlutterRunModeSchema = z.enum(FLUTTER_RUN_MODES);
export type FlutterRunMode = z.infer<typeof FlutterRunModeSchema>;

/** Entrypoints a workspace can run. `plainMain` is only true when no flavored file exists. */
export const RunTargetsSchema = z
  .object({
    flavors: z.array(FlavorSchema),
    plainMain: z.boolean(),
  })
  .strict();
export type RunTargets = z.infer<typeof RunTargetsSchema>;

const AgentModelIdSchema = z.string().regex(/^[a-z0-9.-]{1,64}$/i);

export const SessionStartSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    kind: SessionKindSchema,
    /** `flutter`: the device id for `flutter run -d`. */
    deviceId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,120}$/)
      .optional(),
    /**
     * `flutter`: name of `lib/main_<flavor>.dart`. Omitted when the workspace has one flavored
     * entrypoint, or only `lib/main.dart`.
     */
    flavor: FlavorSchema.optional(),
    /** `flutter`: debug (the default) passes no mode flag. */
    mode: FlutterRunModeSchema.default('debug'),
    /** `flutter`: an iOS device keeps `-t` and drops `--flavor`. */
    ios: z.boolean().default(false),
    cols: z.number().int().min(20).max(500).default(100),
    rows: z.number().int().min(5).max(200).default(30),
    /** `claude` / `cursor`: model the session starts on (planning). Unset = the built-in default. */
    model: AgentModelIdSchema.optional(),
    /** `claude`: model (and effort) the session switches to when the user approves a plan. */
    execModel: AgentModelIdSchema.optional(),
    execEffort: AgentEffortSchema.optional(),
    execSwitch: z.enum(['ask', 'auto']).optional(),
  })
  .strict();
export type SessionStart = z.infer<typeof SessionStartSchema>;
/** What a caller may omit; `SessionStartSchema.parse` fills `mode`, `ios`, `cols`, and `rows`. */
export type SessionStartInput = z.input<typeof SessionStartSchema>;

export const SessionInputSchema = z
  .object({
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();
export const SessionResizeSchema = z
  .object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) })
  .strict();

export const FlutterDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  emulator: z.boolean(),
  /** `device` = connected/running; `emulator` = an AVD/simulator that can be booted. */
  source: z.enum(['device', 'emulator']),
});
export type FlutterDevice = z.infer<typeof FlutterDeviceSchema>;

/** What "Start with agent" will hand the agent from the Notion card (dialog preview). */
export interface CardContentPreview {
  /** The first part of the card body as markdown. */
  excerpt: string;
  chars: number;
  truncated: boolean;
  imageCount: number;
  fileCount: number;
  parent: { title: string; chars: number } | null;
  parentError: string | null;
  links: string[];
}

/** One file the user attaches on Start with agent. */
export interface CardStartAttachment {
  name: string;
  dataBase64: string;
}
