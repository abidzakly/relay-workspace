import { existsSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../util/logger';

/**
 * The folders this app used before it was renamed to Relay, and where they live now:
 *   ~/.config/core-dashboard  -> ~/.config/relay   (scripts.env)
 *   ~/.core-dashboard         -> ~/.relay          (bot clones)
 * On start, each old folder is moved once, and only when the new one does not exist yet. A link is left at the old
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

export function moveLegacyDirs(log: Logger, moves = legacyDirMoves()): void {
  for (const [from, to] of moves) {
    if (!existsSync(from) || existsSync(to)) continue;
    try {
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
