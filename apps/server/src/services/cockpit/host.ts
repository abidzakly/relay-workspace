import type { AgentEffort, TestRunProfile } from '@relay/shared';
import type { SquashResult, WsCommit } from './branchOps';
import type {
  CockpitSession,
  DiffFile,
  FlutterDevice,
  FlutterRunMode,
  RunTargets,
  SessionKind,
} from '@relay/shared';
import type { SessionEvent } from './sessions';
import type { ExistingBranch, IntegrityStep } from './workflowOps';
import type {
  CleanupApplyResult,
  TmpCleanupFacts,
  WsCleanupFacts,
  WsCleanupItem,
} from './wsCleanup';
import type { DiffMode, WsStatus } from './workspaceFs';

/**
 * The Mac side of the Mobile Dev Cockpit. ONE interface, two implementations:
 *  - `LocalCockpitHost`: runs on this machine (dashboard not in Docker), and inside the host agent (`pnpm agent`).
 *  - `RemoteCockpitHost`: the dashboard in Docker reaches the agent's `/v1/cockpit/*` routes.
 * Grows per phase: AI, workspaces + local diffs, PTY sessions.
 */

export interface AiRunRequest {
  prompt: string;
  /** Full model id, e.g. `claude-opus-5-5` or `composer-2.5-fast`. */
  model: string;
  timeoutMs: number;
  /** Which CLI answers; default `claude`. */
  engine?: 'claude' | 'cursor' | undefined;
  /** Claude's thinking effort: `low` for the fast tier. Cursor ignores it. */
  effort?: 'low' | 'medium' | 'high' | undefined;
}

export interface CockpitHostHealth {
  /** `claude` CLI found and runnable. */
  claude: { available: boolean; reason: string | null };
  /** `cursor-agent` CLI found and runnable. Absent on a host agent older than the Cursor fallback. */
  cursor?: { available: boolean; reason: string | null };
}

export class CockpitHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    /** Secret-free extra data, e.g. the flavors a run must choose from. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CockpitHostError';
  }
}

/** Options for `sessionStart`. Flutter fields are ignored for every other kind. */
export interface SessionStartOpts {
  kind: SessionKind;
  deviceId?: string | undefined;
  cols: number;
  rows: number;
  testRun?: TestRunProfile | undefined;
  /** `flutter`: `lib/main_<flavor>.dart`. Omitted lets the host pick the only entrypoint. */
  flavor?: string | undefined;
  mode?: FlutterRunMode | undefined;
  /** `flutter`: iOS keeps `-t` and drops `--flavor`. */
  ios?: boolean | undefined;
  /** `claude` / `cursor`: model the session starts on. Unset = the built-in default. */
  model?: string | undefined;
  /** `claude`: model + effort the session switches to once the user approves a plan. */
  execModel?: string | undefined;
  execEffort?: AgentEffort | undefined;
  execSwitch?: 'ask' | 'auto' | undefined;
}

/** Every workspace call names the directory (the host re-validates it against its roots) and the workspace id. */
export interface WsRef {
  path: string;
  wsId: string;
}

export interface WsValidation {
  realPath: string;
  branch: string | null;
  origin: string | null;
}

export interface CockpitHost {
  /** `refresh` drops the cached CLI checks (the binary may have been installed or fixed since). */
  health(refresh?: boolean): Promise<CockpitHostHealth>;
  /** `claude -p` or `cursor-agent -p` headless; resolves with the model's final text (not parsed). */
  ai(req: AiRunRequest): Promise<{ text: string }>;

  // ── workspaces
  wsValidate(ref: WsRef): Promise<WsValidation>;
  /** Writes the standing agent rules into the workspace, excluded from git (`agentRules.ts`). */
  wsEnsureAgentRules(ref: WsRef): Promise<void>;
  wsStatus(ref: WsRef): Promise<WsStatus>;
  wsDiff(ref: WsRef, mode: DiffMode, base?: string): Promise<{ files: DiffFile[]; label: string }>;
  wsTree(ref: WsRef): Promise<{ paths: string[]; truncated: boolean }>;
  wsReadFile(ref: WsRef, rel: string): Promise<{ content: string; hash: string; size: number }>;
  wsWriteFile(
    ref: WsRef,
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }>;
  /** Snapshot before an agent turn; returns the checkpoint number. */
  wsCheckpoint(ref: WsRef): Promise<{ n: number }>;

