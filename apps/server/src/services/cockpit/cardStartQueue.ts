import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { CardStartAttachment, QueuedCardStart } from '@relay/shared';
import type { AppDb } from '../../db';
import { branchPushes, cardStartQueue, mrs } from '../../db/schema';
import type { EventBus } from '../../sync/eventBus';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import { listCards } from '../notionStore';
import type { CockpitWorkflowService } from './workflow';
import type { ExistingBranch } from './workflowOps';
import type { WorkspaceService } from './workspaces';

/**
 * Stacked card starts. A bulk start can base a card on another card of the same start, whose branch has no work yet.
 * Such a card waits here; its agent starts once the parent's branch is pushed (push webhook or branch poll, an MR
 * counts too), from that branch, so it picks up the parent's work. The user can also start it by hand, from the
 * parent's local branch. Kept in the DB: a restart does not lose the plan.
 */

const CHECK_MS = 60_000;

interface Payload {
  agent: 'claude' | 'cursor';
  existing?: ExistingBranch;
  extraPrompt?: string;
  figmaUrl?: string;
  attachments?: CardStartAttachment[];
}

export interface EnqueueInput extends Payload {
  cardId: string;
  parentCardId: string;
  workspaceId: string;
}

type Row = typeof cardStartQueue.$inferSelect;

export class CardStartQueueService {
  private timer: NodeJS.Timeout | undefined;
  private unwatch: (() => void) | undefined;
  private checking = false;

  constructor(
    private readonly d: {
      store: AppDb;
      workflow: CockpitWorkflowService;
      workspaces: WorkspaceService;
      log: Logger;
      bus?: EventBus;
    },
  ) {}

  /** Watches for parent pushes; also catches up on what was queued before a restart. */
  start(): void {
    // A start that was running when the server stopped did not finish: offer it again.
    this.d.store.db
      .update(cardStartQueue)
      .set({ status: 'queued', updatedAt: Date.now() })
      .where(eq(cardStartQueue.status, 'starting'))
      .run();
    this.unwatch = this.d.bus?.on('cockpit.changed', (e) => {
      if (e.what === 'ready') void this.check();
    });
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref();
    void this.check();
  }

  stop(): void {
    clearInterval(this.timer);
    this.unwatch?.();
  }

  private changed(): void {
    try {
      this.d.bus?.emit({ type: 'cockpit.changed', what: 'queue' });
    } catch {
      /* cosmetic */
    }
  }

  enqueue(input: EnqueueInput): QueuedCardStart {
    if (input.cardId === input.parentCardId) {
      throw new ActionError(422, 'invalid_parent', 'A card cannot wait for itself.');
    }
    const cards = listCards(this.d.store);
    const card = cards.find((c) => c.id === input.cardId);
    const parent = cards.find((c) => c.id === input.parentCardId);
    if (!card || !parent) throw new ActionError(404, 'card_not_found', 'Card not found.');
    if (!card.branchName?.trim() || !parent.branchName?.trim()) {
      throw new ActionError(409, 'no_branch_formula', 'Both cards need a Branch formula.');
    }
    this.d.workspaces.get(input.workspaceId);
    const open = this.d.store.db
      .select()
      .from(cardStartQueue)
      .where(
        and(
          eq(cardStartQueue.cardId, input.cardId),
          inArray(cardStartQueue.status, ['queued', 'starting']),
        ),
      )
      .all();
    if (open.length > 0) {
      throw new ActionError(409, 'already_queued', 'This card is already waiting to start.');
    }
    const { cardId, parentCardId, workspaceId, ...payload } = input;
    const now = Date.now();
    const row: Row = {
      id: randomUUID(),
      cardId,
      parentCardId,
      workspaceId,
      payload,
      status: 'queued',
      error: null,
      errorCode: null,
      sessionId: null,
      startedWorkspaceId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.d.store.db.insert(cardStartQueue).values(row).run();
    this.changed();
    void this.check();
    return this.view(row);
  }

  /** Waiting and failed starts, and the ones started in the last day (so the user sees where they went). */
  list(): QueuedCardStart[] {
    const since = Date.now() - 24 * 60 * 60_000;
    return this.d.store.db
      .select()
      .from(cardStartQueue)
      .all()
      .filter((r) => r.status !== 'started' || r.updatedAt >= since)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => this.view(r));
  }

  cancel(id: string): void {
    const row = this.row(id);
    if (row.status === 'starting') {
      throw new ActionError(409, 'starting', 'This card is starting right now.');
    }
    this.d.store.db.delete(cardStartQueue).where(eq(cardStartQueue.id, id)).run();
    this.changed();
  }

