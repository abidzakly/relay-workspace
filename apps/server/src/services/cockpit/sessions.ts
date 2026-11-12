import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  POSTRACK_MCP_NAME,
  POSTRACK_READ_TOOLS,
  POSTRACK_WRITE_TOOLS,
  type PostrackToolsProfile,
  type RunTargets,
  type SessionKind,
  type TestRunProfile,
} from '@relay/shared';
import type { Logger } from '../../util/logger';
import { listEntrypoints } from '../flutterBuild';
import { loadNodePty, type NodePtyModule, type NodePtyProcess } from '../ptyBackend';
import { CLAUDE_BIN, CLAUDE_SESSION_MODEL } from './claudeCli';
import { ClaudeConversation } from './claudeConversation';
import { CURSOR_BIN, CURSOR_MODEL } from './cursorCli';
import { CockpitHostError } from './host';
import { defaultShell, launchSpec, signalTree, which } from '../../util/platform';

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
  /** `claude`, not a device test: the Postrack tools, proxied through Relay with this session's token. */
  postrack?: PostrackToolsProfile | undefined;
  /** Resolved `flutter` target. Required for that kind; the host fills it before `start`. */
  flutter?: { flavor: string | null; mode: FlutterRunMode; ios: boolean } | undefined;
  /** Model the session starts on (planning). Unset = `CLAUDE_SESSION_MODEL` / `CURSOR_MODEL`. */
  model?: string | undefined;
  /** `claude`: switched to (with effort) when a plan is approved. */
  execModel?: string | undefined;
  execEffort?: AgentEffort | undefined;
  execSwitch?: 'ask' | 'auto' | undefined;
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

/**
 * The MCP config of a plain Claude session with Postrack (0600, in the OS temp dir): one stdio server, this repo's
 * proxy, which calls Relay with the session's token. Passed without `--strict-mcp-config`, so the user's own MCP
 * servers stay available. No Postrack credential is in it.
 */
export function writePostrackMcpConfig(p: PostrackToolsProfile): string {
  const serverRoot = serverPackageRoot();
  const file = join(tmpdir(), `cockpit-postrack-${randomUUID()}.json`);
  const servers = {
    [POSTRACK_MCP_NAME]: {
      command: join(serverRoot, 'node_modules', '.bin', 'tsx'),
      args: [join(serverRoot, 'src', 'agentTools', 'postrackMcp.ts')],
      env: { POSTRACK_RELAY_URL: p.url, POSTRACK_SESSION_TOKEN: p.token },
    },
  };
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return file;
}

/**
 * Flags for a Claude session with Postrack. Reads never ask (they change nothing). Writes are never pre-approved:
 * without "Agent may update Postrack" they are blocked here and hidden by Relay; with it, each call asks the user.
 */
export function postrackArgs(config: string, write: boolean): string[] {
  const tool = (n: string) => `mcp__${POSTRACK_MCP_NAME}__${n}`;
  return [
    '--mcp-config',
    config,
    '--allowedTools',
    ...POSTRACK_READ_TOOLS.map(tool),
    ...(write ? [] : ['--disallowedTools', ...POSTRACK_WRITE_TOOLS.map(tool)]),
  ];
}

function testRunMcpServers(t: TestRunProfile): Record<string, unknown> {
  const serverRoot = serverPackageRoot();
  const tsx = join(serverRoot, 'node_modules', '.bin', 'tsx');
  const script = join(serverRoot, 'src', 'agentTools', 'benchMcp.ts');
  const servers: Record<string, unknown> = {
    bench: {
      command: tsx,
      args: [script],
      env: { BENCH_URL: t.benchUrl, BENCH_TOKEN: t.token, BENCH_RUN: t.runId },
    },
  };
  const marionette = whichSync('marionette_mcp');
  if (marionette) servers.marionette = { command: marionette, args: [] };
  return servers;
}

/** `apps/server`, found from this module whether it runs from `src/` (tsx) or the `dist/` bundle. */
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
  const pub = join(homedir(), '.pub-cache', 'bin', bin);
  return existsSync(pub) ? pub : null;
}

/**
 * Which program a kind runs. Pure; exported for tests. Agents start in plan mode: nothing is edited until the user
 * approves a plan in the session. Claude runs as a `ClaudeConversation` (a document with its own approval channel);
 * Cursor stays in its TUI, because headless it approves its own way out of plan mode and has no approval channel.
 */
