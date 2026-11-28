import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  WEB_SCRIPT_RE,
  type WebFramework,
  type WebPackageManager,
  type WebRunTargets,
} from '@relay/shared';
import type { NodePtyProcess } from '../ptyBackend';
import { IS_WINDOWS } from '../../util/platform';
import { CockpitHostError } from './host';

/**
 * "Run this branch" for a web project: `<pm> run <script>` in a PTY, after `<pm> install` when the dependencies are
 * missing or older than the lockfile. The script is a name from the workspace's own `package.json`, the package manager
 * comes from its lockfile, and nothing the client sends reaches the command line beyond that name.
 */

export type ProjectKind = 'flutter' | 'web' | 'unknown';

/** `pubspec.yaml` wins: a Flutter repo can carry a `package.json` for tooling. */
export function projectKind(cwd: string): ProjectKind {
  if (existsSync(join(cwd, 'pubspec.yaml'))) return 'flutter';
  if (existsSync(join(cwd, 'package.json'))) return 'web';
  return 'unknown';
}

const LOCKFILES: readonly [string, WebPackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

/** npm lifecycle hooks (`postinstall`, `prepare`, `predev`, …): they run on their own and are not something to pick. */
const LIFECYCLE = new Set([
  'install',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
]);
/** `predev` / `postbuild` hook `dev` / `build`; `preview` is a script of its own. */
function isLifecycle(name: string, all: readonly string[]): boolean {
  if (LIFECYCLE.has(name)) return true;
  const m = /^(?:pre|post)(.+)$/.exec(name);
  return !!m && (all.includes(m[1]!) || LIFECYCLE.has(m[1]!));
}

/** Scripts tried, in order, when the user picked none. */
const DEFAULT_SCRIPTS = ['dev', 'start', 'serve', 'preview'];

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  packageManager?: unknown;
}