  /** Starts it now, from the parent's branch as it is (pushed or only local). `existing` answers a branch clash. */
  async startNow(id: string, existing?: ExistingBranch): Promise<QueuedCardStart> {
    const row = this.row(id);
    if (row.status === 'starting' || row.status === 'started') {
      throw new ActionError(409, 'already_started', 'This card has already started.');
    }
    if (existing) {
      row.payload = { ...(row.payload as Payload), existing };
    }
    await this.run(row, this.parentPushed(row));
    return this.view(this.row(id));
  }

  private row(id: string): Row {
    const row = this.d.store.db
      .select()
      .from(cardStartQueue)
      .where(eq(cardStartQueue.id, id))
      .get();
    if (!row) throw new ActionError(404, 'not_found', 'This queued start is gone.');
    return row;
  }

  private view(r: Row): QueuedCardStart {
    const cards = listCards(this.d.store);
    const card = cards.find((c) => c.id === r.cardId);
    const parent = cards.find((c) => c.id === r.parentCardId);
    return {
      id: r.id,
      cardId: r.cardId,
      cardTitle: card?.title ?? 'Card',
      parentCardId: r.parentCardId,
      parentTitle: parent?.title ?? 'Card',
      parentBranch: parent?.branchName?.trim() || null,
      workspaceId: r.workspaceId,
      agent: (r.payload as Payload).agent,
      status: r.status as QueuedCardStart['status'],
      error: r.error,
      errorCode: r.errorCode,
      sessionId: r.sessionId,
      startedWorkspaceId: r.startedWorkspaceId,
      createdAt: r.createdAt,
    };
  }

  private parentPushed(row: Row): boolean {
    const branch = listCards(this.d.store)
      .find((c) => c.id === row.parentCardId)
      ?.branchName?.trim();
    try {
      const repoId = this.d.workspaces.get(row.workspaceId).repoId;
      return !!branch && !!repoId && this.pushed(repoId, branch);
    } catch {
      return false;
    }
  }

  /** The parent's branch reached origin: pushed, or it has an MR. */
  private pushed(repoId: string, branch: string): boolean {
    const push = this.d.store.db
      .select({ sha: branchPushes.sha })
      .from(branchPushes)
      .where(and(eq(branchPushes.repoId, repoId), eq(branchPushes.branch, branch)))
      .get();
    if (push) return true;
    const mr = this.d.store.db
      .select({ iid: mrs.iid })
      .from(mrs)
      .where(and(eq(mrs.repoId, repoId), eq(mrs.sourceBranch, branch)))
      .get();
    return !!mr;
  }

  /** Starts every queued card whose parent's branch is pushed. One at a time, like the bulk start. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const queued = this.d.store.db
        .select()
        .from(cardStartQueue)
        .where(eq(cardStartQueue.status, 'queued'))
        .all()
        .sort((a, b) => a.createdAt - b.createdAt);
      if (queued.length === 0) return;
      for (const row of queued) {
        if (!this.parentPushed(row)) continue;
        await this.run(row, true);
      }
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'card start queue check failed');
    } finally {
      this.checking = false;
    }
  }

  private async run(row: Row, fromOrigin: boolean): Promise<void> {
    const cards = listCards(this.d.store);
    const parent = cards.find((c) => c.id === row.parentCardId);
    const parentBranch = parent?.branchName?.trim();
    const set = (patch: Partial<Row>) => {
      this.d.store.db
        .update(cardStartQueue)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(cardStartQueue.id, row.id))
        .run();
      this.changed();
    };
    if (!parent || !parentBranch) {
      set({
        status: 'failed',
        error: 'The parent card or its Branch formula is gone.',
        errorCode: 'parent_missing',
      });
      return;
    }
    set({ status: 'starting', error: null, errorCode: null });
    const p = row.payload as Payload;
    try {
      const res = await this.d.workflow.cardStart({
        cardId: row.cardId,
        workspaceId: row.workspaceId,
        base: fromOrigin ? `origin/${parentBranch}` : parentBranch,
        agent: p.agent,
        worktree: 'auto',
        stackedOn: { title: parent.title, branch: parentBranch },
        ...(p.existing ? { existing: p.existing } : {}),
        ...(p.extraPrompt ? { extraPrompt: p.extraPrompt } : {}),
        ...(p.figmaUrl ? { figmaUrl: p.figmaUrl } : {}),
        ...(p.attachments?.length ? { attachments: p.attachments } : {}),
      });
      // The files are with the agent now; they need not stay in the DB.
      set({
        status: 'started',
        sessionId: res.sessionId,
        startedWorkspaceId: res.workspaceId,
        payload: { agent: p.agent },
      });
      this.d.log.info({ cardId: row.cardId, parent: parentBranch }, 'stacked card started');
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      set({
        status: 'failed',
        error: (e as Error).message,
        errorCode: typeof code === 'string' ? code : null,
      });
      this.d.log.warn(
        { cardId: row.cardId, err: (e as Error).message },
        'stacked card start failed',
      );
    }
  }
}
