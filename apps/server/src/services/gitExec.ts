import { execFile, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FLAVOR_RE, isSafeBranchName, REPO_ID_RE } from '@relay/shared';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { launchSpec, signalTree } from '../util/platform';

/**
 * The only way this server runs a command: `execFile` (no shell), allowlisted programs, cwd locked to one
 * repo's bot clone, validated args, a timeout, captured and redacted output.
 */

export const ALLOWED_COMMANDS = ['git', 'flutter', 'fvm'] as const;
export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export type GitExecErrorCode =
  | 'command_not_allowed'
  | 'invalid_arg'
  | 'invalid_repo_id'
  | 'cwd_not_allowed'
  | 'spawn_failed'
  | 'timeout'
  | 'cancelled'
  | 'output_too_large'
  | 'command_failed';

export class GitExecError extends ActionError {
  constructor(
    code: GitExecErrorCode,
    /** Redacted before it gets here. */
    message: string,
    readonly result?: GitExecResult,
  ) {
    super(500, code, message);
    this.name = 'GitExecError';
  }
}

export interface GitExecResult {
  /** Redacted. */
  command: string;
  /** Redacted. */
  stdout: string;
  /** Redacted. */
  stderr: string;
  /** Null when killed by a signal or never started. */
  exitCode: number | null;
  durationMs: number;
}

export interface GitExecOptions {
  /** Default 2 minutes. */
  timeoutMs?: number;
  /** Extra literal values to redact from output and errors (a token just used, for example). */
  secrets?: readonly string[];
  /** A non-zero exit is returned rather than thrown (timeouts and spawn failures still throw). */
  allowFailure?: boolean;
  /** Aborting kills the command (SIGTERM, like a timeout) and fails the call with `cancelled`. */
  signal?: AbortSignal;
  /** Added to `childEnv` for this one process, as in `GitExecStreamOptions`. */
  env?: Readonly<Record<string, string>>;
}

/** `run`'s output is buffered until the end. A build's must arrive as it is written, and may be far larger. */
export interface GitExecStreamOptions {
  timeoutMs: number;
  /** Aborting kills the whole process group and fails the call with `cancelled`. */
  signal?: AbortSignal;
  /** Extra literal values to redact from output and errors. */
  secrets?: readonly string[];
  /**
   * Added to `childEnv` for this one process: the only way a secret-named variable reaches a child. The caller also puts
   * each value in `secrets`. Values are never logged, and are not part of `command`.
   */
  env?: Readonly<Record<string, string>>;
  /** One redacted line of output, without its line ending. A `\r` ends a line too (progress output). */
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
}

/** What `gitAuthEnv` needs: the repo's clone URL and its GitLab token. */
export interface GitAuth {
  cloneUrl: string;
  token: string | null;
}

export interface GitExecDeps {
  /** Default `~/.relay/clones`. */
  clonesRoot?: string;
  log?: Logger;
  /** The repo's token for an https clone URL. Without it, git uses whatever auth the environment has (ssh-agent). */
  auth?: (repoId: string) => GitAuth | null;
}

/**
 * Hands git a GitLab token for an http(s) clone URL, through the environment (`GIT_CONFIG_*`, git ≥ 2.31): never on a
 * command line, never in `.git/config`. The header is scoped to the clone URL's host, so it reaches no other server.
 * GitLab takes a personal access token as the Basic password with any user name. An ssh URL gets nothing.
 * `secrets` holds every form of the token the output could show.
 */
export function gitAuthEnv(
  cloneUrl: string,
  token: string | null | undefined,
): { env: Record<string, string>; secrets: string[] } {
  if (!token) return { env: {}, secrets: [] };
  const base = httpBaseUrl(cloneUrl);
  if (!base) return { env: {}, secrets: [] };
  const basic = Buffer.from(`oauth2:${token}`).toString('base64');
  return {
    env: appendGitConfig({}, `http.${base}.extraHeader`, `Authorization: Basic ${basic}`),
    secrets: [token, basic],
  };
}

/** `https://host[:port]/` of an http(s) URL, or null for anything else (ssh, scp-style, a path). */
export function httpBaseUrl(cloneUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.protocol}//${url.host}/`;
}

