import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCRIPT_FIELDS,
  SCRIPT_KEYS,
  type RepoConfig,
  type ScriptField,
  type ScriptSource,
  type ScriptsMissing,
  type ScriptsStatus,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { which } from '../util/platform';

/**
 * Release script settings (`tools/bin`). ONE source of truth: values typed in the dashboard win, otherwise each field
 * falls back to what Settings already knows (see `SCRIPT_FIELDS[].from`). The resolved values are
 *  - passed as env when the dashboard runs a script (per repo: that repo's token, prefix, reviewer, identity), and
 *  - written to `scripts.env` (mode 600) so the scripts read the same values from a terminal. The file holds secrets
 *    in plain text, readable by this OS user only: the same trade-off glab and nts make with their own config files.
 * Asking happens just in time: `missing(repo)` lists what a run lacks, and the release refuses with a 409 the UI turns
 * into a short form.
 */

const VALUES_STATE = 'scripts.values';
const WRITTEN_STATE = 'scripts.writtenAt';
const secretName = (key: string) => `scripts.${key}`;
const FIELDS = new Map(SCRIPT_FIELDS.map((f) => [f.key, f]));
/** Tools the scripts call. Missing ones are listed in Settings, never fatal here. */
const TOOLS = ['glab', 'git', 'jq', 'flutter'] as const;

/** Writes the env file where the scripts run: this machine, or the Mac behind the host agent. */
export interface ScriptEnvWriter {
  /** Absolute path on the machine that runs the scripts, or null when unknown. */
  readonly path: string | null;
  write(content: string): Promise<void>;
}

export function defaultEnvFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return (
    process.env.RELAY_SCRIPTS_ENV?.trim() ||
    process.env.CORE_DASHBOARD_SCRIPTS_ENV?.trim() ||
    join(base, 'relay', 'scripts.env')
  );
}

