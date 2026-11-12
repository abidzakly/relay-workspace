import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeBranchName } from '@relay/shared';
import { CockpitHostError } from './host';
import { git, wsStatus } from './workspaceFs';

/**
 * Branch history ops for the Test Bench. Run where the workspace is (the Mac), with the same
 * `git()` as every workspace op.
 *
 *  - `wsLog`: commits in `base..HEAD` with their trailers (`Test-Finding`, `Deck-Note`), local commits included.
 *  - `squashForMr`: "1 MR = 1 commit" before the MR exists. Every commit since the base becomes the branch's first
 *    commit (its message and author), with the trailers of all of them, then ONE push with `--force-with-lease`
 *    against the remote-tracking value this clone last saw. The tree must be byte-identical before and after.
 *    The server calls it only after confirming no MR is open for the branch.
 */

export interface WsCommit {
  sha: string;
  subject: string;
  /** Trailer key → values, keys as written (e.g. `Test-Finding`). */
  trailers: Record<string, string[]>;
}

export interface SquashResult {
  /** HEAD before / after; equal when there was nothing to squash. */
  oldHead: string;
  newHead: string;
  squashed: number;
  pushed: boolean;
  /** The pre-squash head is kept here for an undo by hand. */
  backupRef: string | null;
}

const LOG_MAX = 200;
const FIELD = '\x1f';
const RECORD = '\x1e';
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]{0,40}):\s?(.+)$/;
const FIXUP_RE = /^(fixup|squash|amend)! /;

function safeRef(ref: string, what: string): string {
  // `origin/<branch>` or a branch: never an option, never a range.
  const bare = ref.startsWith('origin/') ? ref.slice(7) : ref;
  if (!isSafeBranchName(bare)) throw new CockpitHostError('bad_ref', `Unsafe ${what}.`, 422);
  return ref;
}

/** Trailers = `Key: value` lines of the message's last paragraph. Pure. */
export function parseTrailers(message: string): Record<string, string[]> {
  const paras = message.trim().split(/\n\s*\n/);
  const last = paras.length > 1 ? paras.at(-1)! : '';
  const out: Record<string, string[]> = {};
  for (const line of last.split('\n')) {
    const m = TRAILER_RE.exec(line.trim());
    if (!m) continue;
    (out[m[1]!] ??= []).push(m[2]!.trim());
  }
  return out;
}

/** The squashed message: the first commit's message plus every trailer of the others (deduplicated). Pure. */
export function squashMessage(first: string, all: Record<string, string[]>[]): string {
  const own = parseTrailers(first);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [k, vs] of Object.entries(own)) for (const v of vs) seen.add(`${k}: ${v}`);
  for (const t of all) {
    for (const [k, vs] of Object.entries(t)) {
      // Only the trailers this app reads; others (Co-Authored-By …) stay on their own commits' history.
      if (k !== 'Test-Finding' && k !== 'Deck-Note') continue;
      for (const v of vs) {
        const line = `${k}: ${v}`;
        if (!seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      }
    }
  }
  const body = first.trimEnd();
  if (!lines.length) return `${body}\n`;
  const hasTrailerBlock = Object.keys(own).length > 0;
  return `${body}${hasTrailerBlock ? '\n' : '\n\n'}${lines.join('\n')}\n`;
}

export async function wsLog(cwd: string, base: string): Promise<WsCommit[]> {
  safeRef(base, 'base');
  const out = await git(cwd, [
    'log',
    `--max-count=${LOG_MAX}`,
    `--format=%H${FIELD}%B${RECORD}`,
    `${base}..HEAD`,
  ]);
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.includes(FIELD))
    .map((r) => {
      const [sha, msg = ''] = r.split(FIELD);
      return { sha: sha!.trim(), subject: msg.split('\n')[0] ?? '', trailers: parseTrailers(msg) };
    });
}