/** A copy of `env` with one more `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pair, after the ones it already has. */
export function appendGitConfig(
  env: Readonly<Record<string, string>>,
  key: string,
  value: string,
): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: value,
  };
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const ERROR_TAIL_CHARS = 1000;
/** What a streamed result keeps of each stream: the lines have gone to `onLine`. */
const STREAM_TAIL_CHARS = 64 * 1024;
/** A line longer than this is passed on in pieces. */
const STREAM_LINE_MAX_CHARS = 64 * 1024;
const KILL_GRACE_MS = 5_000;
/** A process left behind (a Gradle daemon, say) can hold the pipes open long after the command has exited. */
const DRAIN_AFTER_EXIT_MS = 2_000;

export const defaultClonesRoot = () => join(homedir(), '.relay', 'clones');

/** `~/.relay/clones/<repoId>`. The id is validated, so it cannot leave the root. */
export function resolveClonePath(repoId: string, clonesRoot = defaultClonesRoot()): string {
  if (!REPO_ID_RE.test(repoId)) throw new GitExecError('invalid_repo_id', 'Invalid repository id');
  return join(clonesRoot, repoId);
}

// ───────────────────────────── Redaction ─────────────────────────────

const REDACTED = '[REDACTED]';
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // Credentials in a URL (keeps scheme and host).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\b(?:glpat|gldt|glrt|gloas)-[A-Za-z0-9_.-]{8,}/g, REDACTED],
  [/\b(?:ntn|secret)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\b(authorization:\s*)\S+(?:\s+\S+)?/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)\S+/gi, `$1${REDACTED}`],
  [/\b(private-token:\s*)\S+/gi, `$1${REDACTED}`],
];

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.replaceAll(secret, REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// ───────────────────────────── Argument validation ─────────────────────────────

/** Subcommands the release and clone flows use. Anything that runs other programs (`rebase`, `diff`, …) is absent. */
const GIT_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'checkout',
  'clean',
  'clone',
  'commit',
  'config',
  'fetch',
  'ls-remote',
  'merge',
  'push',
  'reset',
  'rev-parse',
  'show-ref',
  'status',
  'symbolic-ref',
  'tag',
]);

/** Options that run a program, or point git at another directory. Git accepts abbreviations, so those are refused too. */
const GIT_DENIED_OPTIONS = [
  '--config',
  '--exec',
  '--git-dir',
  '--receive-pack',
  '--reference',
  '--reference-if-able',
  '--separate-git-dir',
  '--template',
  '--upload-pack',
  '--work-tree',
];
const GIT_PUSH_DENIED_OPTIONS = [
  '--force',
  '--force-if-includes',
  '--force-with-lease',
  '--mirror',
];
/** The only config this server reads or writes: `core.sshCommand` and friends would run a program. */
const GIT_CONFIG_READ_KEYS = new Set(['remote.origin.url']);
const GIT_CONFIG_WRITE_KEYS = new Set(['user.name', 'user.email']);
const GIT_ORIGIN_ONLY = new Set(['fetch', 'ls-remote', 'push']);
/** `ext::sh -c …` and other remote helpers. */
const TRANSPORT_HELPER_RE = /^[A-Za-z0-9+.-]+::/;
const FLUTTER_ARG_RE = /^[A-Za-z0-9._/=:@+-]+$/;
const FLUTTER_FIRST_ARGS = new Set(['build', 'clean', 'pub', '--version']);

function invalid(message: string): GitExecError {
  return new GitExecError('invalid_arg', message);
}

function isDenied(arg: string, denied: readonly string[]): boolean {
  if (!arg.startsWith('--') || arg === '--') return false;
  const name = arg.split('=', 1)[0] ?? arg;
  return denied.some((option) => option.startsWith(name));
}

