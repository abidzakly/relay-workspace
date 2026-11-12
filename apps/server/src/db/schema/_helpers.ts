import { sql, type SQL } from 'drizzle-orm';
import { integer, type SQLiteColumn } from 'drizzle-orm/sqlite-core';

/** Epoch milliseconds "now", evaluated by SQLite (so raw inserts get it too). */
export const nowMsSql = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/** `created_at` epoch-ms column defaulting to now. */
export const createdAtCol = () => integer('created_at').notNull().default(nowMsSql);
/** `updated_at` epoch-ms column defaulting to now (application sets it on update). */
export const updatedAtCol = () => integer('updated_at').notNull().default(nowMsSql);

/**
 * `col IN ('a','b',…)` CHECK expression. Values must be trusted constants
 * (they come from packages/shared enum arrays, never from user input).
 */
export function inList(col: SQLiteColumn, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[A-Za-z0-9_:.-]+$/.test(v)) throw new Error(`unsafe enum literal: ${v}`);
  }
  return sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}
