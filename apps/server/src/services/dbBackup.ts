import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

const TMP_PREFIX = '.db-backup-';

const workDir = (sqlite: Database.Database): string =>
  sqlite.memory ? tmpdir() : dirname(sqlite.name);

/** Removes copies a crash left behind: they hold the same data as the DB. Called once at startup. */
export function sweepBackupLeftovers(sqlite: Database.Database): void {
  if (sqlite.memory) return;
  const dir = workDir(sqlite);
  for (const name of readdirSync(dir)) {
    if (name.startsWith(TMP_PREFIX)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * A consistent copy through SQLite's online backup API, so pages still in the WAL are included and writers carry on.
 * Copying `app.db` by hand would miss them. The copy sits in an owner-only folder next to the DB, and is unlinked as
 * soon as it is open: the returned handle is the only way to reach it, and it disappears when the handle closes.
 */
export async function createDbBackup(
  sqlite: Database.Database,
): Promise<{ handle: FileHandle; size: number }> {
  const dir = await mkdtemp(join(workDir(sqlite), TMP_PREFIX));
  try {
    const file = join(dir, 'backup.db');
    await sqlite.backup(file);
    await chmod(file, 0o600);
    const handle = await open(file, 'r');
    try {
      return { handle, size: (await handle.stat()).size };
    } catch (e) {
      await handle.close();
      throw e;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