function readPackageJson(cwd: string): PackageJson | null {
  const file = join(cwd, 'package.json');
  try {
    if (statSync(file).size > 1024 * 1024) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function packageManagerOf(cwd: string, pkg: PackageJson): WebPackageManager {
  for (const [file, pm] of LOCKFILES) if (existsSync(join(cwd, file))) return pm;
  // No lockfile yet: corepack's `packageManager` field ("pnpm@9.1.0"), else npm.
  const field = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  return field === 'pnpm' || field === 'yarn' || field === 'bun' ? field : 'npm';
}

function frameworkOf(pkg: PackageJson): WebFramework {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (n: string) => Object.prototype.hasOwnProperty.call(deps, n);
  if (has('nuxt') || has('nuxt-edge') || has('nuxt3')) return 'nuxt';
  if (has('next')) return 'next';
  if (has('astro')) return 'astro';
  if (has('react-scripts')) return 'react-scripts';
  if (has('vite')) return 'vite';
  return 'other';
}

/** The package manager, framework and scripts of a web workspace; null without a readable `package.json`. */
export function readWebTargets(cwd: string): WebRunTargets | null {
  const pkg = readPackageJson(cwd);
  if (!pkg) return null;
  const all = Object.entries(pkg.scripts ?? {})
    .filter(([name, cmd]) => typeof cmd === 'string' && WEB_SCRIPT_RE.test(name))
    .map(([name]) => name);
  const scripts = all.filter((name) => !isLifecycle(name, all)).slice(0, 200);
  return {
    pm: packageManagerOf(cwd, pkg),
    framework: frameworkOf(pkg),
    scripts,
    defaultScript: DEFAULT_SCRIPTS.find((s) => scripts.includes(s)) ?? null,
  };
}

/** Which script runs: the requested one when `package.json` has it, else the default. Refuses anything else. */
export function chooseWebScript(targets: WebRunTargets, requested: string | undefined): string {
  if (requested !== undefined) {
    if (!WEB_SCRIPT_RE.test(requested) || !targets.scripts.includes(requested)) {
      throw new CockpitHostError(
        'script_missing',
        `package.json has no "${requested}" script`,
        422,
        { scripts: targets.scripts },
      );
    }
    return requested;
  }
  if (targets.defaultScript) return targets.defaultScript;
  throw new CockpitHostError(
    'script_choice_required',
    targets.scripts.length > 0
      ? `Choose a script: ${targets.scripts.join(', ')}`
      : 'package.json has no scripts to run',
    422,
    { scripts: targets.scripts },
  );
}

/** The marker each package manager writes when an install finishes. */
const INSTALL_MARKERS: Record<WebPackageManager, string[]> = {
  pnpm: ['.modules.yaml'],
  npm: ['.package-lock.json'],
  yarn: ['.yarn-state.yml', '.yarn-integrity'],
  bun: [],
};

const mtime = (p: string): number | null => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Install first when `node_modules` is missing, or when the lockfile changed after the last install (a branch switch
 * that touched dependencies). The same thing `flutter run` does with `pub get`.
 */
export function needsInstall(cwd: string, pm: WebPackageManager): boolean {
  const nm = join(cwd, 'node_modules');
  if (!existsSync(nm)) return true;
  const lock = LOCKFILES.filter(([, p]) => p === pm)
    .map(([f]) => mtime(join(cwd, f)))
    .find((t) => t !== null);
  if (lock === undefined || lock === null) return false;
  const marker =
    INSTALL_MARKERS[pm].map((m) => mtime(join(nm, m))).find((t) => t !== null) ?? mtime(nm);
  return marker === null || lock > marker + 1_000;
}

export interface WebRunStep {
  file: WebPackageManager;
  args: string[];
  /**
   * A failure does not stop the run. Set on `install`: a newer pnpm exits 1 on ignored build scripts
   * (`ERR_PNPM_IGNORED_BUILDS`) after installing everything, and the dev server then starts fine. If the dependencies
   * really are missing, the script fails right after, below the install's error.
   */
  keepGoing?: boolean;
}

/** The argv of a web run: fixed shapes only (`install`, `run <script>`). */
export function webRunSteps(pm: WebPackageManager, script: string, install: boolean): WebRunStep[] {
  if (!WEB_SCRIPT_RE.test(script)) throw new CockpitHostError('validation', 'Invalid script', 422);
  return [
    ...(install ? [{ file: pm, args: ['install'], keepGoing: true }] : []),
    { file: pm, args: ['run', script] },
  ];
}

/** Ports Relay itself holds (dashboard, webhooks): a dev server must never take them. */
const RELAY_PORTS = new Set([3000, 3001]);

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) =>
      // No IPv6 on this host is not "taken".
      resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'),
    );
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** A port free on both loopbacks, from 5300 up, for frameworks that read `PORT` (Nuxt, Next, CRA). */
export async function freePort(from = 5300, to = 5399): Promise<number> {
  for (let p = from; p <= to; p++) {
    if (RELAY_PORTS.has(p)) continue;
    if ((await canListen(p, '127.0.0.1')) && (await canListen(p, '::1'))) return p;
  }
  throw new CockpitHostError('no_free_port', `No free port between ${from} and ${to}`, 409);
}

/** What a web session adds to its environment: the port, and no browser tab opened on the Mac. */
export function webEnv(port: number): Record<string, string> {
  const p = String(port);
  return { PORT: p, NUXT_PORT: p, NITRO_PORT: p, BROWSER: 'none' };
}

// ───────────────────────────── the dev server's address ─────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const LOOPBACK_URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"`<>]*)?/i;
/** Lines that name where the server listens (Nuxt/Vite `➜ Local:`, Astro `┃ Local`, Next `- Local:` / `ready`, Nuxt 2 `Listening on:`). */
const ANNOUNCE_RE = /\b(local|listening|ready|started|running|available|server)\b/i;
const PORT_ONLY_RE = /\blistening (?:on|at)\s+(?:port\s+)?:?(\d{2,5})\b/i;

/** `0.0.0.0` / `[::]` / `127.0.0.1` read as `localhost` in the browser; trailing punctuation is dropped. */
export function normalizeDevUrl(raw: string): string | null {
  try {
    const u = new URL(raw.replace(/[).,;:]+$/, ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hostname = 'localhost';
    return u.toString();
  } catch {
    return null;
  }
}

/** Finds the dev server's address in its output, across chunk boundaries. */
export class DevUrlWatcher {
  private tail = '';

  /** The address, the first time a line names one; null until then. */
  feed(chunk: string): string | null {
    const text = (this.tail + chunk).replace(ANSI_RE, '');
    const lines = text.split(/\r?\n|\r/);
    this.tail = (lines.pop() ?? '').slice(-500);
    for (const line of lines) {
      if (!ANNOUNCE_RE.test(line)) continue;
      const m = LOOPBACK_URL_RE.exec(line);
      if (m) return normalizeDevUrl(m[0]);
      const p = PORT_ONLY_RE.exec(line);
      if (p) return `http://localhost:${p[1]}/`;
    }
    return null;
  }
}

/**
 * The first TCP port the session's process group listens on (`lsof`), for a server that never prints its address.
 * node-pty starts each session in its own process group, so the group id is the session's pid. Not on Windows.
 */
export function listeningUrl(pgid: number): Promise<string | null> {
  if (IS_WINDOWS || !Number.isInteger(pgid) || pgid <= 1) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-g', String(pgid), '-Fn'],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
      (_err, out) => {
        const ports = String(out ?? '')
          .split('\n')
          .filter((l) => l.startsWith('n'))
          .map((l) => Number(/:(\d+)$/.exec(l)?.[1]))
          .filter((p) => Number.isInteger(p) && p > 0 && !RELAY_PORTS.has(p));
        resolve(ports.length > 0 ? `http://localhost:${ports[0]}/` : null);
      },
    );
  });
}

