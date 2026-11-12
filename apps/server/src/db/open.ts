import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Schema = typeof schema;
export type DrizzleDb = BetterSQLite3Database<Schema>;

export interface AppDb {
  /** Drizzle query builder. */
  db: DrizzleDb;
  /** Underlying better-sqlite3 handle (pragmas, raw SQL, transactions). */
  sqlite: Database.Database;
  close(): void;
}

export interface OpenDbOptions {
  /** Milliseconds SQLite waits on a locked DB before failing. Default 5000. */
  busyTimeoutMs?: number;
}

/**
 * Opens (creating if needed) the SQLite database with the pragmas this app relies on:
 * WAL journal (readers don't block the single writer), foreign keys ON (SQLite default is OFF,
 * and cascade/integrity rules in the schema depend on it), sane busy timeout.
 * Pass `:memory:` for throw-away DBs.
 */
export function openDatabase(file: string, opts: OpenDbOptions = {}): AppDb {
  const inMemory = file === ':memory:';
  if (!inMemory) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  const sqlite = new Database(file);
  if (!inMemory) {
    try {
      // The DB holds encrypted secrets + webhook payloads: owner-only.
      chmodSync(file, 0o600);
    } catch {
      /* best effort (e.g. unsupported FS) */
    }
  }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma(`busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 5000)}`);

  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
