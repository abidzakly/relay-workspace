import type { AuditActor, AuditEntry } from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import { newUndoToken } from '../audit/auditLog';
import type { Logger } from '../util/logger';

/** Reads the global dry-run flag live (a toggle applies to the very next write, no restart). */
export interface DryRunSource {
  isDryRun(): boolean;
}

export class UnconfirmedWriteError extends Error {
  constructor(action: string) {
    super(`write "${action}" was not confirmed by the user`);
    this.name = 'UnconfirmedWriteError';
  }
}

export interface GuardedWriteDeps {
  dryRun: DryRunSource;
  audit: AuditWriter;
  log: Logger;
}

export interface GuardedWriteOp<T> {
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId: string;
  /**
   * Non-negotiable: external writes are never automatic. The caller must pass `true`, which it
   * may only do when handling an explicit user confirmation (a click), never from a poller/webhook.
   * A release's later steps count the click on Start as that confirmation, and its form says so.
   */
  confirmed: true;
  before?: unknown;
  after?: unknown;
  /** Reversible writes pass `true` (a token is minted) or a fixed token; irreversible ones omit it. */
  reversible?: boolean;
  batchId?: string | null;
  /** For an undo: id of the audit entry this write reverts. */
  undoOf?: number | null;
  /**
   * Live only: builds the audited `after` from the call's result (e.g. an id GitLab assigns), so the
   * row records what really happened. Dry-run rows keep the requested `after`. Must not throw.
   */
  afterResult?: (result: T) => unknown;
  /** The real call-out. NOT invoked in dry-run. */
  run: () => Promise<T>;
  /** Value returned to the caller instead of `run()`'s result when simulating. */
  simulated?: T;
}

export type GuardedWriteResult<T> =
  | { dryRun: true; result: T | undefined; audit: AuditEntry }
  | { dryRun: false; result: T; audit: AuditEntry };

/**
 * Single choke point for external writes (GitLab, Notion, Drive, git push…).
 *  - dry-run ON : `run` is NOT called; an audit row with `dryRun=true` (no undo token) and a log line are written.
 *  - dry-run OFF: `run` is called; on success an audit row (with undo token when reversible) is written.
 *    If `run` throws nothing is audited as done and the error propagates.
 */
export async function guardedWrite<T>(
  deps: GuardedWriteDeps,
  op: GuardedWriteOp<T>,
): Promise<GuardedWriteResult<T>> {
  if ((op.confirmed as unknown) !== true) throw new UnconfirmedWriteError(op.action);
  const base = {
    actor: op.actor,
    action: op.action,
    targetType: op.targetType,
    targetId: op.targetId,
    before: op.before,
    after: op.after,
    batchId: op.batchId ?? null,
    undoOf: op.undoOf ?? null,
  };
  if (deps.dryRun.isDryRun()) {
    const audit = deps.audit.write({ ...base, dryRun: true });
    deps.log.info(
      { action: op.action, targetType: op.targetType, targetId: op.targetId, auditId: audit.id },
      'dry-run: write simulated, nothing sent',
    );
    return { dryRun: true, result: op.simulated, audit };
  }
  const result = await op.run();
  let after = op.after;
  if (op.afterResult) {
    try {
      after = op.afterResult(result);
    } catch {
      /* keep the requested `after`: the write happened and must be audited regardless */
    }
  }
  const audit = deps.audit.write({
    ...base,
    after,
    dryRun: false,
    undoToken: op.reversible ? newUndoToken() : null,
  });
  return { dryRun: false, result, audit };
}
