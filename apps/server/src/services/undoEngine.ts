import type { AuditEntry, UndoResult } from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import { ActionError } from './actionError';

/**
 * Generic undo engine.
 *
 * The engine owns the checks every undo shares (entry exists, was a real write, carries an undo token, not
 * undone yet) and the bookkeeping (`undone_at`). WHAT an undo does is owned by a handler registered per audit
 * `action` (`mr.resolve`, `card.status`, later `card.bulkReady`…). A handler restores the BEFORE state stored in
 * the audit row, through `guardedWrite` (so dry-run and audit apply to the undo too), and must refuse with an
 * `ActionError` - writing nothing - when the target has been changed by someone else since (`undo_conflict`).
 */

export interface UndoOutcome {
  /** The undo itself was only simulated (global dry-run): the original stays undoable. */
  dryRun: boolean;
  /** The new `undo` audit row. */
  auditId: number;
  /** Rows this undo really reverted, when not simply the requested one (a partly restorable batch). */
  undoneIds?: number[];
  batch?: NonNullable<UndoResult['batch']>;
}

export interface UndoHandler {
  /** The audit `action` this handler can revert. */
  action: string;
  undo(entry: AuditEntry): Promise<UndoOutcome>;
}

export class UndoEngine {
  private readonly handlers = new Map<string, UndoHandler>();

  constructor(
    private readonly audit: AuditWriter,
    private readonly now: () => number = Date.now,
  ) {}

  register(handler: UndoHandler): void {
    if (this.handlers.has(handler.action)) {
      throw new Error(`undo handler for "${handler.action}" is already registered`);
    }
    this.handlers.set(handler.action, handler);
  }

  supports(action: string): boolean {
    return this.handlers.has(action);
  }

  async undo(auditId: number): Promise<UndoResult> {
    const entry = this.audit.get(auditId);
    if (!entry) throw new ActionError(404, 'audit_not_found', 'Unknown audit entry');
    if (entry.dryRun) {
      throw new ActionError(409, 'not_undoable', 'A simulated (dry-run) write has nothing to undo');
    }
    if (!entry.undoToken) {
      throw new ActionError(409, 'not_undoable', 'This write is not reversible');
    }
    if (entry.undoneAt !== null) {
      throw new ActionError(409, 'already_undone', 'This write was already undone');
    }
    const handler = this.handlers.get(entry.action);
    if (!handler) {
      throw new ActionError(409, 'undo_unsupported', `Undo of "${entry.action}" is not available`);
    }

    const out = await handler.undo(entry);
    // A simulated undo changed nothing: the original stays undoable. A real one is stamped atomically.
    if (!out.dryRun) {
      const at = this.now();
      for (const id of out.undoneIds ?? [entry.id]) this.audit.markUndone(id, at);
    }
    return {
      dryRun: out.dryRun,
      undoneId: entry.id,
      auditId: out.auditId,
      action: entry.action,
      ...(out.batch ? { batch: out.batch } : {}),
    };
  }
}
