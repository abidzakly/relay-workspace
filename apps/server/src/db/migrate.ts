import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { AppDb } from './open';

/**
 * Locates `src/db/migrations` of the server package, whether we run from `src/` (tsx, vitest)
 * or from the bundled `dist/` — by walking up to the package root (the dir with package.json).
 */
export function defaultMigrationsDir(
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      const candidate = join(dir, 'src', 'db', 'migrations');
      if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate src/db/migrations starting from ${fromDir}`);
    }
    dir = parent;
  }
}

/** Applies all pending migrations (idempotent). */
export function runMigrations(app: AppDb, migrationsFolder: string = defaultMigrationsDir()): void {
  migrate(app.db, { migrationsFolder });
}
