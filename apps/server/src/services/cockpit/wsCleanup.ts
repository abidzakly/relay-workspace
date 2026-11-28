import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeBranchName } from '@relay/shared';
import { CockpitHostError } from './host';
import { git } from './workspaceFs';

/**
 * The Mac side of the storage cleanup (no AI). The host only reports facts and deletes what it is told to, and only
 * inside fixed places: `<git dir>/cockpit-attachments/<group>`, `refs/cockpit/*`, local branches (`refs/heads/*`)
 * named leftovers in the OS temp dir, and a Flutter workspace's git-ignored `build/` (what `flutter run` writes, debug
 * APK included). Every delete re-checks the item at that moment:
 *  - refs and branches are removed with `update-ref -d <ref> <expected sha>`, so a branch that moved is kept;
 *  - a branch delete without `force` also re-checks that its tip is inside `origin/<base>`;
 *  - the checked-out branch is never deleted; paths are `lstat`ed, so a symlink is never followed.
 * The server decides what is stale (it has the cards, MRs and findings); see `services/cleanup/rules.ts`.
 */

export interface WsCleanupFacts {
  gitDir: string;
  /** Checked-out branch, null when detached. */
  head: string | null;
  /** Whether `origin/<base>` exists (no merged check without it). */
  baseKnown: boolean;
  attachments: { group: string; bytes: number; mtimeMs: number }[];
  refs: { name: string; sha: string; committedAt: number }[];
  branches: {
    name: string;
    tip: string;
    committedAt: number;
    upstream: string | null;
    /** The upstream branch was deleted on origin (`[gone]` after a prune). */
    upstreamGone: boolean;
    /** Tip is an ancestor of `origin/<base>`: every commit is in the base. */
    inBase: boolean;
  }[];
  /** The workspace's Flutter `build/` folder, when there is one. Absent from older agents. */
  builds?: { rel: BuildRel; bytes: number; mtimeMs: number }[];
}

/** The only build folder the cleanup touches: `<workspace>/build`, the output of `flutter run` and `flutter build`. */
export const BUILD_DIR = 'build';

/**
 * Every build folder the cleanup may touch: Flutter's `build/`, and what a web dev server or build leaves (Nuxt
 * `.nuxt`/`.output`, Next `.next`, `dist`, Vite's dependency cache). Each only when git ignores it.
 */
export const BUILD_DIRS = [
  BUILD_DIR,
  '.nuxt',
  '.output',
  '.next',
  'dist',
  'node_modules/.vite',
] as const;
export type BuildRel = (typeof BUILD_DIRS)[number];
export const isBuildRel = (v: string): v is BuildRel =>
  (BUILD_DIRS as readonly string[]).includes(v);

export type WsCleanupItem =
  | { kind: 'attachment'; group: string }
  | { kind: 'ref'; name: string; sha: string }
  | { kind: 'branch'; name: string; tip: string; force: boolean }
  | { kind: 'build'; rel: BuildRel }
  | { kind: 'prune' };

export interface CleanupApplyResult {
  done: string[];
  failed: { item: string; reason: string }[];
}

export interface TmpCleanupFacts {
  /** When the host process started: a shim dir older than this belongs to an earlier run. */
  startedAt: number;
  entries: { name: string; kind: TmpKind; bytes: number; mtimeMs: number }[];
}

export type TmpKind =
  'bench-config' | 'bench-cursor-dir' | 'bench-web-dir' | 'agent-shim' | 'git-index' | 'squash';

const TMP_PATTERNS: readonly [RegExp, TmpKind][] = [
  [/^cockpit-bench-[0-9a-f-]{36}\.json$/, 'bench-config'],
  [/^cockpit-bench-cursor-[0-9a-f]{8}-[A-Za-z0-9]{6}$/, 'bench-cursor-dir'],
  [/^cockpit-bench-web-[0-9a-f-]{36}$/, 'bench-web-dir'],
  [/^(?:relay|core-dashboard)-agent-[A-Za-z0-9]{6}$/, 'agent-shim'],
  [/^cockpit-idx-[A-Za-z0-9]{6}$/, 'git-index'],
  [/^cockpit-squash-[A-Za-z0-9]{6}$/, 'squash'],
];

