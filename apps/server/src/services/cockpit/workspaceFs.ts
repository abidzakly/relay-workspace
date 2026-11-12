import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { DiffFile } from '@relay/shared';
import { childEnv } from '../gitExec';
import { CockpitHostError } from './host';
import { expandHome } from '../../util/platform';

/**
 * Workspace = a directory on the user's Mac, NOT a bot clone. Every call
 * re-validates the path against `HOST_AGENT_WORKSPACE_ROOTS` with realpath (a symlink cannot lead out of a root), and
 * file paths are confined to the workspace (no `..`, no absolute paths, nothing under `.git/`).
 * git runs with execFile (no shell) and fixed argument lists.
 */

export const FILE_MAX = 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const TREE_MAX = 20_000;

/** `HOST_AGENT_WORKSPACE_ROOTS` (comma separated, `~/` allowed). Default `~/Work`. */
export function parseWorkspaceRoots(raw: string | undefined): string[] {
  const list = (raw ?? '~/Work')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => expandHome(s))
    .filter((s) => isAbsolute(s))
    .map((s) => resolve(s));
  return [...new Set(list)];
}

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Real path of a workspace directory, or `ws_not_allowed`. */
export async function guardWorkspace(rawPath: string, roots: readonly string[]): Promise<string> {
  const refuse = () =>
    new CockpitHostError(
      'ws_not_allowed',
      'This directory is not inside an allowed workspace root.',
      403,
    );
  if (rawPath.includes('\0')) throw refuse();
  // `~` / `~/…` expand on the host (the home dir that matters is the Mac's, not the browser's).
  const absPath = expandHome(rawPath);
  if (!isAbsolute(absPath)) {
    throw new CockpitHostError(
      'ws_path_not_absolute',
      `Path must be absolute (start with "/" or "~/"), e.g. "/${rawPath.replace(/^\.?\/*/, '')}".`,
      400,
    );
  }
  let real: string;
  try {
    real = await realpath(absPath);
    if (!(await stat(real)).isDirectory()) throw refuse();
  } catch (e) {
    if (e instanceof CockpitHostError) throw e;
    throw new CockpitHostError('ws_not_found', 'The workspace directory does not exist.', 404);
  }
  for (const r of roots) {
    let rr: string;
    try {
      rr = await realpath(r);
    } catch {
      continue;
    }
    if (inside(real, rr)) return real;
  }
  throw refuse();
}

/** Absolute path of `rel` inside the (real) workspace; refuses escapes and `.git`. Pure + realpath for symlinks. */
export async function guardFile(wsReal: string, rel: string, mustExist: boolean): Promise<string> {
  const refuse = () => new CockpitHostError('path_not_allowed', 'This path is not allowed.', 403);
  if (!rel || rel.includes('\0') || isAbsolute(rel)) throw refuse();
  const norm = normalize(rel);
  if (norm.startsWith('..') || norm.split(sep).includes('..')) throw refuse();
  if (norm === '.git' || norm.startsWith(`.git${sep}`)) throw refuse();
  const abs = join(wsReal, norm);
  if (!inside(abs, wsReal)) throw refuse();
  try {
    const real = await realpath(abs);
    if (!inside(real, wsReal)) throw refuse();
    return real;
  } catch (e) {
    if (e instanceof CockpitHostError) throw e;
    if (mustExist) throw new CockpitHostError('file_not_found', 'File not found.', 404);
    const parent = await realpath(dirname(abs)).catch(() => {
      throw new CockpitHostError('file_not_found', 'Parent directory not found.', 404);
    });
    if (!inside(parent, wsReal)) throw refuse();
    return abs;
  }
}

export function git(
  cwd: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; allowExit?: number[]; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolveP, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      {
        cwd,
        env: { ...childEnv(cwd), ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code = (err as (Error & { code?: number }) | null)?.code;
        if (err && !(typeof code === 'number' && opts.allowExit?.includes(code))) {
          reject(
            new CockpitHostError(
              'git_failed',
              `git ${args[0]} failed: ${(stderr || err.message).split('\n')[0]?.slice(0, 300)}`,
            ),
          );
          return;
        }
        resolveP(stdout);
      },
    );
  });
}

/**
 * Tree of the CURRENT working directory (tracked + untracked, .gitignore respected) without touching the real index:
 * a temporary index starts from HEAD, `add -A`, `write-tree`.
 */
