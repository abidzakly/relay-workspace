import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { ReaderCreate, ReaderDoc, ReaderDocSummary, ReaderUpdate } from '@relay/shared';
import type { AppDb } from '../db';
import { readerDocs } from '../db/schema';
import { ActionError } from './actionError';

/** Reader library: plain CRUD over `reader_docs`. */
export class ReaderService {
  constructor(private readonly d: { store: AppDb; now?: () => number }) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  list(): ReaderDocSummary[] {
    return this.d.store.db
      .select({
        id: readerDocs.id,
        title: readerDocs.title,
        format: readerDocs.format,
        size: sql<number>`length(${readerDocs.body})`,
        lastPos: readerDocs.lastPos,
        createdAt: readerDocs.createdAt,
        updatedAt: readerDocs.updatedAt,
      })
      .from(readerDocs)
      .orderBy(desc(readerDocs.updatedAt))
      .all();
  }

  get(id: string): ReaderDoc {
    const row = this.d.store.db.select().from(readerDocs).where(eq(readerDocs.id, id)).get();
    if (!row) throw new ActionError(404, 'reader_not_found', 'This document is gone.');
    return { ...row, size: row.body.length };
  }

  create(input: Required<ReaderCreate>): ReaderDoc {
    const id = randomUUID();
    const t = this.now();
    this.d.store.db
      .insert(readerDocs)
      .values({ id, ...input, lastPos: 0, createdAt: t, updatedAt: t })
      .run();
    return this.get(id);
  }

  update(id: string, patch: ReaderUpdate): ReaderDoc {
    this.get(id);
    // Saving the reading position is not an edit: the library stays ordered by real changes.
    const edited =
      patch.title !== undefined || patch.body !== undefined || patch.format !== undefined;
    this.d.store.db
      .update(readerDocs)
      .set({ ...patch, ...(edited ? { updatedAt: this.now() } : {}) })
      .where(eq(readerDocs.id, id))
      .run();
    return this.get(id);
  }

  remove(id: string): void {
    this.d.store.db.delete(readerDocs).where(eq(readerDocs.id, id)).run();
  }
}
