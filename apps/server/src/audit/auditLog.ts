import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, isNull, lt, type SQL } from 'drizzle-orm';
import type { AuditActor, AuditEntry, AuditListQuery } from '@relay/shared';
import type { AppDb } from '../db';
import { schema } from '../db';
import { redactSecrets } from './redact';

export interface AuditInput {
  actor: AuditActor;
  /** Namespaced verb, e.g. `repo.create`, `settings.update`, `card.status`. */
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  /** Write was only simulated (global dry-run). Simulated writes never get an undo token. */
  dryRun?: boolean;
  /** Set ONLY for reversible, really-executed writes. */
  undoToken?: string | null;
  batchId?: string | null;
  undoOf?: number | null;
}

export function newUndoToken(): string {
  return randomBytes(16).toString('hex');
}

type Row = typeof schema.auditLog.$inferSelect;

function toEntry(r: Row): AuditEntry {
  return {
    id: r.id,
    at: r.at,
    actor: r.actor as AuditActor,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    before: (r.before ?? null) as AuditEntry['before'],
    after: (r.after ?? null) as AuditEntry['after'],
    dryRun: r.dryRun,
    undoToken: r.undoToken ?? null,
    undoneAt: r.undoneAt ?? null,
    batchId: r.batchId ?? null,
    undoOf: r.undoOf ?? null,
  };
}

/**
 * Writes `audit_log` rows (every write -> before/after + undo token when reversible).
 * before/after pass through `redactSecrets` as a last line of defence.
 */
export class AuditWriter {
  /** `onWritten` runs after the row is stored (SSE `audit.added`); it can never fail the write. */
  constructor(
    private readonly app: AppDb,
    private readonly onWritten?: (entry: AuditEntry) => void,
  ) {}

  write(input: AuditInput): AuditEntry {
    const dryRun = input.dryRun ?? false;
    const [row] = this.app.db
      .insert(schema.auditLog)
      .values({
        actor: input.actor,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        before: redactSecrets(input.before),
        after: redactSecrets(input.after),
        dryRun,
        undoToken: dryRun ? null : (input.undoToken ?? null),
        batchId: input.batchId ?? null,
        undoOf: input.undoOf ?? null,
      })
      .returning()
      .all();
    if (!row) throw new Error('audit insert returned no row');
    const entry = toEntry(row);
    try {
      this.onWritten?.(entry);
    } catch {
      /* a listener problem must never undo or fail an audited write */
    }
    return entry;
  }

  /**
   * Stamps `undone_at` on a reverted row. Atomic: false when it was already undone (a concurrent or
   * repeated undo), so the caller can tell. The row itself is otherwise never changed (append-only).
   */
  markUndone(id: number, at: number): boolean {
    const res = this.app.db
      .update(schema.auditLog)
      .set({ undoneAt: at })
      .where(and(eq(schema.auditLog.id, id), isNull(schema.auditLog.undoneAt)))
      .run();
    return res.changes > 0;
  }

  get(id: number): AuditEntry | undefined {
    const row = this.app.db.select().from(schema.auditLog).where(eq(schema.auditLog.id, id)).get();
    return row ? toEntry(row) : undefined;
  }

  /** Every row of a batch, oldest first. */
  listBatch(batchId: string): AuditEntry[] {
    return this.app.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.batchId, batchId))
      .orderBy(asc(schema.auditLog.id))
      .all()
      .map(toEntry);
  }

  /** Newest first; `limit` rows starting below `beforeId`. */
  list(q: AuditListQuery): AuditEntry[] {
    const t = schema.auditLog;
    const where: SQL[] = [];
    if (q.action) where.push(eq(t.action, q.action));
    if (q.actor) where.push(eq(t.actor, q.actor));
    if (q.targetType) where.push(eq(t.targetType, q.targetType));
    if (q.batchId) where.push(eq(t.batchId, q.batchId));
    if (q.beforeId) where.push(lt(t.id, q.beforeId));
    if (q.onlyUndoable) {
      where.push(isNotNull(t.undoToken), isNull(t.undoneAt), eq(t.dryRun, false));
    }
    return this.app.db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.id))
      .limit(q.limit)
      .all()
      .map(toEntry);
  }

  /** Distinct values for the filter menus. */
  facets(): { actions: string[]; targetTypes: string[] } {
    const t = schema.auditLog;
    return {
      actions: this.app.db
        .selectDistinct({ v: t.action })
        .from(t)
        .orderBy(asc(t.action))
        .all()
        .map((r) => r.v),
      targetTypes: this.app.db
        .selectDistinct({ v: t.targetType })
        .from(t)
        .orderBy(asc(t.targetType))
        .all()
        .map((r) => r.v),
    };
  }
}