export async function snapshotTree(cwd: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git(cwd, ['read-tree', 'HEAD'], { env }).catch(() =>
      git(cwd, ['read-tree', '--empty'], { env }),
    );
    await git(cwd, ['add', '-A'], { env });
    return (await git(cwd, ['write-tree'], { env })).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `git diff` output (with `diff --git` headers) → DiffFile[] (hunks only in `diff`). Pure; exported for tests. */
export function parseGitDiff(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  const blocks = text.split(/^diff --git /m).slice(1);
  for (const b of blocks) {
    const lines = b.split('\n');
    const head = lines[0] ?? '';
    const m = /^a\/(.+?) b\/(.+)$/.exec(head);
    let oldPath = m?.[1] ?? head;
    let newPath = m?.[2] ?? head;
    let kind: DiffFile['kind'] = 'modified';
    let binary = false;
    let i = 1;
    for (; i < lines.length && !lines[i]!.startsWith('@@'); i++) {
      const l = lines[i]!;
      if (l.startsWith('new file mode')) kind = 'added';
      else if (l.startsWith('deleted file mode')) kind = 'deleted';
      else if (l.startsWith('rename from ')) {
        kind = 'renamed';
        oldPath = l.slice('rename from '.length);
      } else if (l.startsWith('rename to ')) newPath = l.slice('rename to '.length);
      else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) binary = true;
    }
    const body = lines.slice(i).join('\n').replace(/\n$/, '');
    const hunkLines = body.split('\n');
    const additions = hunkLines.filter((l) => l.startsWith('+')).length;
    const deletions = hunkLines.filter((l) => l.startsWith('-')).length;
    const tooLarge = body.length > 400_000;
    out.push({
      path: newPath,
      oldPath: kind === 'renamed' ? oldPath : kind === 'deleted' ? oldPath : null,
      kind,
      diff: binary || tooLarge || body === '' ? null : body,
      binary,
      tooLarge,
      collapsed: false,
      additions,
      deletions,
    });
  }
  return out;
}

export async function diffTrees(cwd: string, from: string, to: string): Promise<DiffFile[]> {
  return parseGitDiff(await git(cwd, ['diff', '--no-ext-diff', '-M', '--unified=3', from, to]));
}

export interface WsStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: { path: string; code: string }[];
  head: string | null;
}

/** `git status --porcelain=v2 --branch` → status. Pure parser exported for tests. */
export function parseStatus(text: string): WsStatus {
  const s: WsStatus = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: [], head: null };
  for (const l of text.split('\n')) {
    if (l.startsWith('# branch.head '))
      s.branch = l.slice(14) === '(detached)' ? null : l.slice(14);
    else if (l.startsWith('# branch.oid '))
      s.head = l.slice(13) === '(initial)' ? null : l.slice(13);
    else if (l.startsWith('# branch.upstream ')) s.upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      s.ahead = Number(m?.[1] ?? 0);
      s.behind = Number(m?.[2] ?? 0);
    } else if (l.startsWith('1 ') || l.startsWith('u ')) {
      const parts = l.split(' ');
      s.dirty.push({ code: parts[1] ?? '', path: parts.slice(8).join(' ') });
    } else if (l.startsWith('2 ')) {
      const parts = l.split('\t')[0]!.split(' ');
      s.dirty.push({ code: parts[1] ?? '', path: parts.slice(9).join(' ') });
    } else if (l.startsWith('? ')) s.dirty.push({ code: '??', path: l.slice(2) });
  }
  return s;
}

export async function wsStatus(cwd: string): Promise<WsStatus> {
  return parseStatus(
    await git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
  );
}

