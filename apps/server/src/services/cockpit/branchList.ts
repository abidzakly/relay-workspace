import type { LocalBranch } from '@relay/shared';
import { git } from './workspaceFs';

/**
 * The branches a workspace on the Mac knows: local heads and `origin/*` remote-tracking refs (as of the last fetch),
 * merged by name. Read-only; fetching is a separate, explicit step.
 */

const SEP = '\u001f';
const FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(committerdate:unix)',
  '%(authorname)',
  '%(subject)',
  '%(upstream:track,nobracket)',
  '%(upstream)',
  '%(HEAD)',
].join(SEP);

/** `ahead 2, behind 1` / `gone` / `` → track. Pure, exported for tests. */
export function parseTrack(raw: string): LocalBranch['track'] {
  const t = raw.trim();
  if (!t) return { ahead: 0, behind: 0, gone: false };
  if (t === 'gone') return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(t);
  const behind = /behind (\d+)/.exec(t);
  return { ahead: Number(ahead?.[1] ?? 0), behind: Number(behind?.[1] ?? 0), gone: false };
}

/** `git for-each-ref` output (FORMAT, one ref per line) → branches by name. Pure, exported for tests. */
export function parseBranchRefs(text: string): LocalBranch[] {
  const byName = new Map<string, LocalBranch>();
  const blank = (name: string): LocalBranch => ({
    name,
    local: false,
    remote: false,
    current: false,
    sha: null,
    committedAt: null,
    author: null,
    subject: null,
    track: null,
  });
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [
      ref = '',
      sha = '',
      when = '',
      author = '',
      subject = '',
      track = '',
      upstream = '',
      head = '',
    ] = line.split(SEP);
    let name: string;
    let local: boolean;
    if (ref.startsWith('refs/heads/')) {
      name = ref.slice(11);
      local = true;
    } else if (ref.startsWith('refs/remotes/origin/')) {
      name = ref.slice(20);
      local = false;
      if (name === 'HEAD') continue;
    } else continue;
    const b = byName.get(name) ?? blank(name);
    const at = Number(when) > 0 ? Number(when) * 1000 : null;
    if (local) {
      // The local head describes the branch as it will run; the remote fills in only what is missing.
      b.local = true;
      b.current = head.trim() === '*';
      b.sha = sha || null;
      b.committedAt = at;
      b.author = author || null;
      b.subject = subject || null;
      b.track = upstream.trim() ? parseTrack(track) : null;
    } else {
      b.remote = true;
      if (!b.local) {
        b.sha = sha || null;
        b.committedAt = at;
        b.author = author || null;
        b.subject = subject || null;
      }
    }
    byName.set(name, b);
  }
  // A local branch whose upstream is not origin/<same name> still has no `remote` flag: honest, not guessed.
  for (const b of byName.values()) if (!b.local) b.track = null;
  return [...byName.values()].sort((a, b) => (b.committedAt ?? 0) - (a.committedAt ?? 0));
}

export async function wsListBranches(cwd: string): Promise<LocalBranch[]> {
  const out = await git(cwd, [
    'for-each-ref',
    `--format=${FORMAT}`,
    'refs/heads',
    'refs/remotes/origin',
  ]);
  return parseBranchRefs(out);
}