function validateGitArgs(args: readonly string[]): void {
  const [subcommand] = args;
  if (subcommand === undefined || !GIT_SUBCOMMANDS.has(subcommand)) {
    // This also refuses anything before the subcommand (`-c`, `-C`, `--git-dir`).
    throw invalid('This git subcommand is not allowed');
  }
  const rest = args.slice(1);
  const endOfOptions = rest.indexOf('--');
  const options = (endOfOptions === -1 ? rest : rest.slice(0, endOfOptions)).filter((a) =>
    a.startsWith('-'),
  );
  const positional = rest.filter(
    (a, i) => (endOfOptions !== -1 && i > endOfOptions) || !a.startsWith('-'),
  );

  for (const option of options) {
    if (isDenied(option, GIT_DENIED_OPTIONS)) throw invalid('This git option is not allowed');
  }
  for (const arg of rest) {
    if (TRANSPORT_HELPER_RE.test(arg)) throw invalid('This git transport is not allowed');
  }
  if (GIT_ORIGIN_ONLY.has(subcommand) && positional[0] !== 'origin') {
    throw invalid(`git ${subcommand} must name the origin remote`);
  }

  if (subcommand === 'clone') {
    // `-u` is --upload-pack, `-c` is --config.
    if (options.some((o) => /^-[A-Za-z]*[uc]/.test(o) && !o.startsWith('--'))) {
      throw invalid('This git option is not allowed');
    }
    // Any other target would leave the locked cwd.
    if (args.at(-1) !== '.') throw invalid('git clone must clone into the current directory');
  }
  if (subcommand === 'push') {
    const force = options.some(
      (o) => isDenied(o, GIT_PUSH_DENIED_OPTIONS) || /^-[A-Za-z]*f/.test(o),
    );
    // `+ref` forces, `:ref` deletes (deleting goes through the explicit --delete).
    if (force || positional.some((p) => p.startsWith('+') || p.startsWith(':'))) {
      throw invalid('Forced or implicit-delete pushes are not allowed');
    }
  }
  if (subcommand === 'merge') {
    // Only the QA preview's two shapes: no strategy options, no merge messages, nothing that picks a driver.
    const abort = rest.length === 1 && rest[0] === '--abort';
    const merge =
      rest.length === 3 &&
      rest[0] === '--no-ff' &&
      rest[1] === '--no-edit' &&
      (rest[2] ?? '').startsWith('origin/') &&
      isSafeBranchName((rest[2] ?? '').slice(7));
    if (!abort && !merge) throw invalid('This git merge is not allowed');
  }
  if (subcommand === 'config') {
    const [mode, key, value, ...extra] = rest;
    const read = mode === '--get' && GIT_CONFIG_READ_KEYS.has(key ?? '') && value === undefined;
    const write =
      mode === '--local' &&
      GIT_CONFIG_WRITE_KEYS.has(key ?? '') &&
      value !== undefined &&
      extra.length === 0;
    if (!read && !write) throw invalid('This git config access is not allowed');
  }
}

/**
 * `flutter build` has one shape: `build apk|appbundle -t lib/main_<flavor>.dart --flavor <flavor> --release`.
 * Anything else a build could take (`--dart-define`, `--build-name`, other targets) is refused.
 */
function validateFlutterBuildArgs(args: readonly string[]): void {
  const [, target, targetFlag, entrypoint, flavorFlag, flavor, releaseFlag] = args;
  const valid =
    args.length === 7 &&
    (target === 'apk' || target === 'appbundle') &&
    targetFlag === '-t' &&
    flavorFlag === '--flavor' &&
    FLAVOR_RE.test(flavor ?? '') &&
    entrypoint === `lib/main_${flavor}.dart` &&
    releaseFlag === '--release';
  if (!valid) throw invalid('This flutter build command is not allowed');
}

function validateFlutterArgs(args: readonly string[]): void {
  if (!FLUTTER_FIRST_ARGS.has(args[0] ?? '')) throw invalid('This flutter command is not allowed');
  for (const arg of args) {
    if (!FLUTTER_ARG_RE.test(arg) || arg.startsWith('/') || arg.split(/[/=]/).includes('..')) {
      throw invalid('Invalid flutter argument');
    }
  }
  if (args[0] === 'build') validateFlutterBuildArgs(args);
}

export function validateCommand(command: string, args: readonly string[]): void {
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
    throw new GitExecError('command_not_allowed', 'This command is not allowed');
  }
  for (const arg of args) {
    // eslint-disable-next-line no-control-regex
    if (typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg)) {
      throw invalid('Arguments must be short strings without control characters');
    }
  }
  if (command === 'git') validateGitArgs(args);
  else if (command === 'flutter') validateFlutterArgs(args);
  else {
    if (args[0] !== 'flutter') throw invalid('fvm may only run flutter');
    validateFlutterArgs(args.slice(1));
  }
}

// ───────────────────────────── Environment ─────────────────────────────

const SECRET_ENV_RE =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY|MASTER_KEY|API_?KEY|ACCESS_KEY|NTFY_TOPIC/i;
const KEPT_GIT_ENV = new Set(['GIT_SSH', 'GIT_SSH_COMMAND']);

