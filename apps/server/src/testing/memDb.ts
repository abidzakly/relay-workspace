import { openDatabase, runMigrations, type AppDb } from '../db';
import { createLogger } from '../util/logger';

/** A migrated in-memory DB + a silent logger (cockpit tests). */
export function memDb(): AppDb {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

export const silentLog = createLogger({ level: 'silent' });