const GROUP_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
/** `refs/cockpit/<kind>/<name…>`: the name part follows the branch rules (it often is a branch: pre-squash backups). */
const isCockpitRef = (name: string) => {
  if (!name.startsWith('refs/cockpit/')) return false;
  const rest = name.slice('refs/cockpit/'.length);
  return rest.includes('/') && isSafeBranchName(rest);
};
const SHA_RE = /^[0-9a-f]{40,64}$/;

const tmpKind = (name: string): TmpKind | null =>
  TMP_PATTERNS.find(([re]) => re.test(name))?.[1] ?? null;

/** Bytes under a path, never following a symlink. Capped walk: it only informs the UI. */
async function sizeOf(
  path: string,
  budget = { n: 5_000 },
): Promise<{ bytes: number; mtimeMs: number }> {
  const st = await lstat(path);
  if (st.isSymbolicLink() || !st.isDirectory()) return { bytes: st.size, mtimeMs: st.mtimeMs };
  let bytes = 0;
  let mtimeMs = st.mtimeMs;
  for (const name of await readdir(path)) {
    if (--budget.n < 0) break;
    const sub = await sizeOf(join(path, name), budget).catch(() => null);
    if (!sub) continue;
    bytes += sub.bytes;
    mtimeMs = Math.max(mtimeMs, sub.mtimeMs);
  }
  return { bytes, mtimeMs };
}

const lines = (s: string) => s.split('\n').filter(Boolean);

/**
 * `<cwd>/build` when it is a Flutter build output: the workspace has a `pubspec.yaml`, `build` is a real folder (never
 * a symlink), and git ignores it, so nothing tracked can be in it. Null otherwise.
 */
/** `build/` of a Flutter workspace, the web folders of one with `package.json` and no `pubspec.yaml`. */
async function buildDir(cwd: string, rel: BuildRel): Promise<string | null> {
  const isFile = async (f: string) =>
    (await lstat(join(cwd, f)).catch(() => null))?.isFile() ?? false;
  const flutter = await isFile('pubspec.yaml');
  if (rel === BUILD_DIR ? !flutter : flutter || !(await isFile('package.json'))) return null;
  const path = join(cwd, rel);
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory() || st.isSymbolicLink()) return null;
  // Prints the path when it is ignored; exit 1 with no output when it is not. The slash matches `build/` patterns too.
  const ignored = await git(cwd, ['check-ignore', `${rel}/`], { allowExit: [1] });
  return ignored.trim() === `${rel}/` ? path : null;
}

export async function wsCleanupFacts(cwd: string, base: string): Promise<WsCleanupFacts> {
  if (!isSafeBranchName(base)) {
    throw new CockpitHostError('validation', 'invalid base branch', 422);
  }
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
  const head =
    (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowExit: [1] })).trim() || null;

  const attachments: WsCleanupFacts['attachments'] = [];
  const dir = join(gitDir, 'cockpit-attachments');
  for (const group of await readdir(dir).catch(() => [] as string[])) {
    if (!GROUP_RE.test(group)) continue;
    const st = await lstat(join(dir, group)).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) continue;
    const s = await sizeOf(join(dir, group)).catch(() => null);
    if (s) attachments.push({ group, ...s });
  }

  const refs = lines(
    await git(cwd, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(committerdate:unix)',
      'refs/cockpit/',
    ]),
  ).map((l) => {
    const [name = '', sha = '', at = '0'] = l.split('\t');
    return { name, sha, committedAt: Number(at) * 1000 };
  });

  const originBase = `refs/remotes/origin/${base}`;
  const baseKnown =
    (
      await git(cwd, ['rev-parse', '--verify', '--quiet', `${originBase}^{commit}`], {
        allowExit: [1],
      })
    ).trim() !== '';
  const merged = new Set(
    baseKnown
      ? lines(
          await git(cwd, [
            'for-each-ref',
            '--format=%(refname:short)',
            `--merged=${originBase}`,
            'refs/heads/',
          ]),
        )
      : [],
  );
  const branches = lines(
    await git(cwd, [
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)',
      'refs/heads/',
    ]),
  ).map((l) => {
    const [name = '', tip = '', at = '0', upstream = '', track = ''] = l.split('\t');
    return {
      name,
      tip,
      committedAt: Number(at) * 1000,
      upstream: upstream || null,
      upstreamGone: track.includes('gone'),
      inBase: merged.has(name),
    };
  });
  const builds: NonNullable<WsCleanupFacts['builds']> = [];
  for (const rel of BUILD_DIRS) {
    const path = await buildDir(cwd, rel).catch(() => null);
    if (!path) continue;
    // A build folder holds tens of thousands of files: a bigger walk, so the size shown is close to the real one.
    const s = await sizeOf(path, { n: 200_000 }).catch(() => null);
    if (s) builds.push({ rel, ...s });
  }
  return { gitDir, head, baseKnown, attachments, refs, branches, builds };
}