  // ── sessions
  sessionStart(ref: WsRef, opts: SessionStartOpts): Promise<CockpitSession>;
  sessions(): Promise<CockpitSession[]>;
  sessionInput(id: string, data: string): Promise<void>;
  sessionResize(id: string, cols: number, rows: number): Promise<void>;
  sessionKill(id: string): Promise<void>;
  /** Replays from `since`, then streams; resolves when the stream ends (exit, abort, agent gone). */
  sessionAttach(
    id: string,
    since: number,
    onEvent: (e: SessionEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  flutterDevices(ref: WsRef): Promise<FlutterDevice[]>;
  /** `lib/main_*.dart` in the workspace, plus whether a plain `lib/main.dart` is the only target. */
  flutterRunTargets(ref: WsRef): Promise<RunTargets>;
  flutterLaunchEmulator(ref: WsRef, emulatorId: string): Promise<void>;

  // ── Test Bench: local history with trailers, and the one-commit squash before an MR.
  wsLog(ref: WsRef, base: string): Promise<WsCommit[]>;
  wsSquashForMr(ref: WsRef, branch: string, base: string): Promise<SquashResult>;

  // ── workflow
  wsIntegrity(ref: WsRef): Promise<{ ok: boolean; steps: IntegrityStep[] }>;
  wsStartBranch(
    ref: WsRef,
    branch: string,
    base: string,
    /** An existing branch: reset it to `base` or check it out as it is. Unset = refuse (`branch_exists`). */
    existing?: ExistingBranch,
  ): Promise<{ branch: string; base: string; replaced: boolean; reused?: boolean }>;
  /**
   * A new branch from `base` in its own git worktree next to the workspace (bulk start). The new path is inside the
   * allowed roots, or the worktree is removed again and the call fails. `existing` as in `wsStartBranch`.
   */
  wsAddWorktree(
    ref: WsRef,
    branch: string,
    base: string,
    existing?: ExistingBranch,
  ): Promise<{ path: string; replaced?: boolean; reused?: boolean }>;
  /** Removes a worktree `wsAddWorktree` made for `ref`. Its branch stays. */
  wsRemoveWorktree(ref: WsRef, path: string): Promise<void>;
  /** Stashes (untracked included) or discards the working tree's changes; `stash` = the new stash commit. */
  wsCleanTree(
    ref: WsRef,
    mode: 'stash' | 'discard',
  ): Promise<{ mode: 'stash' | 'discard'; stash: string | null }>;
  /** Puts an existing branch (an MR's source) in the working tree; `synced` = it matches or contains origin's tip. */
  wsCheckoutBranch(ref: WsRef, branch: string): Promise<{ branch: string; synced: boolean }>;
  /** Stores a file for an agent inside `.git/` (never committed); returns its absolute path on the Mac. */
  wsSaveAttachment(
    ref: WsRef,
    group: string,
    name: string,
    dataBase64: string,
  ): Promise<{ path: string }>;
  /** Storage cleanup: what the cockpit left in this workspace's git dir (attachments, refs, branches). */
  wsCleanupFacts(ref: WsRef, base: string): Promise<WsCleanupFacts>;
  /** Deletes the given items, each re-checked at that moment (see `wsCleanup.ts`). */
  wsCleanupApply(
    ref: WsRef,
    base: string,
    items: readonly WsCleanupItem[],
  ): Promise<CleanupApplyResult>;
  /** Cockpit leftovers in the host's OS temp dir. */
  tmpCleanupFacts(): Promise<TmpCleanupFacts>;
  tmpCleanupApply(names: readonly string[]): Promise<CleanupApplyResult>;
}