export async function squashForMr(
  cwd: string,
  branch: string,
  base: string,
): Promise<SquashResult> {
  safeRef(base, 'base');
  if (!isSafeBranchName(branch)) throw new CockpitHostError('bad_ref', 'Unsafe branch.', 422);
  const st = await wsStatus(cwd);
  if (st.branch !== branch) {
    throw new CockpitHostError(
      'wrong_branch',
      `The workspace is on ${st.branch ?? 'a detached HEAD'}, not ${branch}.`,
      409,
    );
  }
  if (st.dirty.some((d) => d.code !== '??')) {
    throw new CockpitHostError('dirty', 'Commit or stash the changes in the workspace first.', 409);
  }
  const oldHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  const mergeBase = (await git(cwd, ['merge-base', base, 'HEAD'])).trim();
  const shas = (await git(cwd, ['rev-list', '--reverse', `${mergeBase}..HEAD`]))
    .split('\n')
    .filter(Boolean);
  if (shas.length === 0)
    throw new CockpitHostError('no_commits', 'The branch has no commits of its own.', 409);

  // Another branch built on this one (a stacked child) would lose its parent: refuse.
  const containing = (
    await git(cwd, [
      'for-each-ref',
      '--format=%(refname:short)',
      '--contains',
      oldHead,
      'refs/heads',
      'refs/remotes/origin',
    ])
  )
    .split('\n')
    .map((s) => s.trim())
    .filter((r) => r && r !== branch && r !== `origin/${branch}` && r !== 'origin/HEAD');
  if (containing.length) {
    throw new CockpitHostError(
      'has_children',
      `Other branches are built on this one (${containing.slice(0, 3).join(', ')}): squash them by hand.`,
      409,
    );
  }

  const tracking = await git(
    cwd,
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    {
      allowExit: [1],
    },
  ).then((s) => s.trim() || null);

  let newHead = oldHead;
  let backupRef: string | null = null;
  if (shas.length > 1) {
    const messages = await Promise.all(shas.map((s) => git(cwd, ['log', '-1', '--format=%B', s])));
    const firstIdx = Math.max(
      0,
      messages.findIndex((m) => !FIXUP_RE.test(m)),
    );
    const first = shas[firstIdx]!;
    const msg = squashMessage(messages[firstIdx]!, messages.map(parseTrailers));
    const author = (await git(cwd, ['log', '-1', '--format=%an <%ae>%x1f%aI', first]))
      .trim()
      .split(FIELD);
    const oldTree = (await git(cwd, ['rev-parse', 'HEAD^{tree}'])).trim();

    backupRef = `refs/cockpit/pre-squash/${branch}`;
    await git(cwd, ['update-ref', backupRef, oldHead]);
    const dir = await mkdtemp(join(tmpdir(), 'cockpit-squash-'));
    try {
      const file = join(dir, 'MSG');
      await writeFile(file, msg);
      await git(cwd, ['reset', '--soft', mergeBase]);
      await git(cwd, [
        'commit',
        '--no-verify',
        `--author=${author[0]}`,
        `--date=${author[1]}`,
        '-F',
        file,
      ]);
    } catch (e) {
      await git(cwd, ['reset', '--soft', oldHead]).catch(() => {});
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    newHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    const newTree = (await git(cwd, ['rev-parse', 'HEAD^{tree}'])).trim();
    if (newTree !== oldTree) {
      await git(cwd, ['reset', '--soft', oldHead]);
      throw new CockpitHostError(
        'tree_changed',
        'The squash changed the files; nothing was pushed.',
        500,
      );
    }
  }

  if (tracking === newHead)
    return { oldHead, newHead, squashed: shas.length, pushed: false, backupRef };
  // Lease = what this clone last saw of the remote branch (empty = it must not exist yet).
  try {
    await git(
      cwd,
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${tracking ?? ''}`,
        'origin',
        `HEAD:refs/heads/${branch}`,
      ],
      { timeoutMs: 120_000 },
    );
  } catch (e) {
    // All or nothing: put the local branch back as it was (same files, so only HEAD moves).
    if (newHead !== oldHead) await git(cwd, ['reset', '--soft', oldHead]).catch(() => {});
    throw new CockpitHostError(
      'push_rejected',
      `The push was refused, so nothing changed: the remote branch moved since this clone last fetched it, or the remote is unreachable. Pull the branch and try again. (${(e as Error).message.slice(0, 160)})`,
      409,
    );
  }
  return { oldHead, newHead, squashed: shas.length, pushed: true, backupRef };
}