export async function wsCleanupApply(
  cwd: string,
  base: string,
  items: readonly WsCleanupItem[],
): Promise<CleanupApplyResult> {
  if (!isSafeBranchName(base)) {
    throw new CockpitHostError('validation', 'invalid base branch', 422);
  }
  const done: string[] = [];
  const failed: CleanupApplyResult['failed'] = [];
  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
  const head = (
    await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowExit: [1] })
  ).trim();

  for (const item of items) {
    const label =
      item.kind === 'attachment'
        ? `attachment ${item.group}`
        : item.kind === 'ref'
          ? item.name
          : item.kind === 'branch'
            ? `branch ${item.name}`
            : item.kind === 'build'
              ? 'build folder'
              : 'prune';
    try {
      switch (item.kind) {
        case 'attachment': {
          if (!GROUP_RE.test(item.group)) throw new Error('invalid group');
          const path = join(gitDir, 'cockpit-attachments', item.group);
          const st = await lstat(path);
          if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('not a folder');
          await rm(path, { recursive: true, force: true });
          break;
        }
        case 'ref': {
          if (!isCockpitRef(item.name) || !SHA_RE.test(item.sha)) {
            throw new Error('not a cockpit ref');
          }
          // Old-value check: a ref that changed since the scan is kept.
          await git(cwd, ['update-ref', '-d', item.name, item.sha]);
          break;
        }
        case 'branch': {
          if (!isSafeBranchName(item.name) || !SHA_RE.test(item.tip)) {
            throw new Error('invalid branch');
          }
          if (item.name === head) throw new Error('checked out');
          if (!item.force) {
            // Exit 1 = not an ancestor; without allowExit it rejects.
            const inBase = await git(cwd, [
              'merge-base',
              '--is-ancestor',
              item.tip,
              `refs/remotes/origin/${base}`,
            ]).then(
              () => true,
              () => false,
            );
            if (!inBase) throw new Error(`has commits that are not in origin/${base}`);
          }
          await git(cwd, ['update-ref', '-d', `refs/heads/${item.name}`, item.tip]);
          await git(cwd, ['config', '--remove-section', `branch.${item.name}`], {
            allowExit: [128],
          }).catch(() => undefined);
          break;
        }
        case 'build': {
          if (!isBuildRel(item.rel)) throw new Error('not a build folder');
          const path = await buildDir(cwd, item.rel);
          if (!path) throw new Error('not a git-ignored build folder');
          await rm(path, { recursive: true, force: true });
          break;
        }
        case 'prune': {
          await git(cwd, ['fetch', '--prune', '--quiet', 'origin'], { timeoutMs: 120_000 });
          await git(cwd, ['gc', '--auto', '--quiet'], { timeoutMs: 300_000 });
          break;
        }
      }
      done.push(label);
    } catch (e) {
      failed.push({ item: label, reason: (e as Error).message.split('\n')[0] ?? 'failed' });
    }
  }
  return { done, failed };
}

const startedAt = Date.now() - Math.round(process.uptime() * 1000);

export async function tmpCleanupFacts(): Promise<TmpCleanupFacts> {
  const root = tmpdir();
  const entries: TmpCleanupFacts['entries'] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const kind = tmpKind(name);
    if (!kind) continue;
    const s = await sizeOf(join(root, name)).catch(() => null);
    if (s) entries.push({ name, kind, ...s });
  }
  return { startedAt, entries };
}

export async function tmpCleanupApply(names: readonly string[]): Promise<CleanupApplyResult> {
  const root = tmpdir();
  const done: string[] = [];
  const failed: CleanupApplyResult['failed'] = [];
  for (const name of names) {
    try {
      if (!tmpKind(name) || /[/\\]/.test(name)) throw new Error('not a cockpit temp file');
      const st = await lstat(join(root, name));
      if (st.isSymbolicLink()) throw new Error('symlink');
      await rm(join(root, name), { recursive: true, force: true });
      done.push(name);
    } catch (e) {
      failed.push({ item: name, reason: (e as Error).message });
    }
  }
  return { done, failed };
}
