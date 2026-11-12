import { isSafeBranchName, isSafeVersion, REPO_ID_RE, SCRIPT_KEYS } from '@relay/shared';
import { z } from 'zod';
import { ALLOWED_COMMANDS, type GitExecResult } from '../services/gitExec';
import type { PtyAvailability } from '../services/ptyBackend';

/**
 * The host agent (Docker setup): the dashboard runs in Docker, the Mac runs git, flutter and `vu` with its own
 * toolchain. They talk over HTTP on the Mac's loopback, with a bearer token both read from `.env`. Every response that
 * can take a while is NDJSON with a heartbeat, so no HTTP timeout cuts a 30-minute clone or build short. Closing the
 * request stops the command.
 */

export const AGENT_PROTOCOL = 1;
export const AGENT_HEARTBEAT_MS = 15_000;

export interface AgentHealth {
  protocol: number;
  pty: PtyAvailability;
  /** `flutter --version`'s first line, or null when flutter is not on the agent's PATH. */
  flutter: string | null;
  clonesRoot: string;
  /** The proxy git uses for the repo host, or null when git goes direct. */
  gitProxy: string | null;
}

const GIT_CONFIG_PAIR_RE = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/;
const EXTRA_HEADER_KEY_RE = /^http\.https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/\.extraHeader$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/$/;

const EnvSchema = z.record(z.string().regex(ENV_NAME_RE).max(100), z.string().max(8192));
const SecretsSchema = z.array(z.string().max(8192)).max(20);

export const ExecRequestSchema = z.object({
  repoId: z.string().regex(REPO_ID_RE),
  command: z.enum(ALLOWED_COMMANDS),
  args: z.array(z.string().max(4096)).max(200),
  mode: z.enum(['run', 'stream']),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(12 * 60 * 60 * 1000),
  allowFailure: z.boolean().optional(),
  env: EnvSchema,
  secrets: SecretsSchema,
  /** `https://host/` of the repo's clone URL: git reaches it through the agent's proxy. */
  remoteBase: z.string().regex(BASE_URL_RE).nullable(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export type ExecEvent =
  | { t: 'hb' }
  | { t: 'line'; line: string; stream: 'stdout' | 'stderr' }
  | { t: 'result'; result: GitExecResult }
  | { t: 'error'; code: string; message: string; result?: GitExecResult };

export const PtyStartRequestSchema = z.object({
  repoId: z.string().regex(REPO_ID_RE),
  args: z.array(z.string().max(200)).max(10),
  env: EnvSchema,
  secrets: SecretsSchema,
  remoteBase: z.string().regex(BASE_URL_RE).nullable(),
});
export type PtyStartRequest = z.infer<typeof PtyStartRequestSchema>;

export type PtyEvent =
  | { t: 'hb' }
  | { t: 'started'; id: string; pid: number }
  | { t: 'data'; data: string }
  | { t: 'exit'; exitCode: number; signal?: number }
  | { t: 'error'; message: string };

export const PtyKillSchema = z.object({ signal: z.enum(['SIGTERM', 'SIGKILL']) });

/** Exactly what `vuArgs` produces: `staging|prod -b <base> -y --no-notion-scan [--version <v>]`. */
export function isVuArgs(args: readonly string[]): boolean {
  const [mode, b, base, y, notion, versionFlag, version, ...rest] = args;
  if (mode !== 'staging' && mode !== 'prod') return false;
  if (b !== '-b' || !base || !isSafeBranchName(base)) return false;
  if (y !== '-y' || notion !== '--no-notion-scan' || rest.length > 0) return false;
  if (versionFlag === undefined) return version === undefined;
  return versionFlag === '--version' && version !== undefined && isSafeVersion(version);
}

/**
 * The variables a caller may add to a child. Git config only as a token header for one http(s) host (anything else, say
 * `core.sshCommand`, would run a program). For a PTY run: the GitLab token and the assignee. For a command: also the
 * names the agent's own `BUILD_PASS_ENV` lists. Returns the reason for a refusal, or null.
 */
export function checkClientEnv(
  env: Readonly<Record<string, string>>,
  allowed: { pty: boolean; passEnv: readonly string[] },
): string | null {
  const count = env.GIT_CONFIG_COUNT === undefined ? 0 : Number(env.GIT_CONFIG_COUNT);
  if (!Number.isInteger(count) || count < 0 || count > 4) return 'GIT_CONFIG_COUNT is invalid';
  for (const [name, value] of Object.entries(env)) {
    if (name === 'GIT_CONFIG_COUNT') continue;
    const pair = GIT_CONFIG_PAIR_RE.exec(name);
    if (pair) {
      if (Number(pair[2]) >= count) return `${name} is outside GIT_CONFIG_COUNT`;
      if (pair[1] === 'KEY' && !EXTRA_HEADER_KEY_RE.test(value)) return `${name} is not allowed`;
      if (pair[1] === 'VALUE' && !value.startsWith('Authorization: Basic ')) {
        return `${name} is not allowed`;
      }
      continue;
    }
    // The release scripts' settings (Settings > Repos > Release scripts), sent by the dashboard per run.
    if (allowed.pty && (name === 'GITLAB_TOKEN' || SCRIPT_KEYS.includes(name))) continue;
    if (!allowed.pty && allowed.passEnv.includes(name)) continue;
    return `${name} may not be set`;
  }
  for (let i = 0; i < count; i += 1) {
    if (env[`GIT_CONFIG_KEY_${i}`] === undefined || env[`GIT_CONFIG_VALUE_${i}`] === undefined) {
      return `GIT_CONFIG pair ${i} is incomplete`;
    }
  }
  return null;
}

/** Splits an NDJSON byte stream into parsed objects. A torn last line waits for the next chunk. */
export async function* readNdjson<T>(body: AsyncIterable<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line !== '') yield JSON.parse(line) as T;
      nl = buffer.indexOf('\n');
    }
  }
  const last = (buffer + decoder.decode()).trim();
  if (last !== '') yield JSON.parse(last) as T;
}