export function commandFor(
  kind: SessionKind,
  cwd: string,
  deviceId: string | undefined,
  shell = process.env.SHELL || defaultShell().file,
  testRunMcpConfig?: string,
  flutter?: { flavor: string | null; mode: FlutterRunMode; ios: boolean },
  cursorTestModel?: CursorTestModel,
  /** The model a plain agent session starts on (planning). */
  agentModel?: string,
  /** A plain Claude session with the Postrack tools: its MCP config file and whether writes are allowed. */
  postrack?: { config: string; write: boolean },
): { file: string; args: string[]; title: string } {
  switch (kind) {
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
          ...(postrack ? postrackArgs(postrack.config, postrack.write) : []),
        ],
        title: 'Claude',
      };
    case 'cursor':
      if (cursorTestModel) {
        // Normal mode, not plan: the tester must call the bench tools without a human approving a plan. `--force` is
        // not passed, so shell and edit calls still wait for approval.
        return {
          file: CURSOR_BIN,
          args: ['--model', cursorTestModel, '--approve-mcps', '--trust'],
          title: 'Cursor · device test',
        };
      }
      return {
        file: CURSOR_BIN,
        args: ['--mode', 'plan', '--model', agentModel ?? CURSOR_MODEL],
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

function stopProcess(proc: NodePtyProcess): void {
  if (proc instanceof ClaudeConversation) {
    proc.kill();
    return;
  }
  signalTree(proc.pid, 'SIGTERM', () => proc.kill('SIGTERM'));
}

export class SessionManager {
  private readonly pty: NodePtyModule | null;
  private readonly sessions = new Map<string, Live>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    pty?: NodePtyModule | null,
  ) {
    this.pty = pty === undefined ? loadNodePty(log) : pty;
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref();
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
    this.emit(s, { t: 'state', session: s.info });
  }

  /** Idle detection + pruning of long-exited sessions. */
  private tick(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      if (s.info.state === 'exited') {
        if (now - (s.info.lastOutputAt ?? s.info.startedAt) > EXITED_TTL_MS)
          this.sessions.delete(id);
        continue;
      }
      // A conversation reports its own state; a long silent tool call is not "finished".
      if (s.proc instanceof ClaudeConversation) continue;
      const quiet = s.info.lastOutputAt !== null && now - s.info.lastOutputAt >= IDLE_MS;
      if (quiet && s.info.state === 'running') {
        const agent = s.info.kind === 'claude' || s.info.kind === 'cursor';
        this.setState(s, { state: 'idle', waiting: agent && s.bytesSinceInput >= MIN_BURST });
      }
    }
  }

  start(i: StartInput): CockpitSession {
    if (!this.pty && i.kind !== 'claude')
      throw new CockpitHostError('pty_unavailable', 'node-pty is not installed on the host.', 409);
    const alive = [...this.sessions.values()].filter((s) => s.info.state !== 'exited').length;
    if (alive >= MAX_SESSIONS)
      throw new CockpitHostError('too_many_sessions', 'Too many sessions: close one first.', 409);
    if (i.testRun && i.kind !== 'claude' && i.kind !== 'cursor') {
      throw new CockpitHostError(
        'validation',
        'A device test runs in a Claude or Cursor session.',
        422,
      );
    }
    const cursorTest = i.testRun && i.kind === 'cursor' ? i.testRun : null;
    const mcpConfig =
      i.testRun && i.kind === 'claude' ? writeTestRunMcpConfig(i.testRun) : undefined;
    // Postrack is for coding sessions; a device test keeps its own strict tool set.
    const postrackConfig =
      i.postrack && i.kind === 'claude' && !i.testRun
        ? writePostrackMcpConfig(i.postrack)
        : undefined;
    const cmd = commandFor(
      i.kind,
      i.cwd,
      i.deviceId,
      undefined,
      mcpConfig,
      i.flutter,
      cursorTest?.cursorModel,
      i.model,
      postrackConfig && i.postrack
        ? { config: postrackConfig, write: i.postrack.write }
        : undefined,
    );
    const cwd = cursorTest ? writeCursorTestRunDir(cursorTest) : i.cwd;
    let proc: NodePtyProcess;
    try {
      proc =
        i.kind === 'claude'
          ? new ClaudeConversation({
              file: cmd.file,
              args: cmd.args,
              cwd: i.cwd,
              env: sessionEnv(),
              ...(i.model ? { model: i.model } : {}),
              ...(i.execModel ? { execModel: i.execModel } : {}),
              ...(i.execEffort ? { execEffort: i.execEffort } : {}),
              ...(i.execSwitch ? { execSwitch: i.execSwitch } : {}),
            })
          : this.pty!.spawn(cmd.file, cmd.args, {
              name: 'xterm-256color',
              cols: i.cols,
              rows: i.rows,
              cwd,
              env: sessionEnv(),
            });
    } catch (e) {
      if (cursorTest) rmSync(cwd, { recursive: true, force: true });
      if (mcpConfig) rmSync(mcpConfig, { force: true });
      if (postrackConfig) rmSync(postrackConfig, { force: true });
      throw new CockpitHostError(
        'spawn_failed',
        `${cmd.file} could not start: ${(e as Error).message}`,
        409,
      );
    }
    const id = randomUUID();
    const s: Live = {
      info: {
        id,
        workspaceId: i.wsId,
        kind: i.kind,
        title: cmd.title,
        state: i.kind === 'claude' ? 'idle' : 'running',
        waiting: false,
        exitCode: null,
        startedAt: this.now(),
        lastOutputAt: null,
        cols: i.cols,
        rows: i.rows,
      },
      proc,
      ring: new RingBuffer(),
      listeners: new Set(),
      bytesSinceInput: 0,
    };
    this.sessions.set(id, s);
    if (proc instanceof ClaudeConversation) {
      proc.onStatus(({ working, waiting }) =>
        this.setState(s, { state: working ? 'running' : 'idle', waiting }),
      );
    }
    proc.onData((data) => {
      const offset = s.ring.append(data);
      s.bytesSinceInput += data.length;
      const wasIdle = s.info.state !== 'running';
      s.info = { ...s.info, lastOutputAt: this.now() };
      this.emit(s, { t: 'data', data, offset });
      if (wasIdle && !(proc instanceof ClaudeConversation)) {
        this.setState(s, { state: 'running', waiting: false });
      }
    });
    proc.onExit(({ exitCode }) => {
      s.proc = null;
      // The run token in the Cursor test dir dies with the session.
      if (cursorTest) rmSync(cwd, { recursive: true, force: true });
      // So does the Claude one's MCP config, and the Postrack one (its token dies with the session in Relay too).
      if (mcpConfig) rmSync(mcpConfig, { force: true });
      if (postrackConfig) rmSync(postrackConfig, { force: true });
      this.setState(s, { state: 'exited', waiting: false, exitCode, lastOutputAt: this.now() });
      this.emit(s, { t: 'exit', exitCode });
    });
    this.log.info({ id, kind: i.kind, ws: i.wsId }, 'cockpit session started');
    return s.info;
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
    if (!s.proc) throw new CockpitHostError('session_exited', 'The session has ended.', 409);
    s.bytesSinceInput = 0;
    // A conversation decides for itself: a mode change, for one, is not the user answering.
    if (s.info.waiting && !(s.proc instanceof ClaudeConversation)) {
      this.setState(s, { waiting: false });
    }
    s.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.live(id);
    s.proc?.resize?.(cols, rows);
    s.info = { ...s.info, cols, rows };
  }

  kill(id: string): void {
    const s = this.live(id);
    if (!s.proc) {
      this.sessions.delete(id);
      return;
    }
    stopProcess(s.proc);
  }

  /** Replay from `since`, then live events until `detach`. */
  attach(id: string, since: number, listener: (e: SessionEvent) => void): () => void {
    const s = this.live(id);
    const r = s.ring.since(since);
    if (r.reset) listener({ t: 'reset', offset: r.from });
    if (r.data) listener({ t: 'data', data: r.data, offset: r.from });
    listener({ t: 'state', session: s.info });
    if (s.info.state === 'exited') listener({ t: 'exit', exitCode: s.info.exitCode });
    s.listeners.add(listener);
    return () => s.listeners.delete(listener);
  }

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
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: sessionEnv() },
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
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}
