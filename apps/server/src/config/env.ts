import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

export const LOOPBACK_HOST = '127.0.0.1';
/** The only accepted dashboard bind address. (`localhost`/`::1`/`0.0.0.0` are refused on purpose.) */
export function isLoopbackHost(host: string): boolean {
  return host === LOOPBACK_HOST;
}

/** `.env.example` ships `KEY=` (empty): treat blank as unset. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v !== undefined && v.trim() !== '' ? v.trim() : undefined));

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** `DASHBOARD_TLS_HOSTS` as lowercase hostnames, or null when one is not a plain dotted hostname. */
export function parseTlsHosts(raw: string | undefined): string[] | null {
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter((h) => h !== '');
  return hosts.every((h) => HOSTNAME_RE.test(h) && !/^[0-9.]+$/.test(h)) ? hosts : null;
}

/** `DASHBOARD_TLS_USERS` as lowercase logins. */
export function parseTlsUsers(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter((u) => u !== '');
}

const BUILD_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NEVER_PASSED_TO_BUILDS = new Set(['MASTER_KEY', 'VAPID_PRIVATE_KEY', 'NTFY_TOPIC']);

/** The names in `BUILD_PASS_ENV`, or null when one is malformed or names a secret of the dashboard itself. */
export function parseBuildPassEnv(raw: string | undefined): string[] | null {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const valid = names.every(
    (name) => BUILD_ENV_NAME_RE.test(name) && !NEVER_PASSED_TO_BUILDS.has(name.toUpperCase()),
  );
  return valid ? names : null;
}

const EnvSchema = z
  .object({
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Where app.db / credentials / apks live. Default: `<repo root>/data`. */
    DATA_DIR: z.string().min(1).optional(),
    NODE_ENV: z.string().optional(),
    /** Encrypts secrets at rest. Validated by `parseMasterKey` at boot (kept optional here so tooling can load env). */
    MASTER_KEY: z.string().optional(),
    /** Dashboard bind address. Loopback only: anything else is refused. */
    DASHBOARD_HOST: z
      .string()
      .default(LOOPBACK_HOST)
      .refine(isLoopbackHost, {
        message: `DASHBOARD_HOST must be ${LOOPBACK_HOST} (the dashboard is never exposed)`,
      }),
    DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * Hostnames a TLS reverse proxy on this machine serves the dashboard under (e.g. `tailscale serve`), comma
     * separated. The listener stays on 127.0.0.1; this only widens the Host/Origin allowlist, to https on 443.
     */
    DASHBOARD_TLS_HOSTS: optionalString.refine(
      (v) => v === undefined || parseTlsHosts(v) !== null,
      'DASHBOARD_TLS_HOSTS must list hostnames (no scheme, port, path or IP address)',
    ),
    /** Tailscale logins (`you@example.com`) allowed through `DASHBOARD_TLS_HOSTS`. Required with it. */
    DASHBOARD_TLS_USERS: optionalString,
    /** Webhook listener bind address. Default loopback: the ngrok agent runs on this machine. */
    WEBHOOK_HOST: z.string().min(1).default(LOOPBACK_HOST),
    WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    /** Web Push. Validated by `resolveVapid` (push stays off, with a reason, when unset/invalid). */
    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,
    VAPID_SUBJECT: optionalString,
    /** Optional ntfy.sh fallback channel. The topic acts as a password: env only, never returned or logged. */
    NTFY_TOPIC: optionalString,
    NTFY_SERVER: optionalString,
    /** Whole-job limit of one build. */
    BUILD_TIMEOUT_MIN: z.coerce.number().int().min(1).max(720).default(30),
    /**
     * Comma-separated NAMES of variables a build may see although they look secret (signing passwords, say). The values
     * come from this process's environment at build time. The dashboard's own secrets can never be named.
     */
    BUILD_PASS_ENV: optionalString.refine(
      (v) => v === undefined || parseBuildPassEnv(v) !== null,
      'BUILD_PASS_ENV must list variable names, and cannot name MASTER_KEY, VAPID_PRIVATE_KEY or NTFY_TOPIC',
    ),
    /**
     * Docker setup: git, flutter and vu run on the Mac through the host agent (`pnpm agent`), e.g.
     * `http://host.docker.internal:3002`. Unset: they run on this machine.
     */
    HOST_AGENT_URL: optionalString.refine(
      (v) => v === undefined || /^http:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v),
      'HOST_AGENT_URL must look like http://host.docker.internal:3002 (no path)',
    ),
    /** Shared with the agent, which refuses anything else. At least 24 characters. */
    HOST_AGENT_TOKEN: optionalString,
    /** Where the bot clones live. Default `~/.relay/clones`. With the agent: the same path on both sides. */
    CLONES_DIR: optionalString,
    /**
     * Cockpit: AI fallback when the Claude CLI is unavailable. Unset = CLI only.
     * Read by the Anthropic SDK itself; listed here so `.env.example` documents it.
     */
    ANTHROPIC_API_KEY: optionalString,
    /** Test Bench: command that starts the Figma MCP bridge (stdio). Default `npx -y @gethopp/figma-mcp-bridge`. */
    FIGMA_BRIDGE_CMD: optionalString,
  })
  .refine((e) => !e.HOST_AGENT_URL || (e.HOST_AGENT_TOKEN?.length ?? 0) >= 24, {
    message:
      'HOST_AGENT_URL needs HOST_AGENT_TOKEN (at least 24 characters, the same as the agent has)',
    path: ['HOST_AGENT_TOKEN'],
  })
  .refine((e) => !e.DASHBOARD_TLS_HOSTS || parseTlsUsers(e.DASHBOARD_TLS_USERS).length > 0, {
    message: 'DASHBOARD_TLS_HOSTS needs DASHBOARD_TLS_USERS (the Tailscale logins allowed in)',
    path: ['DASHBOARD_TLS_USERS'],
  })
  .refine((e) => e.DASHBOARD_PORT !== e.WEBHOOK_PORT, {
    message: 'DASHBOARD_PORT and WEBHOOK_PORT must differ',
    path: ['WEBHOOK_PORT'],
  });
export type Env = z.infer<typeof EnvSchema>;

/** PUBLIC_BASE_URL / VAPID_* are validated by the parts that use them. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(raw);
}

/** Walks up from `from` to the dir containing pnpm-workspace.yaml. */
export function findRepoRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repo root (pnpm-workspace.yaml) not found from ${from}`);
    dir = parent;
  }
}

/** `DATA_DIR` (absolute, or relative to the repo root) or `<repo root>/data`. */
export function resolveDataDir(env: Pick<Env, 'DATA_DIR'>, cwd: string = process.cwd()): string {
  const root = findRepoRoot(cwd);
  if (!env.DATA_DIR) return join(root, 'data');
  return isAbsolute(env.DATA_DIR) ? env.DATA_DIR : resolve(root, env.DATA_DIR);
}
