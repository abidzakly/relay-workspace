import { accessSync, chmodSync, constants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { PTY_COLS, PTY_ROWS, type ReleaseEngines } from '@relay/shared';
import type { Logger } from '../util/logger';
import { childEnv } from './gitExec';
import { resolveVuBinDir } from './scriptConfig';
import { expandHome, IS_WINDOWS, signalTree } from '../util/platform';

/**
 * Where `vu` runs in a pseudo-terminal. `LocalPtyBackend` spawns it on this machine through node-pty. The host agent
 * uses the same class on the Mac, and the dashboard in Docker reaches it through `RemotePtyBackend` (hostAgent/client).
 */

export type PtyAvailability = ReleaseEngines['pty'];

/** The part of node-pty the engine uses. A remote process implements the same shape. */
export interface PtyProcess {
  pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
  /** Signals vu's whole process group (vu -> frm -> flutter -> gradle). */
  killGroup(signal: NodeJS.Signals): void;
}

export interface SpawnVuInput {
  repoId: string;
  /** The repo's bot clone. */
  cwd: string;
  /** Already validated by the caller (`vuArgs`). */
  args: string[];
  /** Added to the child's environment: the GitLab token, the assignee, git's token header. */
  env: Record<string, string>;
  /** Values to keep out of logs on the way (a remote backend sends them along). */
  secrets: string[];
}

export interface PtyBackend {
  availability(): PtyAvailability;
  spawnVu(input: SpawnVuInput): Promise<PtyProcess>;
  close?(): void;
}

/** The node-pty module, typed locally: the package is optional and may be absent even at typecheck. */
export interface NodePtyProcess {
  pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
  /** Present on real node-pty processes (cockpit sessions resize). */
  resize?(cols: number, rows: number): void;
}
export interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): NodePtyProcess;
}

const NODE_PTY = 'node-pty';

/**
 * Never throws: a missing package or a native module that will not load only makes the engine unavailable.
 * pnpm installed the prebuilt `spawn-helper` without its execute bit, and spawning fails without it, so it is restored.
 */
export function loadNodePty(log: Logger): NodePtyModule | null {
  const require = createRequire(import.meta.url);
  try {
    const mod = require(NODE_PTY) as NodePtyModule;
    try {
      const helper = join(
        dirname(require.resolve(NODE_PTY)),
        '..',
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      );
      if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    } catch {
      // No prebuilt helper here (compiled from source, or another platform).
    }
    return mod;
  } catch (e) {
    log.warn({ reason: (e as Error).message }, 'node-pty did not load: the PTY engine is off');
    return null;
  }
}

export interface LocalPtyBackendOptions {
  log: Logger;
  /** Default `~/bin`. */
  binDir?: string;
  /** Directories put before `binDir` on PATH (the host agent's glab shim). */
  pathPrefix?: readonly string[];
  /** Added after the caller's env (the host agent's git proxy). Gets the env built so far. */
  decorateEnv?: (env: Record<string, string>) => Record<string, string>;
}

export class LocalPtyBackend implements PtyBackend {
  readonly binDir: string;
  private readonly nodePty: NodePtyModule | null;

  constructor(private readonly o: LocalPtyBackendOptions) {
    // VU_BIN_DIR, else your own ~/bin/vu when there is one, else the bundled tools/bin.
    this.binDir = o.binDir ?? resolveVuBinDir().dir;
    this.nodePty = loadNodePty(o.log);
  }

  /**
   * The custom release command: `RELEASE_COMMAND` (an executable that takes `vu`'s arguments), else `vu`. Set on the
   * machine that runs it (the host agent's `.env` in Docker), never from the browser: the agent only runs what its own
   * machine names.
   */
  get vuPath(): string {
    const custom = process.env.RELEASE_COMMAND?.trim();
    return custom ? expandHome(custom) : join(this.binDir, 'vu');
  }

  availability(): PtyAvailability {
    if (IS_WINDOWS) {
      return {
        available: false,
        reason: 'the release scripts are bash scripts: on Windows, run the dashboard in WSL',
        command: null,
      };
    }
    if (!this.nodePty) {
      return {
        available: false,
        reason: 'node-pty is not installed or did not load',
        command: this.vuPath,
      };
    }
    try {
      accessSync(this.vuPath, constants.X_OK);
    } catch {
      return {
        available: false,
        reason: `${this.vuPath} was not found, or is not executable`,
        command: this.vuPath,
      };
    }
    return { available: true, reason: null, command: this.vuPath };
  }

  spawnVu(input: SpawnVuInput): Promise<PtyProcess> {
    if (!this.nodePty) return Promise.reject(new Error('node-pty is not loaded'));
    const proc = this.nodePty.spawn(this.vuPath, input.args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: input.cwd,
      env: this.envFor(input),
    });
    return Promise.resolve({
      pid: proc.pid,
      onData: (l) => proc.onData(l),
      onExit: (l) => proc.onExit(l),
      write: (d) => proc.write(d),
      kill: (s) => proc.kill(s),
      killGroup: (sig) => signalTree(proc.pid, sig, () => proc.kill(sig)),
    });
  }

  private envFor(input: SpawnVuInput): Record<string, string> {
    let env: Record<string, string> = {};
    for (const [k, v] of Object.entries(childEnv(input.cwd))) {
      if (v !== undefined) env[k] = v;
    }
    // vu finds mrc and flutter-run-menu next to itself, but they and glab are looked up on PATH as well.
    env.PATH = [...(this.o.pathPrefix ?? []), this.binDir, env.PATH ?? ''].join(delimiter);
    env.TERM = 'xterm-256color';
    env = { ...env, ...input.env };
    return this.o.decorateEnv ? this.o.decorateEnv(env) : env;
  }
}
