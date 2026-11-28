import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLAVOR_RE,
  type CockpitSession,
  type CursorTestModel,
  type AgentEffort,
  type FlutterDevice,
  type FlutterRunMode,
  FIGMA_MCP_NAME,
  FIGMA_READ_TOOLS,
  FIGMA_WRITE_TOOLS,
  type FigmaToolsProfile,
  type RunTargets,
  type SessionKind,
  type TestRunProfile,
  type ConversationMode,
  isConversationKind,
} from '@relay/shared';
import type { Logger } from '../../util/logger';
import { listEntrypoints } from '../flutterBuild';
import { loadNodePty, type NodePtyModule, type NodePtyProcess } from '../ptyBackend';
import { CLAUDE_BIN, CLAUDE_SESSION_MODEL } from './claudeCli';
import { ClaudeConversation } from './claudeConversation';
import { CursorConversation } from './cursorConversation';
import { CURSOR_BIN, CURSOR_MODEL } from './cursorCli';
import { CockpitHostError } from './host';
import type { PersistedSpec, SessionStore } from './sessionStore';
import {
  ChainedPty,
  DevUrlWatcher,
  listeningUrl,
  probeFrameBlocked,
  webEnv,
  type WebRunStep,
} from './webRun';
import {
  defaultShell,
  IS_WINDOWS,
  launchSpec,
  ptyKill,
  ptySpec,
  signalTree,
  which,
} from '../../util/platform';

/**
 * Persistent PTY sessions. A session survives the phone going away:
 * output goes to a 2 MB ring buffer, and `attach(since)` replays from an offset, then streams live. Only a fixed set of
 * programs may run (claude, cursor-agent, a login shell, flutter run), always with `cwd` = a validated workspace.
 * Claude runs as a `ClaudeConversation`, whose events use the same buffer and attach path; the others run in a PTY.
 */

export const RING_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 12;
const EXITED_TTL_MS = 30 * 60_000;
/** Output quiet this long after a burst = the agent finished its turn / waits. */
export const IDLE_MS = 2_500;
const MIN_BURST = 200;

/** Variables a session never inherits: dashboard secrets, and an API key that would bill the CLI instead of the subscription. */
const DROP_ENV =
  /^(MASTER_KEY|HOST_AGENT_TOKEN|VAPID_PRIVATE_KEY|NTFY_TOPIC|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/;

export function sessionEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && !DROP_ENV.test(k)) env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

/** Byte-capped scrollback with absolute offsets (characters), so a client resumes exactly where it stopped. */
export class RingBuffer {
  private chunks: { offset: number; data: string }[] = [];
  private size = 0;
  /** Offset just after the last character written. */
  end = 0;

  constructor(private readonly cap = RING_BYTES) {}

  append(data: string): number {
    const offset = this.end;
    this.chunks.push({ offset, data });
    this.size += data.length;
    this.end += data.length;
    while (this.size > this.cap && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.data.length;
    }
    return offset;
  }

  get start(): number {
    return this.chunks[0]?.offset ?? this.end;
  }

  /** Everything from `since` on. `reset` = part of it was already dropped (the client should clear its screen). */
  since(since: number): { data: string; reset: boolean; from: number } {
    const from = Math.max(since, this.start);
    let out = '';
    for (const c of this.chunks) {
      if (c.offset + c.data.length <= from) continue;
      out += c.offset >= from ? c.data : c.data.slice(from - c.offset);
    }
    return { data: out, reset: since < this.start, from };
  }
}

export type SessionEvent =
  | { t: 'data'; data: string; offset: number }
  | { t: 'reset'; offset: number }
  | { t: 'exit'; exitCode: number | null }
  | { t: 'state'; session: CockpitSession };

interface Live {
  info: CockpitSession;
  proc: NodePtyProcess | null;
  ring: RingBuffer;
  listeners: Set<(e: SessionEvent) => void>;
  bytesSinceInput: number;
  /** Set for an agent session kept on disk: how to start it again. */
  spec?: PersistedSpec;
  /** The user ended it: nothing of it is kept any more. */
  ended?: boolean;
}

interface Spawned {
  proc: NodePtyProcess;
  title: string;
  /** Throwaway files of the run, removed when the process exits. */
  cleanup: () => void;
}

