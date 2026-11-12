import type { Logger } from '../util/logger';
import {
  GitExec,
  GitExecError,
  httpBaseUrl,
  redactSecrets,
  validateCommand,
  type AllowedCommand,
  type GitExecDeps,
  type GitExecErrorCode,
  type GitExecOptions,
  type GitExecResult,
  type GitExecStreamOptions,
} from '../services/gitExec';
import type { PtyAvailability, PtyBackend, PtyProcess, SpawnVuInput } from '../services/ptyBackend';
import {
  AGENT_PROTOCOL,
  readNdjson,
  type AgentHealth,
  type ExecEvent,
  type ExecRequest,
  type PtyEvent,
  type PtyStartRequest,
} from './protocol';

/**
 * The dashboard's side of the host agent (see protocol.ts). `RemoteGitExec` and `RemotePtyBackend` stand in for the
 * local `GitExec` and `LocalPtyBackend`: same calls, same errors, but the process runs on the Mac. The clones live on the
 * Mac's disk, mounted into the container at the same path, so file reads (pubspec, entrypoints, the APK) stay local.
 */

const HEALTH_EVERY_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

export interface HostAgentClientOptions {
  /** e.g. `http://host.docker.internal:3002`. */
  url: string;
  token: string;
  log: Logger;
}

export class HostAgentClient {
  private health: AgentHealth | null = null;
  private healthError = 'not contacted yet';
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly o: HostAgentClientOptions) {
    this.timer = setInterval(() => void this.refreshHealth(), HEALTH_EVERY_MS);
    this.timer.unref();
    void this.refreshHealth();
  }

  get url(): string {
    return this.o.url;
  }

  /** The last health answer, or why there is none. Never blocks. */
  lastHealth(): { health: AgentHealth | null; error: string } {
    return { health: this.health, error: this.healthError };
  }

  async refreshHealth(): Promise<void> {
    try {
      const res = await fetch(`${this.o.url}/v1/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const health = (await res.json()) as AgentHealth;
      if (health.protocol !== AGENT_PROTOCOL) {
        throw new Error(
          `protocol ${health.protocol}, expected ${AGENT_PROTOCOL}: restart pnpm agent`,
        );
      }
      if (!this.health)
        this.o.log.info({ url: this.o.url, flutter: health.flutter }, 'host agent reachable');
      this.health = health;
      this.healthError = '';
    } catch (e) {
      if (this.health || this.healthError === 'not contacted yet') {
        this.o.log.warn(
          { url: this.o.url, reason: (e as Error).message },
          'host agent unreachable',
        );
      }
      this.health = null;
      this.healthError = (e as Error).message;
    }
  }

  /** POSTs and yields the NDJSON events. Throws on a refusal (4xx/5xx) or when the agent cannot be reached. */
  async *events<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
    let res: Response;
    try {
      res = await fetch(`${this.o.url}${path}`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new AgentUnreachableError(this.o.url, (e as Error).message);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new AgentRefusedError(res.status, detail);
    }
    yield* readNdjson<T>(res.body as unknown as AsyncIterable<Uint8Array>);
  }

  async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.o.url}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new AgentRefusedError(res.status, await res.text().catch(() => ''));
  }

  /** JSON request/response (cockpit routes). Throws `AgentRefusedError` with the agent's `{ error, code }` body. */
  async json<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.o.url}${path}`, {
        method,
        headers: {
          ...this.headers(),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AgentUnreachableError(this.o.url, (e as Error).message);
    }
    if (!res.ok) throw new AgentRefusedError(res.status, await res.text().catch(() => ''));
    return (await res.json()) as T;
  }

  /** Raw streaming GET (NDJSON). */
  async stream(path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    let res: Response;
    try {
      res = await fetch(`${this.o.url}${path}`, { headers: this.headers(), signal });
    } catch (e) {
      throw new AgentUnreachableError(this.o.url, (e as Error).message);
    }
    if (!res.ok || !res.body)
      throw new AgentRefusedError(res.status, await res.text().catch(() => ''));
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }

  /** Binary GET (a screenshot). */
  async bytes(path: string, timeoutMs: number): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(`${this.o.url}${path}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AgentUnreachableError(this.o.url, (e as Error).message);
    }
    if (!res.ok) throw new AgentRefusedError(res.status, await res.text().catch(() => ''));
    return Buffer.from(await res.arrayBuffer());
  }

  close(): void {
    clearInterval(this.timer);
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.o.token}` };
  }
}

/** The release scripts' env file, written on the Mac by the host agent. */
export class RemoteScriptEnvWriter {
  readonly path = '~/.config/relay/scripts.env (on the Mac)';
  constructor(private readonly agent: HostAgentClient) {}
  async write(content: string): Promise<void> {
    await this.agent.json<{ path: string }>('PUT', '/v1/scripts/env', { content }, 10_000);
  }
}

export class AgentUnreachableError extends Error {
  constructor(url: string, reason: string) {
    super(
      `The host agent at ${url} cannot be reached (${reason}). Is \`pnpm agent\` running on the Mac?`,
    );
    this.name = 'AgentUnreachableError';
  }
}

export class AgentRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`The host agent refused the request (HTTP ${status}): ${detail.slice(0, 300)}`);
    this.name = 'AgentRefusedError';
  }
}

