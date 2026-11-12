import { existsSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../util/logger';

/**
 * The folders this app used before it was renamed to Relay, and where they live now:
 *   ~/.config/core-dashboard  -> ~/.config/relay   (scripts.env)
 *   ~/.core-dashboard         -> ~/.relay          (bot clones)
 * On start, each old folder is moved once, and only when the new one does not exist yet, or holds nothing but empty
 * folders (Docker creates `~/.relay/clones` for its bind mount before this runs). A link is left at the old
 * path, so anything that still names it (a repo's saved local path, older copies of the release scripts) keeps
 * working. Nothing is ever deleted; a failure is logged and the app starts anyway.
 */
export function legacyDirMoves(env: NodeJS.ProcessEnv = process.env): [string, string][] {
  const home = homedir();
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return [
    [join(config, 'core-dashboard'), join(config, 'relay')],
    [join(home, '.core-dashboard'), join(home, '.relay')],
  ];
}

/** true when `dir` holds no files at any depth: only (nested) empty folders. */
export function onlyEmptyFolders(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).every(
      (e) => e.isDirectory() && !e.isSymbolicLink() && onlyEmptyFolders(join(dir, e.name)),
    );
  } catch {
    return false;
  }
}

export function moveLegacyDirs(log: Logger, moves = legacyDirMoves()): void {
  for (const [from, to] of moves) {
    if (!existsSync(from)) continue;
    if (existsSync(to) && !onlyEmptyFolders(to)) continue;
    try {
      // Only empty folders are removed here, never a file.
      if (existsSync(to)) rmSync(to, { recursive: true });
      renameSync(from, to);
    } catch (err) {
      log.warn(
        { from, to, err: err instanceof Error ? err.message : String(err) },
        'could not move a folder from before the rename to Relay; the old one stays in use',
      );
      continue;
    }
    try {
      // A junction needs no admin rights on Windows; elsewhere the type is ignored.
      symlinkSync(to, from, 'junction');
    } catch (err) {
      log.warn(
        { from, to, err: err instanceof Error ? err.message : String(err) },
        'moved a folder for the rename to Relay, but could not leave a link at the old path',
      );
    }
    log.info({ from, to }, 'moved a folder for the rename to Relay');
  }
}