export interface StartInput {
  cwd: string;
  wsId: string;
  kind: SessionKind;
  deviceId?: string | undefined;
  cols: number;
  rows: number;
  /** An AI device test; `claude` only. */
  testRun?: TestRunProfile | undefined;
  /** `claude`, not a device test: the Figma bridge tools, proxied through Relay with this session's token. */
  figma?: FigmaToolsProfile | undefined;
  /** Resolved `flutter` target. Required for that kind; the host fills it before `start`. */
  flutter?: { flavor: string | null; mode: FlutterRunMode; ios: boolean } | undefined;
  /** Resolved `web` run (install when needed, then `run <script>`) and its port. Required for that kind. */
  web?: { steps: WebRunStep[]; port: number; script: string } | undefined;
  /** Model the session starts on (planning). Unset = `CLAUDE_SESSION_MODEL` / `CURSOR_MODEL`. */
  model?: string | undefined;
  /** `claude`: switched to (with effort) when a plan is approved. */
  execModel?: string | undefined;
  execEffort?: AgentEffort | undefined;
  execSwitch?: 'ask' | 'auto' | undefined;
  /** Shown in the session list (the card title for a card's agent). Unset = the program's name. */
  title?: string | undefined;
  /** The board card this session works on. */
  cardId?: string | undefined;
}

/** Flavored `lib/main_*.dart`, and whether `lib/main.dart` is the only entrypoint. */
export async function readRunTargets(cwd: string): Promise<RunTargets> {
  const flavors = await listEntrypoints(cwd);
  const plainMain = flavors.length === 0 && existsSync(join(cwd, 'lib', 'main.dart'));
  return { flavors, plainMain };
}

/**
 * Which entrypoint `flutter run` uses (`flutter-run-menu`: `-t lib/main_<flavor>.dart`).
 * One flavored file is that file. Several require `requested`. None falls back to `lib/main.dart`
 * only when that file exists. A requested flavor that is not on disk is refused.
 */
export function chooseRunFlavor(targets: RunTargets, requested: string | undefined): string | null {
  if (requested !== undefined) {
    if (!targets.flavors.includes(requested)) {
      throw new CockpitHostError(
        'entrypoint_missing',
        `lib/main_${requested}.dart does not exist in this workspace`,
        422,
        { flavors: targets.flavors },
      );
    }
    return requested;
  }
  if (targets.flavors.length === 1) return targets.flavors[0]!;
  if (targets.flavors.length > 1) {
    throw new CockpitHostError(
      'flavor_choice_required',
      `Choose a flavor: ${targets.flavors.join(', ')}`,
      422,
      { flavors: targets.flavors },
    );
  }
  if (targets.plainMain) return null;
  throw new CockpitHostError(
    'entrypoint_missing',
    'No lib/main.dart or lib/main_<flavor>.dart in this workspace',
    422,
    { flavors: [] },
  );
}

/**
 * `flutter run` argv. `flavor` null is an unflavored repo (`lib/main.dart`, no `-t`, no `--flavor`).
 * iOS keeps `-t` and drops `--flavor`. Debug adds no mode flag.
 */
export function flutterRunCommand(
  deviceId: string,
  spec: { flavor: string | null; mode: FlutterRunMode; ios: boolean; useFvm: boolean },
): { file: string; args: string[]; title: string } {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(deviceId)) {
    throw new CockpitHostError('validation', 'flutter run needs a device id', 422);
  }
  if (spec.flavor !== null && !FLAVOR_RE.test(spec.flavor)) {
    throw new CockpitHostError('validation', 'Invalid flavor', 422);
  }
  const args = ['run'];
  if (spec.flavor !== null) {
    args.push('-t', `lib/main_${spec.flavor}.dart`);
    if (!spec.ios) args.push('--flavor', spec.flavor);
  }
  args.push('-d', deviceId);
  if (spec.mode === 'profile') args.push('--profile');
  if (spec.mode === 'release') args.push('--release');
  const title = spec.flavor !== null ? `Run · ${spec.flavor} · ${deviceId}` : `Run · ${deviceId}`;
  return spec.useFvm
    ? { file: 'fvm', args: ['flutter', ...args], title }
    : { file: 'flutter', args, title };
}

/** MCP tools an AI device test may use; nothing that edits files or runs a shell. */
export const TEST_RUN_ALLOWED_TOOLS = ['mcp__bench', 'mcp__marionette', 'Read', 'Glob', 'Grep'];
export const TEST_RUN_DENIED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
];

/**
 * Writes the MCP config of an AI device test (0600, in the OS temp dir): the bench tools (this repo's stdio server,
 * talking to the dashboard with the run's token) and, when installed, Marionette for the Flutter widget tree.
 */