// ───────────────────────────── git / flutter ─────────────────────────────

export interface RemoteGitExecDeps extends GitExecDeps {
  client: HostAgentClient;
}

export class RemoteGitExec extends GitExec {
  private readonly client: HostAgentClient;
  private readonly repoAuth: GitExecDeps['auth'];

  constructor(deps: RemoteGitExecDeps) {
    super(deps);
    this.client = deps.client;
    this.repoAuth = deps.auth;
  }

  override run(
    repoId: string,
    command: AllowedCommand,
    args: readonly string[],
    opts: GitExecOptions = {},
  ): Promise<GitExecResult> {
    return this.remote(repoId, command, args, {
      mode: 'run',
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.allowFailure ? { allowFailure: true } : {}),
      env: opts.env ?? {},
      secrets: opts.secrets ?? [],
      signal: opts.signal,
    });
  }

  override stream(
    repoId: string,
    command: AllowedCommand,
    args: readonly string[],
    opts: GitExecStreamOptions,
  ): Promise<GitExecResult> {
    return this.remote(repoId, command, args, {
      mode: 'stream',
      timeoutMs: opts.timeoutMs,
      env: opts.env ?? {},
      secrets: opts.secrets ?? [],
      signal: opts.signal,
      onLine: opts.onLine,
    });
  }

  private async remote(
    repoId: string,
    command: AllowedCommand,
    args: readonly string[],
    o: {
      mode: 'run' | 'stream';
      timeoutMs: number;
      allowFailure?: boolean;
      env: Readonly<Record<string, string>>;
      secrets: readonly string[];
      signal: AbortSignal | undefined;
      onLine?: GitExecStreamOptions['onLine'];
    },
  ): Promise<GitExecResult> {
    // Refused here too, so a bad call fails the same way with or without the agent.
    validateCommand(command, args);
    const auth = this.authFor(repoId, command);
    const secrets = [...o.secrets, ...auth.secrets];
    const display = redactSecrets([command, ...args].join(' '), secrets);
    if (o.signal?.aborted) throw new GitExecError('cancelled', `${display} was cancelled`);
    const cloneUrl = this.repoAuth?.(repoId)?.cloneUrl;
    const request: ExecRequest = {
      repoId,
      command,
      args: [...args],
      mode: o.mode,
      timeoutMs: o.timeoutMs,
      ...(o.allowFailure ? { allowFailure: true } : {}),
      env: { ...o.env, ...auth.env },
      secrets,
      remoteBase: cloneUrl ? httpBaseUrl(cloneUrl) : null,
    };
    try {
      for await (const event of this.client.events<ExecEvent>('/v1/exec', request, o.signal)) {
        if (event.t === 'line') o.onLine?.(redactSecrets(event.line, secrets), event.stream);
        else if (event.t === 'result') return event.result;
        else if (event.t === 'error') {
          throw new GitExecError(
            event.code as GitExecErrorCode,
            redactSecrets(event.message, secrets),
            event.result,
          );
        }
      }
    } catch (e) {
      if (e instanceof GitExecError) throw e;
      if (o.signal?.aborted) throw new GitExecError('cancelled', `${display} was cancelled`);
      throw new GitExecError('spawn_failed', `${display} could not run: ${(e as Error).message}`);
    }
    if (o.signal?.aborted) throw new GitExecError('cancelled', `${display} was cancelled`);
    throw new GitExecError('spawn_failed', `${display}: the host agent stopped answering`);
  }
}