export async function wsTree(cwd: string): Promise<{ paths: string[]; truncated: boolean }> {
  const out = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard']);
  const paths = [...new Set(out.split('\n').filter(Boolean))].sort();
  return { paths: paths.slice(0, TREE_MAX), truncated: paths.length > TREE_MAX };
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export async function readWsFile(
  wsReal: string,
  rel: string,
): Promise<{ content: string; hash: string; size: number }> {
  const abs = await guardFile(wsReal, rel, true);
  const st = await lstat(abs);
  if (!st.isFile()) throw new CockpitHostError('not_a_file', 'Not a regular file.', 422);
  if (st.size > FILE_MAX)
    throw new CockpitHostError('file_too_large', 'File is larger than 1 MB.', 413);
  const buf = await readFile(abs);
  if (buf.includes(0))
    throw new CockpitHostError('binary_file', 'Binary files cannot be edited here.', 415);
  return { content: buf.toString('utf8'), hash: sha256(buf), size: st.size };
}

/**
 * Writes a file atomically. `expectedHash` = the hash read before editing (null = must not exist yet): a mismatch
 * means someone (an agent!) changed it meanwhile → 409, nothing written.
 */
export async function writeWsFile(
  wsReal: string,
  rel: string,
  content: string,
  expectedHash: string | null,
): Promise<{ hash: string }> {
  if (Buffer.byteLength(content) > FILE_MAX) {
    throw new CockpitHostError('file_too_large', 'File is larger than 1 MB.', 413);
  }
  const abs = await guardFile(wsReal, rel, false);
  const current = await readFile(abs).catch(() => null);
  const currentHash = current ? sha256(current) : null;
  if (currentHash !== expectedHash) {
    throw new CockpitHostError(
      'file_changed',
      'The file changed since it was opened. Reload it first.',
      409,
    );
  }
  const tmp = `${abs}.cockpit-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, abs);
  return { hash: sha256(Buffer.from(content, 'utf8')) };
}

const REF_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Saves a file for an agent under `.git/cockpit-attachments/<group>/`: inside the workspace (so the agent may read it)
 * yet never part of a commit. Both names are reduced to safe characters, so they cannot leave that directory.
 */
export async function saveAttachment(
  cwd: string,
  group: string,
  name: string,
  dataBase64: string,
): Promise<string> {
  const safe = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(-120) || 'attachment';
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
  const dir = join(gitDir, 'cockpit-attachments', safe(group));
  await mkdir(dir, { recursive: true });
  const file = join(dir, safe(name));
  await writeFile(file, Buffer.from(dataBase64, 'base64'));
  return file;
}

/**
 * Checkpoint before an agent turn: snapshot tree → commit → `refs/cockpit/<ws>/<n>`. Keeps the last 50.
 * Returns the checkpoint number.
 */
export async function checkpoint(cwd: string, wsId: string): Promise<number> {
  if (!REF_RE.test(wsId)) throw new CockpitHostError('validation', 'invalid workspace id', 422);
  const tree = await snapshotTree(cwd);
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `refs/cockpit/${wsId}/`]))
    .split('\n')
    .filter(Boolean);
  const nums = refs.map((r) => Number(r.split('/').pop())).filter(Number.isInteger);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  const commit = (
    await git(cwd, ['commit-tree', tree, '-m', `cockpit checkpoint ${n}`], {
      env: {
        GIT_AUTHOR_NAME: 'cockpit',
        GIT_AUTHOR_EMAIL: 'cockpit@localhost',
        GIT_COMMITTER_NAME: 'cockpit',
        GIT_COMMITTER_EMAIL: 'cockpit@localhost',
      },
    })
  ).trim();
  await git(cwd, ['update-ref', `refs/cockpit/${wsId}/${n}`, commit]);
  for (const old of nums.sort((a, b) => a - b).slice(0, Math.max(0, nums.length + 1 - 50))) {
    await git(cwd, ['update-ref', '-d', `refs/cockpit/${wsId}/${old}`]).catch(() => undefined);
  }
  return n;
}

export async function latestCheckpoint(cwd: string, wsId: string): Promise<number | null> {
  if (!REF_RE.test(wsId)) return null;
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `refs/cockpit/${wsId}/`]))
    .split('\n')
    .filter(Boolean);
  const nums = refs.map((r) => Number(r.split('/').pop())).filter(Number.isInteger);
  return nums.length ? Math.max(...nums) : null;
}

export type DiffMode = 'working' | 'branch' | 'turn';

/** Diffs for the Review Deck `local` source. */
export async function wsDiff(
  cwd: string,
  wsId: string,
  mode: DiffMode,
  base: string | undefined,
): Promise<{ files: DiffFile[]; label: string }> {
  const now = await snapshotTree(cwd);
  if (mode === 'working') {
    const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}']).catch(() => '')).trim();
    const from = head || (await git(cwd, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
    return { files: await diffTrees(cwd, from, now), label: 'working tree vs HEAD' };
  }
  if (mode === 'branch') {
    const b = base?.trim() || 'main';
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(b) || b.startsWith('-')) {
      throw new CockpitHostError('validation', 'invalid base branch', 422);
    }
    const mb = (await git(cwd, ['merge-base', b, 'HEAD'])).trim();
    return { files: await diffTrees(cwd, mb, now), label: `${b}...working tree` };
  }
  const n = base ? Number(base) : await latestCheckpoint(cwd, wsId);
  if (!n || !Number.isInteger(n) || !REF_RE.test(wsId)) {
    throw new CockpitHostError('no_checkpoint', 'No agent turn checkpoint yet.', 404);
  }
  return {
    files: await diffTrees(cwd, `refs/cockpit/${wsId}/${n}^{tree}`, now),
    label: `giliran agent #${n}`,
  };
}

/** Repo identity for validation: top-level dir, branch, origin URL (credentials stripped). */
export async function wsIdentity(
  cwd: string,
): Promise<{ top: string; branch: string | null; origin: string | null }> {
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const branch =
    (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
  const originRaw = (await git(cwd, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const origin = originRaw ? originRaw.replace(/\/\/[^@/]+@/, '//') : null;
  return { top, branch: branch === 'HEAD' ? null : branch, origin };
}