export function writeTestRunMcpConfig(t: TestRunProfile): string {
  const file = join(tmpdir(), `cockpit-bench-${t.runId}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: testRunMcpServers(t) }), { mode: 0o600 });
  return file;
}

/**
 * A Cursor device test has no `--mcp-config`: it reads `<cwd>/.cursor/mcp.json`. So it gets its own empty dir in the OS
 * temp dir as cwd (the run token never lands in the repo, and the agent sees no source files). Returns that dir.
 */
export function writeCursorTestRunDir(t: TestRunProfile): string {
  const dir = mkdtempSync(join(tmpdir(), `cockpit-bench-cursor-${t.runId.slice(0, 8)}-`));
  mkdirSync(join(dir, '.cursor'), { mode: 0o700 });
  writeFileSync(
    join(dir, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: testRunMcpServers(t) }),
    { mode: 0o600 },
  );
  return dir;
}

function testRunMcpServers(t: TestRunProfile): Record<string, unknown> {
  const serverRoot = serverPackageRoot();
  const script = join(serverRoot, 'src', 'agentTools', 'benchMcp.ts');
  const servers: Record<string, unknown> = {
    bench: {
      ...tsxServer(serverRoot, script),
      env: { BENCH_URL: t.benchUrl, BENCH_TOKEN: t.token, BENCH_RUN: t.runId },
    },
  };
  const marionette = whichSync('marionette_mcp');
  // On Windows the pub launcher is a `.bat`, which an MCP client cannot start without cmd.exe.
  if (marionette) {
    servers.marionette = /\.(cmd|bat)$/i.test(marionette)
      ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', marionette] }
      : { command: marionette, args: [] };
  }
  return servers;
}

/** `apps/server`, found from this module whether it runs from `src/` (tsx) or the `dist/` bundle. */
/**
 * The MCP config of a plain Claude session with the Figma bridge tools (0600, in the OS temp dir): one stdio server,
 * this repo's proxy, which calls Relay with the session's token. Passed without `--strict-mcp-config`, so the user's
 * own MCP servers stay available.
 */
export function writeFigmaMcpConfig(p: FigmaToolsProfile): string {
  const serverRoot = serverPackageRoot();
  const file = join(tmpdir(), `cockpit-figma-${randomUUID()}.json`);
  const servers = {
    [FIGMA_MCP_NAME]: {
      ...tsxServer(serverRoot, join(serverRoot, 'src', 'agentTools', 'figmaMcp.ts')),
      env: { FIGMA_RELAY_URL: p.url, FIGMA_SESSION_TOKEN: p.token },
    },
  };
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return file;
}

/**
 * Flags for a Claude session with the Figma tools. Reads never ask (they change nothing). Edits are never
 * pre-approved: without "Agent may edit Figma" they are blocked here and hidden by Relay; with it, each call asks.
 */
export function figmaArgs(config: string, write: boolean): string[] {
  const tool = (n: string) => `mcp__${FIGMA_MCP_NAME}__${n}`;
  return [
    '--mcp-config',
    config,
    '--allowedTools',
    ...FIGMA_READ_TOOLS.map(tool),
    ...(write ? [] : ['--disallowedTools', ...FIGMA_WRITE_TOOLS.map(tool)]),
  ];
}

/**
 * An MCP server that runs one of this repo's TypeScript files: this Node with tsx's CLI file. Not
 * `node_modules/.bin/tsx`: on Windows that is a sh shim next to `tsx.CMD`, and an MCP client starts neither without a
 * shell.
 */
function tsxServer(serverRoot: string, script: string): { command: string; args: string[] } {
  const req = createRequire(join(serverRoot, 'package.json'));
  const pkgFile = req.resolve('tsx/package.json');
  const bin = (
    JSON.parse(readFileSync(pkgFile, 'utf8')) as { bin: string | Record<string, string> }
  ).bin;
  const cli = typeof bin === 'string' ? bin : (bin.tsx ?? './dist/cli.mjs');
  return { command: process.execPath, args: [join(dirname(pkgFile), cli), script] };
}

function serverPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@relay/server')
          return dir;
      } catch {
        /* keep walking */
      }
    }
    dir = dirname(dir);
  }
  throw new CockpitHostError(
    'bench_tools_missing',
    'The bench tools could not be found next to the server.',
    500,
  );
}

function whichSync(bin: string): string | null {
  const found = which(bin);
  if (found) return found;
  // `dart pub global activate` puts its launchers in ~/.pub-cache/bin, or %LOCALAPPDATA%\Pub\Cache\bin on Windows.
  const pubBin =
    IS_WINDOWS && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Pub', 'Cache', 'bin')
      : join(homedir(), '.pub-cache', 'bin');
  return which(bin, pubBin);
}

/**
 * Which program a kind runs. Pure; exported for tests. Agents start in plan mode: nothing is edited until the user
 * approves a plan in the session. Claude runs as a `ClaudeConversation` (a document with its own approval channel).
 * Cursor runs as a `CursorConversation`: one headless `cursor-agent -p` per turn, so `args` here are its per-turn
 * extras; the driver adds plan mode, `--force` after approval and `--resume`.
 */
export function commandFor(
  kind: SessionKind,
  cwd: string,
  deviceId: string | undefined,
  // Windows ignores $SHELL: under Git Bash it is an MSYS path (`/usr/bin/bash`) that ConPTY cannot start.
  shell = (IS_WINDOWS ? undefined : process.env.SHELL) || defaultShell().file,
  testRunMcpConfig?: string,
  flutter?: { flavor: string | null; mode: FlutterRunMode; ios: boolean },
  cursorTestModel?: CursorTestModel,
  /** The model a plain agent session starts on (planning). */
  agentModel?: string,
  /** A plain Claude session with the Figma tools: its MCP config file and whether edits are allowed. */
  figma?: { config: string; write: boolean },
  web?: { steps: WebRunStep[]; script: string },
): { file: string; args: string[]; title: string } {
  switch (kind) {
    case 'web': {
      const last = web?.steps.at(-1);
      if (!web || !last) throw new CockpitHostError('validation', 'A web run needs a script', 422);
      return { file: last.file, args: last.args, title: `Web · ${web.script}` };
    }
    case 'claude':
      if (testRunMcpConfig) {
        return {
          file: CLAUDE_BIN,
          args: [
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--model',
            CLAUDE_SESSION_MODEL,
            '--permission-mode',
            'default',
            '--permission-prompt-tool',
            'stdio',
            '--strict-mcp-config',
            '--mcp-config',
            testRunMcpConfig,
            '--allowedTools',
            ...TEST_RUN_ALLOWED_TOOLS,
            '--disallowedTools',
            ...TEST_RUN_DENIED_TOOLS,
          ],
          title: 'Claude · device test',
        };
      }
      return {
        file: CLAUDE_BIN,
        args: [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          agentModel ?? CLAUDE_SESSION_MODEL,
          '--permission-mode',
          'plan',
          '--permission-prompt-tool',
          'stdio',
          ...(figma ? figmaArgs(figma.config, figma.write) : []),
        ],
        title: 'Claude',
      };
    case 'cursor':
      if (cursorTestModel) {
        // Not plan mode: the tester must call the bench tools without a human approving a plan. No `--force`.
        return {
          file: CURSOR_BIN,
          args: ['--model', cursorTestModel, '--approve-mcps'],
          title: 'Cursor · device test',
        };
      }
      return {
        file: CURSOR_BIN,
        args: ['--model', agentModel ?? CURSOR_MODEL],
        title: 'Cursor',
      };
    case 'shell': {
      const fallback = defaultShell();
      return /\/(zsh|bash|fish|sh)$/.test(shell)
        ? { file: shell, args: ['-l'], title: 'Terminal' }
        : { ...fallback, title: 'Terminal' };
    }
    case 'flutter': {
      if (!flutter) {
        throw new CockpitHostError('validation', 'flutter run needs a resolved target', 422);
      }
      if (!deviceId) {
        throw new CockpitHostError('validation', 'flutter run needs a device id', 422);
      }
      const useFvm = existsSync(join(cwd, '.fvmrc')) || existsSync(join(cwd, '.fvm'));
      return flutterRunCommand(deviceId, { ...flutter, useFvm });
    }
  }
}

/** A dev server's environment: the session's, without Relay's own `NODE_ENV` (production in a release), plus its port. */
function devServerEnv(port: number): Record<string, string> {
  const { NODE_ENV: _drop, ...env } = sessionEnv();
  return { ...env, ...webEnv(port) };
}

type Conversation = ClaudeConversation | CursorConversation;
const isConversation = (p: NodePtyProcess | null): p is Conversation =>
  p instanceof ClaudeConversation || p instanceof CursorConversation;

function stopProcess(proc: NodePtyProcess): void {
  if (isConversation(proc)) {
    proc.kill();
    return;
  }
  if (proc instanceof ChainedPty) proc.stop();
  signalTree(proc.pid, 'SIGTERM', () => ptyKill(proc, 'SIGTERM'));
}

export class SessionManager {
  private readonly pty: NodePtyModule | null;
  private readonly sessions = new Map<string, Live>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    pty?: NodePtyModule | null,
    /** Agent sessions kept on disk until ended. Unset = memory only. */
    private readonly store: SessionStore | null = null,
  ) {
    this.pty = pty === undefined ? loadNodePty(log) : pty;
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref();
    this.restore();
  }

  /** Sessions from before a restart: their chat replays, their process starts again on the next message. */
  private restore(): void {
    if (!this.store) return;
    for (const p of this.store.loadAll()) {
      if (this.sessions.has(p.info.id)) continue;
      const ring = new RingBuffer();
      if (p.events) ring.append(p.events);
      this.sessions.set(p.info.id, {
        info: {
          ...p.info,
          state: 'exited',
          waiting: false,
          restorable: true,
        },
        proc: null,
        ring,
        listeners: new Set(),
        bytesSinceInput: 0,
        spec: p.spec,
      });
    }
  }

  private emit(s: Live, e: SessionEvent): void {
    for (const l of s.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must not stop the session */
      }
    }
  }

  private setState(s: Live, patch: Partial<CockpitSession>): void {
    s.info = { ...s.info, ...patch };
    this.persist(s);
    this.emit(s, { t: 'state', session: s.info });
  }

  private persist(s: Live): void {
    if (s.spec && !s.ended) this.store?.saveMeta(s.info, s.spec);
  }

  /** Idle detection + pruning of long-exited sessions. */
  private tick(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      if (s.info.state === 'exited') {
        // A kept agent session stays until the user ends it.
        if (s.spec && !s.ended) continue;
        if (now - (s.info.lastOutputAt ?? s.info.startedAt) > EXITED_TTL_MS)
          this.sessions.delete(id);
        continue;
      }
      // A conversation reports its own state; a long silent tool call is not "finished".
      if (isConversation(s.proc)) continue;
      const quiet = s.info.lastOutputAt !== null && now - s.info.lastOutputAt >= IDLE_MS;
      if (quiet && s.info.state === 'running') {
        const agent = s.info.kind === 'claude' || s.info.kind === 'cursor';
        this.setState(s, { state: 'idle', waiting: agent && s.bytesSinceInput >= MIN_BURST });
      }
    }
  }

  private checkCapacity(): void {
    const alive = [...this.sessions.values()].filter((s) => s.info.state !== 'exited').length;
    if (alive >= MAX_SESSIONS)
      throw new CockpitHostError('too_many_sessions', 'Too many sessions: close one first.', 409);
  }

  start(i: StartInput): CockpitSession {
    if (!this.pty && !isConversationKind(i.kind))
      throw new CockpitHostError('pty_unavailable', 'node-pty is not installed on the host.', 409);
    this.checkCapacity();
    if (i.testRun && i.kind !== 'claude' && i.kind !== 'cursor') {
      throw new CockpitHostError(
        'validation',
        'A device test runs in a Claude or Cursor session.',
        422,
      );
    }
    const spawned = this.spawn(i);
    const id = randomUUID();
    // A device test runs on a throwaway token and directory: nothing of it is kept.
    const spec: PersistedSpec | undefined =
      this.store && !i.testRun && (i.kind === 'claude' || i.kind === 'cursor')
        ? {
            cwd: i.cwd,
            wsId: i.wsId,
            kind: i.kind,
            ...(i.model ? { model: i.model } : {}),
            ...(i.execModel ? { execModel: i.execModel } : {}),
            ...(i.execEffort ? { execEffort: i.execEffort } : {}),
            ...(i.execSwitch ? { execSwitch: i.execSwitch } : {}),
          }
        : undefined;
    const s: Live = {
      info: {
        id,
        workspaceId: i.wsId,
        kind: i.kind,
        title: i.title?.trim() || spawned.title,
        state: isConversationKind(i.kind) ? 'idle' : 'running',
        waiting: false,
        exitCode: null,
        startedAt: this.now(),
        lastOutputAt: null,
        cols: i.cols,
        rows: i.rows,
        ...(i.cardId ? { cardId: i.cardId } : {}),
      },
      proc: null,
      ring: new RingBuffer(),
      listeners: new Set(),
      bytesSinceInput: 0,
      ...(spec ? { spec } : {}),
    };
    this.sessions.set(id, s);
    this.persist(s);
    this.wire(s, spawned);
    this.log.info({ id, kind: i.kind, ws: i.wsId }, 'cockpit session started');
    return s.info;
  }

  /** Starts the program of a session. `resume` continues a kept conversation (`--resume`). */
  private spawn(
    i: StartInput,
    resume?: { id: string | undefined; mode: ConversationMode | undefined },
  ): Spawned {
    const cursorTest = i.testRun && i.kind === 'cursor' ? i.testRun : null;
    const mcpConfig =
      i.testRun && i.kind === 'claude' ? writeTestRunMcpConfig(i.testRun) : undefined;
    // Figma is for coding sessions; a device test keeps its own strict tool set.
    const figmaConfig =
      i.figma && i.kind === 'claude' && !i.testRun ? writeFigmaMcpConfig(i.figma) : undefined;
    const cmd = commandFor(
      i.kind,
      i.cwd,
      i.deviceId,
      undefined,
      mcpConfig,
      i.flutter,
      cursorTest?.cursorModel,
      i.model,
      figmaConfig && i.figma ? { config: figmaConfig, write: i.figma.write } : undefined,
      i.web,
    );
    if (resume && i.kind === 'claude') {
      const at = cmd.args.indexOf('--permission-mode');
      if (at >= 0 && resume.mode) cmd.args[at + 1] = resume.mode;
      if (resume.id) cmd.args.push('--resume', resume.id);
    }
    const cwd = cursorTest ? writeCursorTestRunDir(cursorTest) : i.cwd;
    // flutter and fvm are `.bat` launchers on Windows, which ConPTY cannot start directly.
    const ptyCmd = ptySpec(cmd.file, cmd.args);
    let proc: NodePtyProcess;
    try {
      proc =
        i.kind === 'cursor'
          ? new CursorConversation({
              file: cmd.file,
              args: cmd.args,
              cwd,
              env: sessionEnv(),
              ...(i.model ? { model: i.model } : {}),
              ...(cursorTest
                ? { startMode: 'acceptEdits' as const }
                : {
                    startMode: resume?.mode ?? ('plan' as const),
                    forceAfterPlan: true,
                    ...(resume?.id ? { resumeId: resume.id } : {}),
                  }),
            })
          : i.kind === 'web' && i.web
            ? new ChainedPty(
                i.web.steps,
                (step, cols, rows) => {
                  const spec = ptySpec(step.file, step.args);
                  return this.pty!.spawn(spec.file, spec.args, {
                    name: 'xterm-256color',
                    cols,
                    rows,
                    cwd,
                    env: devServerEnv(i.web!.port),
                  });
                },
                { cols: i.cols, rows: i.rows },
              )
            : i.kind === 'claude'
              ? new ClaudeConversation({
                  file: cmd.file,
                  args: cmd.args,
                  cwd: i.cwd,
                  env: sessionEnv(),
                  ...(i.model ? { model: i.model } : {}),
                  ...(i.execModel ? { execModel: i.execModel } : {}),
                  ...(i.execEffort ? { execEffort: i.execEffort } : {}),
                  ...(i.execSwitch ? { execSwitch: i.execSwitch } : {}),
                  ...(resume?.mode ? { startMode: resume.mode } : {}),
                })
              : this.pty!.spawn(ptyCmd.file, ptyCmd.args, {
                  name: 'xterm-256color',
                  cols: i.cols,
                  rows: i.rows,
                  cwd,
                  env: sessionEnv(),
                });
    } catch (e) {
      if (cursorTest) rmSync(cwd, { recursive: true, force: true });
      if (mcpConfig) rmSync(mcpConfig, { force: true });
      if (figmaConfig) rmSync(figmaConfig, { force: true });
      throw new CockpitHostError(
        'spawn_failed',
        `${cmd.file} could not start: ${(e as Error).message}`,
        409,
      );
    }
    return {
      proc,
      title: cmd.title,
      cleanup: () => {
        // The run token in the Cursor test dir dies with the session.
        if (cursorTest) rmSync(cwd, { recursive: true, force: true });
        // So does the Claude one's MCP config.
        if (mcpConfig) rmSync(mcpConfig, { force: true });
        if (figmaConfig) rmSync(figmaConfig, { force: true });
      },
    };
  }

  private wire(s: Live, spawned: Spawned): void {
    const proc = spawned.proc;
    s.proc = proc;
    if (isConversation(proc)) {
      proc.onStatus(({ working, waiting }) =>
        this.setState(s, { state: working ? 'running' : 'idle', waiting }),
      );
      if (s.spec) {
        proc.onResumeId((resumeId) => {
          if (!s.spec || s.spec.resumeId === resumeId) return;
          s.spec = { ...s.spec, resumeId };
          this.persist(s);
        });
        proc.onMode((mode) => {
          if (!s.spec) return;
          s.spec = { ...s.spec, mode };
          this.persist(s);
        });
      }
    }
    const watchUrl = s.info.kind === 'web' ? this.watchPreview(s, proc) : null;
    proc.onData((data) => {
      // Ignore a process that was replaced (a restart of a kept session).
      if (s.proc !== proc) return;
      watchUrl?.(data);
      const offset = s.ring.append(data);
      if (s.spec && !s.ended) this.store?.appendEvents(s.info.id, data);
      s.bytesSinceInput += data.length;
      const wasIdle = s.info.state !== 'running';
      s.info = { ...s.info, lastOutputAt: this.now() };
      this.emit(s, { t: 'data', data, offset });
      if (wasIdle && !isConversation(proc)) {
        this.setState(s, { state: 'running', waiting: false });
      }
    });
    proc.onExit(({ exitCode }) => {
      spawned.cleanup();
      if (s.proc !== proc) return;
      s.proc = null;
      this.setState(s, {
        state: 'exited',
        waiting: false,
        exitCode,
        lastOutputAt: this.now(),
        ...(s.spec && !s.ended ? { restorable: true } : {}),
      });
      // A kept session only pauses: its viewers stay attached for when it resumes.
      if (!s.info.restorable) this.emit(s, { t: 'exit', exitCode });
    });
  }

  /**
   * A web session's preview: the address its output names, else (every 10 s, for 5 minutes) the port its process group
   * listens on. Shown at once, then marked `frameBlocked` when the page's headers refuse an iframe.
   */
  private watchPreview(s: Live, proc: NodePtyProcess): (data: string) => void {
    const watcher = new DevUrlWatcher();
    let found = false;
    let tries = 0;
    const poll = setInterval(() => {
      if (found || s.proc !== proc || ++tries > 30) {
        clearInterval(poll);
        return;
      }
      void listeningUrl(proc.pid).then((u) => u && settle(u));
    }, 10_000);
    poll.unref();
    const settle = (url: string) => {
      if (found || s.proc !== proc) return;
      found = true;
      clearInterval(poll);
      this.setState(s, { preview: { url, frameBlocked: false } });
      // Until the page answers for real (every 5 s, for 3 minutes): a cold Nuxt/Next compile takes a while.
      const probe = async () => {
        for (let i = 0; i < 36 && s.proc === proc; i++) {
          const frameBlocked = await probeFrameBlocked(url);
          if (frameBlocked !== null) {
            if (frameBlocked && s.proc === proc)
              this.setState(s, { preview: { url, frameBlocked } });
            return;
          }
          await new Promise((r) => setTimeout(r, 5_000).unref());
        }
      };
      void probe();
    };
    return (data) => {
      if (found) return;
      const url = watcher.feed(data);
      if (url) settle(url);
    };
  }

  /** Starts the agent of a kept session again, continuing its conversation. */
  private revive(s: Live): void {
    const spec = s.spec;
    if (!spec || s.ended)
      throw new CockpitHostError('session_exited', 'The session has ended.', 409);
    if (!existsSync(spec.cwd)) {
      throw new CockpitHostError(
        'session_exited',
        'The folder of this session is gone, so it cannot continue. Start a new one.',
        409,
      );
    }
    this.checkCapacity();
    const spawned = this.spawn(
      {
        cwd: spec.cwd,
        wsId: spec.wsId,
        kind: spec.kind,
        cols: s.info.cols,
        rows: s.info.rows,
        model: spec.model,
        execModel: spec.execModel,
        execEffort: spec.execEffort,
        execSwitch: spec.execSwitch,
      },
      { id: spec.resumeId, mode: spec.mode },
    );
    const { restorable: _r, ...rest } = s.info;
    s.info = { ...rest, state: 'idle', waiting: false, exitCode: null };
    this.wire(s, spawned);
    this.persist(s);
    this.emit(s, { t: 'state', session: s.info });
    this.log.info({ id: s.info.id, kind: spec.kind }, 'cockpit session resumed');
  }

  list(): CockpitSession[] {
    return [...this.sessions.values()].map((s) => s.info).sort((a, b) => a.startedAt - b.startedAt);
  }

  private live(id: string): Live {
    const s = this.sessions.get(id);
    if (!s) throw new CockpitHostError('session_not_found', 'Unknown session.', 404);
    return s;
  }

  input(id: string, data: string): void {
    const s = this.live(id);
    if (!s.proc) this.revive(s);
    const proc = s.proc!;
    s.bytesSinceInput = 0;
    // A conversation decides for itself: a mode change, for one, is not the user answering.
    if (s.info.waiting && !isConversation(proc)) {
      this.setState(s, { waiting: false });
    }
    proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.live(id);
    s.proc?.resize?.(cols, rows);
    s.info = { ...s.info, cols, rows };
  }

  /** The user ends the session: its process stops and nothing of it is kept. */
  kill(id: string): void {
    const s = this.live(id);
    if (s.spec && !s.ended) {
      s.ended = true;
      this.store?.remove(id);
      if (s.info.restorable) s.info = { ...s.info, restorable: false };
    }
    if (!s.proc) {
      this.emit(s, { t: 'exit', exitCode: s.info.exitCode });
      this.sessions.delete(id);
      return;
    }
    stopProcess(s.proc);
  }

  /** Replay from `since`, then live events until `detach`. */
  attach(id: string, since: number, listener: (e: SessionEvent) => void): () => void {
    const s = this.live(id);
    let r = s.ring.since(since);
    // The ring dropped its start, but a kept session has every event on disk.
    if (r.reset && s.spec && !s.ended && this.store) {
      const all = this.store.readEvents(id);
      if (all.length === s.ring.end) {
        r = { data: all.slice(since), reset: false, from: since };
      }
    }
    if (r.reset) listener({ t: 'reset', offset: r.from });
    if (r.data) listener({ t: 'data', data: r.data, offset: r.from });
    listener({ t: 'state', session: s.info });
    if (s.info.state === 'exited' && !s.info.restorable)
      listener({ t: 'exit', exitCode: s.info.exitCode });
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

  /** The host shuts down: processes stop, kept sessions stay on disk. */
  close(): void {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) {
      if (s.proc) stopProcess(s.proc);
    }
  }
}

// ───────────────────────────── flutter devices ─────────────────────────────

const flutterCmd = (cwd: string): { file: string; pre: string[] } =>
  existsSync(join(cwd, '.fvmrc')) || existsSync(join(cwd, '.fvm'))
    ? { file: 'fvm', pre: ['flutter'] }
    : { file: 'flutter', pre: [] };

function run(cwd: string, file: string, args: string[], timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const l = launchSpec(file, args);
    execFile(
      l.file,
      l.args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: sessionEnv(),
        windowsVerbatimArguments: l.windowsVerbatimArguments,
        windowsHide: true,
      },
      (err, out) =>
        err
          ? reject(new CockpitHostError('flutter_failed', `${file} ${args.join(' ')} failed`))
          : resolve(out),
    );
  });
}

/** `flutter devices --machine` JSON → devices. Pure; exported for tests. */
export function parseDevices(json: string): FlutterDevice[] {
  const start = json.indexOf('[');
  const raw = JSON.parse(start >= 0 ? json.slice(start) : json) as {
    id?: unknown;
    name?: unknown;
    targetPlatform?: unknown;
    emulator?: unknown;
  }[];
  return raw
    .filter((d) => typeof d.id === 'string')
    .map((d) => ({
      id: d.id as string,
      name: typeof d.name === 'string' ? d.name : (d.id as string),
      platform: typeof d.targetPlatform === 'string' ? d.targetPlatform : 'unknown',
      emulator: d.emulator === true,
      source: 'device' as const,
    }));
}

/** `flutter emulators` (text: `id • name • manufacturer • platform`) → bootable emulators. Pure. */
export function parseEmulators(text: string): FlutterDevice[] {
  const out: FlutterDevice[] = [];
  for (const line of text.split('\n')) {
    const parts = line.split('•').map((s) => s.trim());
    if (parts.length < 4 || !parts[0] || parts[0].toLowerCase() === 'id') continue;
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(parts[0])) continue;
    out.push({
      id: parts[0],
      name: parts[1] || parts[0],
      platform: parts[3] || 'android',
      emulator: true,
      source: 'emulator',
    });
  }
  return out;
}

export async function flutterDevices(cwd: string): Promise<FlutterDevice[]> {
  const f = flutterCmd(cwd);
  const [devices, emulators] = await Promise.all([
    run(cwd, f.file, [...f.pre, 'devices', '--machine'])
      .then(parseDevices)
      .catch(() => [] as FlutterDevice[]),
    run(cwd, f.file, [...f.pre, 'emulators'])
      .then(parseEmulators)
      .catch(() => [] as FlutterDevice[]),
  ]);
  const running = new Set(devices.map((d) => d.name));
  return [...devices, ...emulators.filter((e) => !running.has(e.name))];
}

export function launchEmulator(cwd: string, emulatorId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(emulatorId)) {
    throw new CockpitHostError('validation', 'invalid emulator id', 422);
  }
  const f = flutterCmd(cwd);
  const l = launchSpec(f.file, [...f.pre, 'emulators', '--launch', emulatorId]);
  const child = spawn(l.file, l.args, {
    windowsVerbatimArguments: l.windowsVerbatimArguments,
    cwd,
    env: sessionEnv(),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}