// ───────────────────────────── PTY ─────────────────────────────

export class RemotePtyBackend implements PtyBackend {
  constructor(
    private readonly client: HostAgentClient,
    private readonly repoUrl: (repoId: string) => string | null,
  ) {}

  availability(): PtyAvailability {
    const { health, error } = this.client.lastHealth();
    if (!health) {
      return {
        available: false,
        reason: `the host agent at ${this.client.url} is not reachable (${error}); run pnpm agent on the Mac`,
      };
    }
    return health.pty.available
      ? health.pty
      : { available: false, reason: `on the Mac: ${health.pty.reason ?? 'unavailable'}` };
  }

  /** Resolves once vu is running on the Mac. Output and exit then arrive through the returned process. */
  async spawnVu(input: SpawnVuInput): Promise<PtyProcess> {
    const cloneUrl = this.repoUrl(input.repoId);
    const request: PtyStartRequest = {
      repoId: input.repoId,
      args: input.args,
      env: input.env,
      secrets: input.secrets,
      remoteBase: cloneUrl ? httpBaseUrl(cloneUrl) : null,
    };
    const abort = new AbortController();
    const events = this.client.events<PtyEvent>('/v1/pty', request, abort.signal);
    const first = await events.next();
    if (first.done || first.value.t !== 'started') {
      abort.abort();
      throw new Error(
        first.done
          ? 'the host agent ended the run before vu started'
          : 'unexpected answer from the host agent',
      );
    }
    const { id, pid } = first.value;
    const proc = new RemotePtyProcess(this.client, id, pid);
    void proc.pump(events, abort);
    return proc;
  }
}

class RemotePtyProcess implements PtyProcess {
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  /** What arrived before a listener was attached. */
  private pendingData: string[] = [];
  private exited: { exitCode: number; signal?: number } | null = null;

  constructor(
    private readonly client: HostAgentClient,
    private readonly id: string,
    readonly pid: number,
  ) {}

  async pump(events: AsyncGenerator<PtyEvent>, abort: AbortController): Promise<void> {
    try {
      for await (const event of events) {
        if (event.t === 'data') this.emitData(event.data);
        else if (event.t === 'exit') {
          return this.emitExit(
            event.signal === undefined
              ? { exitCode: event.exitCode }
              : { exitCode: event.exitCode, signal: event.signal },
          );
        }
      }
      this.emitData('\r\n[dashboard] The host agent ended the stream without an exit status.\r\n');
    } catch (e) {
      this.emitData(`\r\n[dashboard] Lost the host agent: ${(e as Error).message}\r\n`);
    } finally {
      abort.abort();
    }
    this.emitExit({ exitCode: 1 });
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
    for (const data of this.pendingData.splice(0)) listener(data);
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(listener);
    if (this.exited) listener(this.exited);
  }

  write(data: string): void {
    void this.client.post(`/v1/pty/${this.id}/input`, { data }).catch(() => undefined);
  }

  kill(signal?: string): void {
    this.killGroup(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
  }

  killGroup(signal: NodeJS.Signals): void {
    const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
    void this.client.post(`/v1/pty/${this.id}/kill`, { signal: sig }).catch(() => undefined);
  }

  private emitData(data: string): void {
    if (this.dataListeners.length === 0) this.pendingData.push(data);
    for (const l of this.dataListeners) l(data);
  }

  private emitExit(e: { exitCode: number; signal?: number }): void {
    if (this.exited) return;
    this.exited = e;
    for (const l of this.exitListeners) l(e);
  }
}