/** Writes atomically with mode 600 in a 700 directory. */
export function writeEnvFileLocal(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class LocalScriptEnvWriter implements ScriptEnvWriter {
  readonly path = defaultEnvFilePath();
  write(content: string): Promise<void> {
    writeEnvFileLocal(this.path, content);
    return Promise.resolve();
  }
}

/** `'…'` with every `'` closed, escaped and reopened: safe for `source` in bash. */
/** NUL or a line break would break the one-line `export`. */
const multiline = (v: string) => v.includes('\u0000') || v.includes('\n') || v.includes('\r');

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The env file body. Each line only sets a variable that is still unset, so the caller's env always wins. */
export function renderEnvFile(values: Record<string, string>, now: Date): string {
  const lines = [
    '# Written by Relay (Settings > Repos > Release scripts). Edits here are overwritten:',
    '# change the values in the dashboard instead. Holds secrets: keep it mode 600.',
    `# ${now.toISOString()}`,
  ];
  for (const key of SCRIPT_KEYS) {
    const v = values[key];
    if (v === undefined || v === '' || multiline(v)) continue;
    lines.push(`[ -n "\${${key}:-}" ] || export ${key}=${shellQuote(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The bundled scripts: `<repo>/tools/bin`, found by walking up from this file (works from src and from dist). */
export function bundledBinDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'tools', 'bin');
    if (existsSync(join(candidate, 'vu'))) return candidate;
    dir = resolve(dir, '..');
  }
  return null;
}

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Which `vu` runs: `VU_BIN_DIR`, else your own `~/bin/vu` when it exists (a setup made before the bundled scripts),
 * else the bundled `tools/bin`.
 */
export function resolveVuBinDir(): { dir: string; bundled: boolean } {
  const fromEnv = process.env.VU_BIN_DIR?.trim();
  if (fromEnv) return { dir: fromEnv, bundled: false };
  const own = join(homedir(), 'bin');
  if (executable(join(own, 'vu'))) return { dir: own, bundled: false };
  const bundled = bundledBinDir();
  return bundled ? { dir: bundled, bundled: true } : { dir: own, bundled: false };
}

export class ScriptConfigService {
  private writtenError: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly d: {
      config: ConfigStore;
      log: Logger;
      writer: ScriptEnvWriter | null;
      bus?: EventBus;
      now?: () => number;
    },
  ) {}

  /** Re-write the file after Settings change (debounced: a save burst writes once). */
  watch(): () => void {
    if (!this.d.bus) return () => undefined;
    return this.d.bus.on('settings.changed', () => this.scheduleWrite());
  }

  private scheduleWrite(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.writeFile(), 500);
  }

  // ───────────────────────────── values ─────────────────────────────

  private typed(): Record<string, string> {
    return this.d.config.getState<Record<string, string>>(VALUES_STATE) ?? {};
  }

  private savedValue(f: ScriptField): string | undefined {
    if (f.secret) return this.d.config.getSecret(secretName(f.key)) || undefined;
    return this.typed()[f.key] || undefined;
  }

  /** The value of one Settings source; repo sources need the repo that runs the script. */
  private fromSource(src: ScriptSource, repo: RepoConfig | null): string | undefined {
    const g = this.d.config.getGlobal();
    switch (src) {
      case 'gitlab.host':
        return g.gitlab.host;
      case 'gitlab.hostname':
        try {
          return g.gitlab.host ? new URL(g.gitlab.host).hostname : undefined;
        } catch {
          return undefined;
        }
      case 'gitlab.myUsername':
        return g.gitlab.myUsername;
      case 'repo.token':
        return repo?.gitlab.token || undefined;
      case 'repo.versionBranchPrefix':
        return repo?.versionBranchPrefix;
      case 'repo.reviewer':
        return repo?.reviewers[0];
      case 'repo.commitName':
        return repo?.commitIdentity?.name;
      case 'repo.commitEmail':
        return repo?.commitIdentity?.email;
      case 'reviewer.token':
        return this.d.config.getReviewerToken();
      case 'notion.token':
        return g.notion.token;
      case 'notion.dataSourceId':
        return g.notion.dataSourceId;
      case 'notion.readyStatus':
        return g.notion.readyStatus;
      case 'notion.version':
        return g.notion.version;
    }
  }

  /**
   * One field resolved. With a repo, the repo's own settings come first (its token, prefix, reviewer, identity), then
   * what you typed, then global Settings. Without a repo (the terminal file), what you typed comes first.
   */
  private resolveField(
    f: ScriptField,
    repo: RepoConfig | null,
  ): { value: string | undefined; derivedFrom: ScriptSource | null } {
    const repoFirst = repo ? f.from.filter((s) => s.startsWith('repo.')) : [];
    for (const src of repoFirst) {
      const v = this.fromSource(src, repo);
      if (v) return { value: v, derivedFrom: src };
    }
    const saved = this.savedValue(f);
    if (saved) return { value: saved, derivedFrom: null };
    for (const src of f.from) {
      if (src.startsWith('repo.')) continue;
      const v = this.fromSource(src, repo);
      if (v) return { value: v, derivedFrom: src };
    }
    return { value: undefined, derivedFrom: null };
  }

  /** Env for a script run by the dashboard for `repo`. */
  envFor(repo: RepoConfig): Record<string, string> {
    const env: Record<string, string> = {};
    for (const f of SCRIPT_FIELDS) {
      const { value } = this.resolveField(f, repo);
      if (value) env[f.key] = value;
    }
    return env;
  }

  /** What a release through the scripts lacks for `repo`. Empty `required` = it can run unattended. */
  missing(repo: RepoConfig): ScriptsMissing {
    const required: string[] = [];
    const optional: string[] = [];
    for (const f of SCRIPT_FIELDS) {
      if (this.resolveField(f, repo).value) continue;
      if (f.need === 'release') required.push(f.key);
      else if (f.need === 'notion') optional.push(f.key);
    }
    return { repoId: repo.id, required, optional };
  }

  status(): ScriptsStatus {
    const vu = resolveVuBinDir();
    const vuPath = join(vu.dir, 'vu');
    return {
      fields: SCRIPT_FIELDS.map((f) => {
        const saved = this.savedValue(f) !== undefined;
        const r = this.resolveField(f, null);
        return {
          key: f.key,
          saved,
          value: f.secret ? null : (r.value ?? null),
          derivedFrom: r.derivedFrom,
          filled: r.value !== undefined,
        };
      }),
      envFile: this.d.writer?.path ?? null,
      writtenAt: this.d.config.getState<number>(WRITTEN_STATE) ?? null,
      fileError: this.d.writer
        ? this.writtenError
        : 'The scripts run on another machine without a host agent.',
      vu: { path: executable(vuPath) ? vuPath : null, bundled: vu.bundled },
      missingTools: TOOLS.filter((t) => which(t) === null),
    };
  }

  /** Saves typed values (`null` clears one: it falls back to Settings again), then re-writes the file. */
  async save(values: Record<string, string | null>): Promise<ScriptsStatus> {
    const typed = this.typed();
    for (const [key, raw] of Object.entries(values)) {
      const f = FIELDS.get(key);
      if (!f) continue;
      const v = raw === null ? null : raw.trim();
      if (v !== null && multiline(v)) throw new Error(`${key} must be one line`);
      if (f.secret) this.d.config.setSecret(secretName(key), v || null);
      else if (v) typed[key] = v;
      else delete typed[key];
    }
    this.d.config.setState(VALUES_STATE, typed);
    await this.writeFile();
    return this.status();
  }

  /** The terminal file: values resolved without a repo. Never throws. */
  async writeFile(): Promise<void> {
    if (!this.d.writer) return;
    const values: Record<string, string> = {};
    for (const f of SCRIPT_FIELDS) {
      const { value } = this.resolveField(f, null);
      if (value) values[f.key] = value;
    }
    try {
      await this.d.writer.write(renderEnvFile(values, new Date((this.d.now ?? Date.now)())));
      this.d.config.setState(WRITTEN_STATE, (this.d.now ?? Date.now)());
      this.writtenError = null;
    } catch (e) {
      this.writtenError = `Could not write ${this.d.writer.path ?? 'the env file'}: ${(e as Error).message}`;
      this.d.log.warn({ err: (e as Error).name }, 'scripts env file not written');
    }
  }
}