/**
 * Secrets of this server stay out of the child. Inherited `GIT_*` go too: `GIT_DIR` or `GIT_WORK_TREE` would point
 * git away from the locked cwd. The ceiling stops git from adopting a parent repo when `.git` is missing, so
 * `reset --hard` and `clean` can never hit one.
 */
export function childEnv(cwd: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (SECRET_ENV_RE.test(key)) continue;
    if (key.startsWith('GIT_') && !KEPT_GIT_ENV.has(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CEILING_DIRECTORIES = dirname(cwd);
  env.GIT_ALLOW_PROTOCOL = 'http:https:ssh:file';
  return env;
}

// ───────────────────────────── Runner ─────────────────────────────

export class GitExec {
  readonly clonesRoot: string;
  private readonly log: Logger | undefined;
  private readonly auth: GitExecDeps['auth'];

  constructor(deps: GitExecDeps = {}) {
    this.clonesRoot = deps.clonesRoot ?? defaultClonesRoot();
    this.log = deps.log;
    this.auth = deps.auth;
  }

  /** The token env for a git command in this repo, or nothing. */
  protected authFor(
    repoId: string,
    command: AllowedCommand,
  ): { env: Record<string, string>; secrets: string[] } {
    if (command !== 'git' || !this.auth) return { env: {}, secrets: [] };
    const auth = this.auth(repoId);
    return auth ? gitAuthEnv(auth.cloneUrl, auth.token) : { env: {}, secrets: [] };
  }

  clonePath(repoId: string): string {
    return resolveClonePath(repoId, this.clonesRoot);
  }

  /** Runs in the repo's clone directory, which must already exist as a real directory inside the root. */
  async run(
    repoId: string,
    command: AllowedCommand,
    args: readonly string[],
    opts: GitExecOptions = {},
  ): Promise<GitExecResult> {
    validateCommand(command, args);
    const cwd = await this.lockedCwd(repoId);
    const auth = this.authFor(repoId, command);
    const secrets = [...(opts.secrets ?? []), ...auth.secrets];
    const display = redactSecrets([command, ...args].join(' '), secrets);
    const started = Date.now();

    const result = await new Promise<GitExecResult>((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          env: { ...childEnv(cwd), ...opts.env, ...auth.env },
          shell: false,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          killSignal: 'SIGTERM',
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (err, stdout, stderr) => {
          const exitCode = !err ? 0 : typeof err.code === 'number' ? err.code : null;
          const out: GitExecResult = {
            command: display,
            stdout: redactSecrets(stdout, secrets),
            stderr: redactSecrets(stderr, secrets),
            exitCode,
            durationMs: Date.now() - started,
          };
          if (!err) return resolve(out);
          if (opts.signal?.aborted) {
            return reject(new GitExecError('cancelled', `${display} was cancelled`, out));
          }
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return reject(
              new GitExecError('output_too_large', `${display}: output limit reached`, out),
            );
          }
          if (exitCode !== null) {
            if (opts.allowFailure) return resolve(out);
            const detail = out.stderr.trim().slice(-ERROR_TAIL_CHARS);
            return reject(
              new GitExecError(
                'command_failed',
                `${display} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`,
                out,
              ),
            );
          }
          if (err.killed) {
            return reject(new GitExecError('timeout', `${display} timed out`, out));
          }
          reject(new GitExecError('spawn_failed', `${display} could not run`, out));
        },
      );
    });
    this.log?.debug(
      { command: result.command, exitCode: result.exitCode, durationMs: result.durationMs },
      'command finished',
    );
    return result;
  }

  /**
   * Same validation, cwd lock and redaction as `run`, for a long command: output arrives line by line, and the command
   * leads its own process group, so a timeout or abort reaches what it started (flutter -> gradle -> java). SIGTERM, then
   * SIGKILL after a grace period. A non-zero exit throws `command_failed`.
   */
  async stream(
    repoId: string,
    command: AllowedCommand,
    args: readonly string[],
    opts: GitExecStreamOptions,
  ): Promise<GitExecResult> {
    validateCommand(command, args);
    const cwd = await this.lockedCwd(repoId);
    const auth = this.authFor(repoId, command);
    const secrets = [...(opts.secrets ?? []), ...auth.secrets];
    const display = redactSecrets([command, ...args].join(' '), secrets);
    if (opts.signal?.aborted) throw new GitExecError('cancelled', `${display} was cancelled`);
    const started = Date.now();

    const result = await new Promise<GitExecResult>((resolve, reject) => {
      const l = launchSpec(command, args);
      const child = spawn(l.file, l.args, {
        windowsVerbatimArguments: l.windowsVerbatimArguments,
        cwd,
        env: { ...childEnv(cwd), ...opts.env, ...auth.env },
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const tails = { stdout: '', stderr: '' };
      const partial = { stdout: '', stderr: '' };
      const emit = (name: 'stdout' | 'stderr', raw: string) => {
        const line = redactSecrets(raw, secrets);
        tails[name] = `${tails[name]}${line}\n`.slice(-STREAM_TAIL_CHARS);
        opts.onLine(line, name);
      };
      const onData = (name: 'stdout' | 'stderr', data: string) => {
        const lines = (partial[name] + data).split(/\r\n|\n|\r/);
        // A `\r` at the very end may be half of a `\r\n`: an empty line at worst.
        partial[name] = lines.pop() ?? '';
        for (const line of lines) emit(name, line);
        if (partial[name].length > STREAM_LINE_MAX_CHARS) {
          emit(name, partial[name]);
          partial[name] = '';
        }
      };
      child.stdout.setEncoding('utf8').on('data', (d: string) => onData('stdout', d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => onData('stderr', d));

      let stopped: 'timeout' | 'cancelled' | null = null;
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let drainTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const signalGroup = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        signalTree(child.pid, sig);
      };
      const stop = (why: 'timeout' | 'cancelled') => {
        if (stopped || exit) return;
        stopped = why;
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const onAbort = () => stop('cancelled');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => stop('timeout'), opts.timeoutMs);

      const finish = (spawnError: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (drainTimer) clearTimeout(drainTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        for (const name of ['stdout', 'stderr'] as const) {
          if (partial[name] !== '') emit(name, partial[name]);
          partial[name] = '';
        }
        const out: GitExecResult = {
          command: display,
          stdout: tails.stdout,
          stderr: tails.stderr,
          exitCode: exit?.code ?? null,
          durationMs: Date.now() - started,
        };
        if (spawnError) {
          const reason = (spawnError as NodeJS.ErrnoException).code ?? 'unknown error';
          return reject(new GitExecError('spawn_failed', `${display} could not run: ${reason}`));
        }
        if (stopped === 'cancelled') {
          return reject(new GitExecError('cancelled', `${display} was cancelled`, out));
        }
        if (stopped === 'timeout') {
          return reject(new GitExecError('timeout', `${display} timed out`, out));
        }
        if (out.exitCode === 0) return resolve(out);
        const detail = out.stderr.trim().slice(-ERROR_TAIL_CHARS);
        const how = exit?.signal ? `killed by ${exit.signal}` : `exit ${out.exitCode}`;
        reject(
          new GitExecError(
            'command_failed',
            `${display} failed (${how})${detail ? `: ${detail}` : ''}`,
            out,
          ),
        );
      };

      child.on('error', (e) => {
        // Only a failed start ends the call: this event also reports a failed kill, and the process then still runs.
        if (child.pid === undefined) finish(e);
      });
      child.on('exit', (code, signal) => {
        exit = { code, signal };
        // The leader went on SIGTERM, but what it started must not outlive a stop.
        if (stopped) signalGroup('SIGKILL');
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, DRAIN_AFTER_EXIT_MS);
      });
      child.on('close', () => finish(null));
    });
    this.log?.debug(
      { command: result.command, exitCode: result.exitCode, durationMs: result.durationMs },
      'streamed command finished',
    );
    return result;
  }

  private async lockedCwd(repoId: string): Promise<string> {
    const cwd = this.clonePath(repoId);
    const notAllowed = () =>
      new GitExecError('cwd_not_allowed', `The clone directory of ${repoId} is not usable`);
    try {
      // lstat and the realpath comparison: a symlink must not lead the lock out of the root.
      if (!(await lstat(cwd)).isDirectory()) throw notAllowed();
      if ((await realpath(cwd)) !== join(await realpath(this.clonesRoot), repoId)) {
        throw notAllowed();
      }
    } catch (e) {
      if (e instanceof GitExecError) throw e;
      throw notAllowed();
    }
    return cwd;
  }
}