/**
 * Whether the page refuses to be framed (`X-Frame-Options`, or a CSP `frame-ancestors` without `*`), as `nuxt-security`
 * and helmet set it. Relay's page is another origin (another port), so `SAMEORIGIN` and `'self'` refuse it too.
 * Null = no real answer yet: unreachable, or a 5xx while the server still warms up (Nuxt answers 503 then, without
 * its route headers). Ask again later.
 */
export async function probeFrameBlocked(url: string): Promise<boolean | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    void res.body?.cancel();
    if (res.status >= 500) return null;
    const xfo = res.headers.get('x-frame-options')?.trim().toLowerCase();
    if (xfo === 'deny' || xfo === 'sameorigin') return true;
    const csp = res.headers.get('content-security-policy') ?? '';
    const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp)?.[1];
    return fa !== undefined && !/(^|\s)\*(\s|$)/.test(fa);
  } catch {
    return null;
  }
}

// ───────────────────────────── install, then run ─────────────────────────────

/**
 * A web run as one PTY process: each step (`install`, then `run <script>`) starts when the one before exited 0. A failed
 * install ends the session with its exit code, so the log shows why. `pid` is the step running now.
 */
export class ChainedPty implements NodePtyProcess {
  private cur: NodePtyProcess;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  private cols: number;
  private rows: number;
  private stopped = false;

  constructor(
    private readonly steps: WebRunStep[],
    private readonly spawnStep: (step: WebRunStep, cols: number, rows: number) => NodePtyProcess,
    size: { cols: number; rows: number },
  ) {
    this.cols = size.cols;
    this.rows = size.rows;
    this.cur = this.startStep(0);
  }

  get pid(): number {
    return this.cur.pid;
  }

  private startStep(i: number): NodePtyProcess {
    const step = this.steps[i]!;
    const proc = this.spawnStep(step, this.cols, this.rows);
    const banner = `\r\n\u001b[2m$ ${step.file} ${step.args.join(' ')}\u001b[0m\r\n`;
    queueMicrotask(() => this.emitData(banner));
    proc.onData((d) => {
      if (proc === this.cur) this.emitData(d);
    });
    proc.onExit((e) => {
      if (proc !== this.cur) return;
      // Ended by a signal (Stop, Restart) = the user's choice: nothing after it starts.
      const next = !e.signal && (e.exitCode === 0 || step.keepGoing === true);
      if (next && !this.stopped && i + 1 < this.steps.length) {
        if (e.exitCode !== 0) {
          this.emitData(
            `\r\n\u001b[33m${step.file} ${step.args.join(' ')} exited ${e.exitCode}; starting anyway.\u001b[0m\r\n`,
          );
        }
        try {
          this.cur = this.startStep(i + 1);
          return;
        } catch (err) {
          this.emitData(`\r\n${(err as Error).message}\r\n`);
          this.emitExit({ exitCode: 1 });
          return;
        }
      }
      this.emitExit(e);
    });
    return proc;
  }

  private emitData(d: string): void {
    for (const l of this.dataListeners) l(d);
  }

  private emitExit(e: { exitCode: number; signal?: number }): void {
    for (const l of this.exitListeners) l(e);
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.add(listener);
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.add(listener);
  }

  write(data: string): void {
    this.cur.write(data);
  }

  kill(signal?: string): void {
    this.stopped = true;
    this.cur.kill(signal);
  }

  /** The session is being stopped some other way (its process group is signalled): start no further step. */
  stop(): void {
    this.stopped = true;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.cur.resize?.(cols, rows);
  }
}
