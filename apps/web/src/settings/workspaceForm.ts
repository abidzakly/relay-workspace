import { uniqueRepoId } from './repoWizard/derive';

/** Same cap as the server's workspace name. */
const NAME_MAX = 60;

/**
 * The name a workspace gets when none is typed: the repo's name (or the folder's) as a slug, e.g. `MDD Config` ->
 * `mdd-config`, with `-2`, `-3`… when another workspace has it.
 */
export function workspaceName(source: string, taken: readonly string[]): string {
  const base =
    source
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || 'workspace';
  return uniqueRepoId(base, taken).slice(0, NAME_MAX).replace(/-+$/, '');
}

/** `git@host:group/app.git` and `https://host/group/app` -> `host/group/app`; null when not a git address. */
function remoteKey(url: string): string | null {
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url.trim());
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(url.trim());
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const p = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return p ? `${host.toLowerCase()}/${p.toLowerCase()}` : null;
}

/** Two git remotes point at the same project, whatever the protocol. */
export function sameGitRemote(a: string, b: string): boolean {
  const ka = remoteKey(a);
  return ka !== null && ka === remoteKey(b);
}
