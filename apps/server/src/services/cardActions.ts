import { createHash, randomBytes } from 'node:crypto';
import {
  normalizeName,
  statusGroupTest,
  type AuditEntry,
  type BulkFailure,
  type BulkReadyKind,
  type BulkReadyPreview,
  type BulkReadyPreviewItem,
  type BulkReadyPreviewRequest,
  type BulkReadyRequest,
  type BulkReadyResult,
  type BulkReadyResultItem,
  type CardStatusRequest,
  type CardStatusResult,
  type CardWritePreview,
  type MrCreateNotion,
  type Fix,
  type SyncFixRequest,
  type SyncFixPreviewRequest,
  type SyncFixTarget,
  type Verdict,
} from '@relay/shared';
import { newUndoToken, type AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import type { EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import { Confirmations } from './confirmations';
import { guardedWrite } from './dryRun';
import { buildHealthReport } from './healthReport';
import { canonicalName, resolveStatus, type LivePageStatus } from './notionCard';
import type { StatusProp } from './notionSchema';
import { NotionApiError, type NotionService } from './notionService';
import { applyWrittenStatus, getCard } from './notionStore';
import { normalizeNotionId } from './notionUrl';
import type { UndoHandler, UndoOutcome } from './undoEngine';

/** The batch's one undoable row (targetType `batch`), holding the single undo token. */
const BULK_ACTION = 'card.bulkReady';
/** One changed card of a batch: previous status, no token of its own. */
const BULK_ITEM_ACTION = 'card.bulkReady.item';
/** Errors every later card would hit too: stop instead of hammering Notion. Others are per-card. */
const STOP_BATCH_CODES = new Set([
  'notion_not_configured',
  'notion_auth',
  'notion_forbidden',
  'notion_rate_limited',
  'notion_network',
  'notion_timeout',
]);
const NOT_ATTEMPTED: BulkFailure = {
  code: 'not_attempted',
  message: 'Not attempted: the batch stopped at an earlier error.',
};

/**
 * Card status changes and one-click Fixes.
 *
 * The rules, all enforced HERE (the UI is cosmetic):
 *  1. Nothing is written without confirmation: every write needs the single-use token that `preview*` issued
 *     for exactly that change (`Confirmations`), i.e. the user saw `before -> after` first. Two callers have no
 *     extra dialog: `autoReady` (a release's Start click) and `markCompleted` (the Create MR click). Both are audited.
 *  2. The card is re-read LIVE from Notion at preview and again at write; if it changed in between the token no
 *     longer matches (409 `confirmation_stale`) and nothing is sent.
 *  3. Every write goes through `guardedWrite`: dry-run aware, audited with before/after, undoable (`card.status`).
 *  4. A Fix is looked up by the server in its own Sync Health verdicts; the client's idea of the fix payload is
 *     never used. Only `set_card_status` is executable here; the other Fix types belong to later parts.
 *  5. Undo restores the stored BEFORE value, but only while Notion still holds what our write left there
 *     (409 `undo_conflict` otherwise - an external edit is never overwritten silently).
 */

export class CardActionError extends ActionError {
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'CardActionError';
  }
}

/** The subset of `NotionService` this class needs (keeps the dependency explicit). */
export type CardNotionPort = Pick<
  NotionService,
  'readPageStatus' | 'resolveStatusOption' | 'statusProperty' | 'setPageStatus'
>;

export interface CardActionsDeps {
  config: ConfigStore;
  audit: AuditWriter;
  /** Local cache DB. */
  store: AppDb;
  notion: CardNotionPort;
  log: Logger;
  bus?: EventBus;
  confirmations?: Confirmations;
  now?: () => number;
}

function mapNotionError(e: unknown): never {
  if (e instanceof NotionApiError) {
    if (e.kind === 'not_configured') {
      throw new CardActionError(409, 'notion_not_configured', 'Notion is not configured');
    }
    const status =
      e.kind === 'not_found'
        ? 404
        : e.kind === 'rate_limited'
          ? 429
          : e.kind === 'bad_request'
            ? 422
            : 502;
    // The message carries kind/status/path/code only (never the token, headers or bodies).
    throw new CardActionError(status, `notion_${e.kind}`, e.message);
  }
  throw e;
}

const norm = (s: string | null | undefined): string => (s ? normalizeName(s) : '');

interface Before {
  name: string | null;
  optionId: string | null;
  lastEditedAt: number | null;
  archived: boolean;
  source: 'live' | 'cache';
}

interface Target {
  /** Configured spelling. */
  name: string;
  /** Notion option; null only in dry-run when the schema could not be read. */
  optionId: string | null;
  prop: StatusProp | null;
}

export class CardActions {
  private readonly confirmations: Confirmations;
  private readonly now: () => number;
  /** Cards with a write in flight: a double click or a second tab must not send two writes. */
  private readonly writing = new Set<string>();

  constructor(private readonly d: CardActionsDeps) {
    this.now = d.now ?? Date.now;
    this.confirmations = d.confirmations ?? new Confirmations(this.now);
  }

  // ───────────── shared helpers ─────────────

  private cachedCard(rawId: string) {
    const id = normalizeNotionId(rawId);
    const card = id ? getCard(this.d.store, id) : undefined;
    if (!id || !card) {
      throw new CardActionError(404, 'card_not_found', 'This card is not in the local cache');
    }
    if (card.archived) {
      throw new CardActionError(409, 'card_archived', 'This card is archived or in the trash');
    }
    return { id, card };
  }

  /**
   * The status Create MR writes. Prefer the option spelled "Completed". Otherwise the workspace's Complete
   * spelling ("Complete" when that is the only one configured).
   */
  private completedStatusName(): string {
    const { statuses } = this.d.config.getGlobal().notion;
    const named = statuses.find((s) => normalizeName(s) === 'completed');
    if (named) return named;
    return this.canonicalStatus('Completed');
  }

  /** `requested` -> the configured spelling; a status the board does not know is refused. */
  private canonicalStatus(requested: string): string {
    const { statuses, statusGroups } = this.d.config.getGlobal().notion;
    const name = resolveStatus(requested, statuses, statusGroups);
    if (name === null) {
      throw new CardActionError(
        422,
        'unknown_status',
        `"${requested.slice(0, 60)}" is not one of the configured statuses`,
      );
    }
    return name;
  }

  /**
   * The card as Notion has it NOW. Live writes require a live read. Dry-run may fall back to the cache when
   * Notion cannot be reached (nothing is written anyway); the caller is told via `source`.
   */
  private async readBefore(cardId: string): Promise<Before> {
    try {
      const live = await this.d.notion.readPageStatus(cardId);
      return { ...pick(live), source: 'live' };
    } catch (e) {
      if (this.d.config.isDryRun() && e instanceof NotionApiError) {
        const card = getCard(this.d.store, cardId);
        if (card) {
          return {
            name: card.status,
            optionId: null,
            lastEditedAt: card.lastEditedAt,
            archived: false,
            source: 'cache',
          };
        }
      }
      return mapNotionError(e);
    }
  }

  private async resolveTarget(name: string): Promise<Target> {
    try {
      const r = await this.d.notion.resolveStatusOption(name);
      if (r.ok) return { name, optionId: r.option.id, prop: r.prop };
      if (r.reason === 'option_missing') {
        throw new CardActionError(
          409,
          'status_option_missing',
          `Notion has no status option named "${name}". Add it in Notion or fix the configured statuses in Settings.`,
        );
      }
      if (r.reason === 'option_ambiguous') {
        throw new CardActionError(
          409,
          'status_option_ambiguous',
          `Notion has several status options that read as "${name}". Rename one of them.`,
        );
      }
      throw new CardActionError(
        409,
        'notion_no_status_property',
        'The Notion data source has no usable status property (see Settings → Notion).',
      );
    } catch (e) {
      if (e instanceof CardActionError) {
        // Dry-run can still show/simulate when only the schema is unavailable; real writes cannot.
        throw e;
      }
      if (this.d.config.isDryRun() && e instanceof NotionApiError) {
        return { name, optionId: null, prop: null };
      }
      return mapNotionError(e);
    }
  }

  private changed(cardId: string): void {
    try {
      this.d.bus?.emit({ type: 'cards.changed', cardIds: [cardId] });
      this.d.bus?.emit({ type: 'health.changed' });
    } catch {
      /* a bus problem must never fail an audited write */
    }
  }

  private binding(
    cardId: string,
    before: Before,
    to: string,
    ruleId: string | null,
  ): Record<string, string | null> {
    return {
      action: 'card.status',
      cardId,
      from: norm(before.name),
      to: norm(to),
      ruleId,
    };
  }

  // ───────────── status change ─────────────

  /** Step 1 (writes nothing): reads the live card and issues the confirmation token for this exact change. */
  async previewStatus(
    rawId: string,
    requested: string,
    ruleId: string | null = null,
  ): Promise<CardWritePreview> {
    const { id, card } = this.cachedCard(rawId);
    const to = this.canonicalStatus(requested);
    const before = await this.readBefore(id);
    if (before.archived) {
      throw new CardActionError(409, 'card_archived', 'This card is archived or in the trash');
    }
    await this.resolveTarget(to); // refuses an option Notion does not have, before the dialog even opens
    if (norm(before.name) === norm(to)) {
      throw new CardActionError(409, 'no_change', `The card is already "${to}" in Notion`);
    }
    const warnings: string[] = [];
    if (before.source === 'live' && norm(before.name) !== norm(card.status)) {
      warnings.push(
        `The dashboard's copy said "${card.status ?? 'no status'}" but Notion has "${before.name ?? 'no status'}" right now (the sync is catching up).`,
      );
    }
    if (before.source === 'cache') {
      warnings.push('Notion could not be reached: "before" comes from the dashboard cache.');
    }
    const { token, expiresAt } = this.confirmations.issue(this.binding(id, before, to, ruleId));
    return {
      confirmToken: token,
      expiresAt,
      action: 'card.status',
      cardId: id,
      cardTitle: card.title,
      field: this.d.config.getGlobal().notion.props.status,
      before: before.name,
      after: to,
      source: before.source,
      dryRun: this.d.config.isDryRun(),
      ruleId,
      warnings,
    };
  }

  /** Step 2: `PATCH /api/cards/:id/status`. Needs the token from `previewStatus` for this exact change. */
  async setStatus(rawId: string, req: CardStatusRequest): Promise<CardStatusResult> {
    return this.write(rawId, req.status, req.confirmToken, null);
  }

  /**
   * Create MR already confirmed this write. Sets the card to Completed when the live status is not already
   * that spelling. A failure is returned, never thrown: the MR already exists.
   */
  async markCompleted(rawId: string): Promise<MrCreateNotion> {
    try {
      const { id } = this.cachedCard(rawId);
      if (this.d.config.isDryRun()) {
        return {
          outcome: 'failed',
          status: null,
          error: 'Dry-run is on, so the Notion card was left unchanged.',
        };
      }
      const to = this.completedStatusName();
      const before = await this.readBefore(id);
      if (before.archived) {
        return {
          outcome: 'failed',
          status: before.name,
          error: 'This card is archived or in the trash',
        };
      }
      if (norm(before.name) === norm(to) || norm(before.name) === 'completed') {
        return { outcome: 'already_completed', status: before.name, error: null };
      }
      if (this.writing.has(id)) {
        return {
          outcome: 'failed',
          status: before.name,
          error: 'A change to this card is in progress',
        };
      }
      this.writing.add(id);
      try {
        const target = await this.resolveTarget(to);
        const out = await this.guarded(id, before, target, { action: 'card.status' });
        return { outcome: 'updated', status: out.after, error: null };
      } finally {
        this.writing.delete(id);
      }
    } catch (e) {
      return {
        outcome: 'failed',
        status: null,
        error: e instanceof Error ? e.message : 'Could not update the Notion card',
      };
    }
  }

  private async write(
    rawId: string,
    requested: string,
    confirmToken: string,
    ruleId: string | null,
  ): Promise<CardStatusResult> {
    const { id } = this.cachedCard(rawId);
    const to = this.canonicalStatus(requested);
    if (this.writing.has(id)) {
      throw new CardActionError(409, 'write_in_progress', 'A change to this card is in progress');
    }
    this.writing.add(id);
    try {
      // Live, at write time: the user's confirmation is only valid for the state they were shown.
      const before = await this.readBefore(id);
      if (before.archived) {
        throw new CardActionError(409, 'card_archived', 'This card is archived or in the trash');
      }
      this.consumeOrThrow(
        confirmToken,
        this.binding(id, before, to, ruleId),
        `The card changed in Notion since you opened the dialog (it is now "${before.name ?? 'no status'}"). Nothing was written; review and confirm again.`,
      );
      if (norm(before.name) === norm(to)) {
        throw new CardActionError(409, 'no_change', `The card is already "${to}" in Notion`);
      }
      const target = await this.resolveTarget(to);

      const out = await this.guarded(id, before, target, { action: 'card.status', ruleId });
      return {
        dryRun: out.dryRun,
        auditId: out.auditId,
        cardId: id,
        before: before.name,
        after: out.after,
        undoable: out.undoable,
        ruleId,
      };
    } finally {
      this.writing.delete(id);
    }
  }

  private consumeOrThrow(
    token: string,
    binding: Record<string, string | null>,
    staleMessage: string,
  ): void {
    const c = this.confirmations.consume(token, binding);
    if (c.ok) return;
    if (c.reason === 'mismatch') {
      throw new CardActionError(409, 'confirmation_stale', staleMessage);
    }
    throw new CardActionError(
      409,
      'confirmation_required',
      c.reason === 'expired'
        ? 'The confirmation expired. Open the confirm dialog again.'
        : 'This change was not confirmed. Open the confirm dialog and confirm it there.',
    );
  }

  /** The one write (also used by undo): `guardedWrite` + cache + events. Callers have already confirmed. */
  private async guarded(
    cardId: string,
    before: Before,
    target: Target,
    o: {
      action: 'card.status' | 'card.bulkReady.item' | 'undo';
      ruleId?: string | null;
      undoOf?: number;
      batchId?: string;
      /** A dry-run release stays simulated if the setting has gone off since. */
      simulate?: boolean;
    },
  ): Promise<{ dryRun: boolean; auditId: number; after: string; undoable: boolean }> {
    try {
      const out = await guardedWrite(
        {
          dryRun: o.simulate ? { isDryRun: () => true } : this.d.config,
          audit: this.d.audit,
          log: this.d.log,
        },
        {
          actor: 'user',
          action: o.action,
          targetType: 'card',
          targetId: cardId,
          // Reached only from the user's confirmed click (a valid single-use token), their Undo click, or the click on
          // Start of the release whose NOTION step this is.
          confirmed: true,
          before: {
            status: before.name,
            optionId: before.optionId,
            lastEditedAt: before.lastEditedAt,
          },
          after: {
            status: target.name || null,
            optionId: target.optionId,
            lastEditedAt: null,
            ...(o.ruleId ? { ruleId: o.ruleId } : {}),
          },
          reversible: o.action === 'card.status',
          ...(o.undoOf !== undefined ? { undoOf: o.undoOf } : {}),
          ...(o.batchId !== undefined ? { batchId: o.batchId } : {}),
          afterResult: (live) => ({
            status: live?.name
              ? canonicalName(live.name, this.knownStatuses())
              : target.name || null,
            optionId: live?.optionId ?? target.optionId,
            lastEditedAt: live?.lastEditedAt ?? null,
            ...(o.ruleId ? { ruleId: o.ruleId } : {}),
          }),
          run: () => this.setOnNotion(cardId, target),
        },
      );
      const live = out.result ?? null;
      if (!out.dryRun) {
        applyWrittenStatus(
          this.d.store,
          cardId,
          live?.name ? canonicalName(live.name, this.knownStatuses()) : target.name || null,
          live?.lastEditedAt ?? null,
        );
        this.changed(cardId);
      }
      return {
        dryRun: out.dryRun,
        auditId: out.audit.id,
        after: target.name,
        undoable: out.audit.undoToken !== null,
      };
    } catch (e) {
      return mapNotionError(e);
    }
  }

  private knownStatuses(): readonly string[] {
    return this.d.config.getGlobal().notion.statuses;
  }

  private async setOnNotion(cardId: string, t: Target): Promise<LivePageStatus | null> {
    if (!t.prop)
      throw new NotionApiError('not_configured', undefined, '(schema)', 'no_status_prop');
    return this.d.notion.setPageStatus(cardId, t.prop, t.optionId);
  }

  // ───────────── bulk Ready to Test ─────────────

  /** Dedupes and normalizes; ids that are not Notion ids cannot get past the schema. */
  private bulkIds(raw: readonly string[]): string[] {
    return [...new Set(raw.map((r) => normalizeNotionId(r) ?? r))];
  }

  /** Reads every card live and sorts it into the three branches. One unreadable card does not stop the others. */
  private async classifyBulk(ids: readonly string[], ready: string): Promise<BulkPlanItem[]> {
    const { isComplete } = statusGroupTest(this.d.config.getGlobal().notion.statusGroups);
    const out: BulkPlanItem[] = [];
    for (const id of ids) {
      const title = getCard(this.d.store, id)?.title ?? id;
      try {
        this.cachedCard(id);
        const before = await this.readBefore(id);
        if (before.archived) {
          throw new CardActionError(409, 'card_archived', 'This card is archived or in the trash');
        }
        const s = norm(before.name);
        const kind: BulkReadyKind =
          s === norm(ready) ? 'ready' : isComplete(before.name) ? 'complete' : 'warned';
        out.push({ id, title, kind, before, reason: null });
      } catch (e) {
        // Nothing can work without Notion credentials: say so once instead of N times.
        if (e instanceof CardActionError && e.code === 'notion_not_configured') throw e;
        out.push({ id, title, kind: 'unavailable', before: null, reason: this.failure(e) });
      }
    }
    return out;
  }

  private failure(e: unknown): BulkFailure {
    if (e instanceof ActionError) return { code: e.code, message: e.message };
    if (e instanceof NotionApiError) return { code: `notion_${e.kind}`, message: e.message };
    this.d.log.error({ err: e }, 'bulk ready: unexpected error');
    return { code: 'internal', message: 'Unexpected error; see the server log.' };
  }

  /** The token covers the whole picture the user was shown; any card that moved makes it stale. */
  private bulkBinding(ready: string, plan: readonly BulkPlanItem[]): Record<string, string> {
    const picture = plan
      .map((p) => `${p.id}|${p.kind}|${norm(p.before?.name)}`)
      .sort()
      .join('\n');
    return {
      action: BULK_ACTION,
      to: norm(ready),
      picture: createHash('sha256').update(picture).digest('hex'),
    };
  }

  /** Step 1 (writes nothing): live status of every card + the one token for this exact picture. */
  async previewBulkReady(req: BulkReadyPreviewRequest): Promise<BulkReadyPreview> {
    const ready = this.d.config.getGlobal().notion.readyStatus;
    const to = this.canonicalStatus(ready);
    await this.resolveTarget(to);
    const plan = await this.classifyBulk(this.bulkIds(req.cardIds), to);
    const { token, expiresAt } = this.confirmations.issue(this.bulkBinding(to, plan));
    return {
      confirmToken: token,
      expiresAt,
      action: BULK_ACTION,
      after: to,
      field: this.d.config.getGlobal().notion.props.status,
      dryRun: this.d.config.isDryRun(),
      items: plan.map((p): BulkReadyPreviewItem => ({
        cardId: p.id,
        title: p.title,
        before: p.before?.name ?? null,
        kind: p.kind,
        source: p.before?.source ?? 'live',
        reason: p.reason,
      })),
    };
  }

  /**
   * Step 2: `POST /api/cards/bulk-ready`. Re-reads every card; if the picture differs from the preview nothing at all
   * is written. A card that then fails does not roll back the others: each change is audited as it happens (with
   * its previous status), and the outcome per card comes back with a 200.
   */
  async bulkReady(req: BulkReadyRequest): Promise<BulkReadyResult> {
    const ids = this.bulkIds(req.cardIds);
    const include = new Set(this.bulkIds(req.includeWarned));
    if ([...include].some((id) => !ids.includes(id))) {
      throw new CardActionError(
        422,
        'invalid_include',
        'includeWarned must be a subset of cardIds',
      );
    }
    const to = this.canonicalStatus(this.d.config.getGlobal().notion.readyStatus);
    return this.whileWriting(ids, async () => {
      const plan = await this.classifyBulk(ids, to);
      this.consumeOrThrow(
        req.confirmToken,
        this.bulkBinding(to, plan),
        'At least one card changed in Notion since you opened the dialog. Nothing was written; review and confirm again.',
      );
      return this.writeBatch(plan, to, include, {});
    });
  }

  /**
   * A release's NOTION step: the Complete cards go to Ready to Test with no dialog, as the click on Start confirmed it.
   * Every other card is left alone and reported, and stays open to the bulk dialog. Read live, audited and undoable like
   * any other batch. No route reaches this.
   */
  async autoReady(
    rawIds: readonly string[],
    options: { releaseJobId: string; simulate: boolean },
  ): Promise<BulkReadyResult> {
    const ids = this.bulkIds(rawIds);
    const to = this.canonicalStatus(this.d.config.getGlobal().notion.readyStatus);
    return this.whileWriting(ids, async () =>
      this.writeBatch(await this.classifyBulk(ids, to), to, new Set(), options),
    );
  }

  private async whileWriting<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> {
    if (ids.some((id) => this.writing.has(id))) {
      throw new CardActionError(
        409,
        'write_in_progress',
        'A change to one of these cards is in progress',
      );
    }
    for (const id of ids) this.writing.add(id);
    try {
      return await work();
    } finally {
      for (const id of ids) this.writing.delete(id);
    }
  }

  /** Writes a classified batch: its Complete cards, and those of the warned ones in `include`. */
  private async writeBatch(
    plan: readonly BulkPlanItem[],
    to: string,
    include: ReadonlySet<string>,
    options: { releaseJobId?: string; simulate?: boolean },
  ): Promise<BulkReadyResult> {
    const target = await this.resolveTarget(to);
    const simulate = options.simulate === true;
    const dryRun = simulate || this.d.config.isDryRun();
    const batchId = randomBytes(12).toString('hex');
    let headerId: number | null = null;
    let stopped = false;
    const items: BulkReadyResultItem[] = [];
    const toWrite = plan.filter(
      (p) => p.kind === 'complete' || (p.kind === 'warned' && include.has(p.id)),
    );

    for (const p of plan) {
      const base = { cardId: p.id, title: p.title, before: p.before?.name ?? null };
      const skip =
        p.kind === 'ready'
          ? 'skipped_ready'
          : p.kind === 'unavailable'
            ? 'unavailable'
            : p.kind === 'warned' && !include.has(p.id)
              ? 'skipped_warned'
              : null;
      if (skip) {
        items.push({ ...base, outcome: skip, auditId: null, failure: p.reason });
        continue;
      }
      if (stopped || !p.before) {
        items.push({ ...base, outcome: 'not_attempted', auditId: null, failure: NOT_ATTEMPTED });
        continue;
      }
      try {
        const out = await this.guarded(p.id, p.before, target, {
          action: BULK_ITEM_ACTION,
          batchId,
          simulate,
        });
        // Written right after the first change (not at the end): a crash mid-batch still leaves one-click undo.
        headerId ??= this.d.audit.write({
          actor: 'user',
          action: BULK_ACTION,
          targetType: 'batch',
          targetId: batchId,
          before: {
            cards: toWrite.map((c) => ({
              cardId: c.id,
              title: c.title,
              status: c.before?.name ?? null,
            })),
            ...(options.releaseJobId ? { releaseJobId: options.releaseJobId } : {}),
          },
          after: { status: to, requested: toWrite.length },
          dryRun,
          undoToken: newUndoToken(),
          batchId,
        }).id;
        items.push({ ...base, outcome: 'updated', auditId: out.auditId, failure: null });
      } catch (e) {
        const failure = this.failure(e);
        stopped = STOP_BATCH_CODES.has(failure.code);
        items.push({ ...base, outcome: 'failed', auditId: null, failure });
      }
    }
    return {
      dryRun,
      batchId: headerId === null ? null : batchId,
      undoAuditId: headerId !== null && !dryRun ? headerId : null,
      after: to,
      partial: items.some((i) => i.outcome === 'failed' || i.outcome === 'not_attempted'),
      items,
    };
  }

  // ───────────── one-click Fix ─────────────

  /**
   * The verdict + fix for `{ruleId, target, fixIndex}` from the server's OWN Sync Health report (cache). Refuses
   * when the suggestion no longer applies and for Fix types this part cannot execute.
   */
  private findFix(req: SyncFixPreviewRequest): { verdict: Verdict; fix: Fix } {
    const report = buildHealthReport(
      this.d.store,
      this.d.config.listReposFull(),
      this.d.config.getGlobal(),
      this.now(),
    );
    const idOf = (s: string | null) => (s ? (normalizeNotionId(s) ?? s) : null);
    const want: SyncFixTarget = req.target;
    const verdict = report.verdicts.find(
      (v) =>
        v.ruleId === req.ruleId &&
        idOf(v.cardId) === idOf(want.cardId) &&
        v.repoId === want.repoId &&
        v.mrIid === want.mrIid,
    );
    if (!verdict) {
      throw new CardActionError(
        409,
        'fix_stale',
        'This suggestion no longer applies: the board changed since the page was loaded. Nothing was written.',
      );
    }
    const fixes = [...(verdict.fix ? [verdict.fix] : []), ...verdict.alternatives];
    const fix = fixes[req.fixIndex];
    if (!fix) throw new CardActionError(404, 'fix_not_found', 'This verdict has no such fix');
    if (fix.type !== 'set_card_status') {
      throw new CardActionError(
        409,
        'fix_unsupported',
        `"${fix.type}" cannot be applied from here yet. Only card status fixes are available in this version.`,
      );
    }
    return { verdict, fix };
  }

  /** Step 1 of a Fix (writes nothing): same preview as a status change, bound to the rule that suggested it. */
  async previewFix(req: SyncFixPreviewRequest): Promise<CardWritePreview> {
    const { fix } = this.findFix(req);
    if (fix.type !== 'set_card_status') throw new Error('unreachable');
    return this.previewStatus(fix.cardId, fix.to, req.ruleId);
  }

  /** Step 2 of a Fix: `POST /api/sync/fix`. The fix payload comes from the server's own verdict. */
  async applyFix(req: SyncFixRequest): Promise<CardStatusResult> {
    const { fix } = this.findFix(req);
    if (fix.type !== 'set_card_status') throw new Error('unreachable');
    return this.write(fix.cardId, fix.to, req.confirmToken, req.ruleId);
  }

  // ───────────── undo ─────────────

  /** The Notion target that puts a stored BEFORE status back. Refuses what can no longer be restored. */
  private async restoreTarget(before: StoredState): Promise<Target> {
    if (before.status === null) {
      // The card had no status: only a `select` can be emptied again.
      const st = await this.d.notion.statusProperty({ force: true }).catch(mapNotionError);
      if (!st.ok || st.prop.type !== 'select') {
        throw new CardActionError(
          409,
          'undo_unsupported',
          'The card had no status before; a Notion "status" property cannot be emptied again.',
        );
      }
      return { name: '', optionId: null, prop: st.prop };
    }
    if (before.optionId) {
      const st = await this.d.notion.statusProperty({ force: true }).catch(mapNotionError);
      if (!st.ok) {
        throw new CardActionError(
          409,
          'notion_no_status_property',
          'The Notion data source has no usable status property (see Settings → Notion).',
        );
      }
      if (!st.prop.options.some((o) => o.id === before.optionId)) {
        throw new CardActionError(
          409,
          'status_option_missing',
          `The previous status "${before.status}" no longer exists in Notion, so it cannot be restored.`,
        );
      }
      return { name: before.status, optionId: before.optionId, prop: st.prop };
    }
    // Written in dry-run-less history without an option id: resolve by name instead.
    return this.resolveTarget(before.status);
  }

  /**
   * Undo handler for `card.status` (registered with the `UndoEngine`). Restores the stored BEFORE status, but only if
   * Notion still holds what our write left (`after`); otherwise 409 `undo_conflict` and nothing is written.
   */
  readonly statusUndoHandler: UndoHandler = {
    action: 'card.status',
    undo: async (entry: AuditEntry) => {
      const before = parseState(entry.before);
      const after = parseState(entry.after);
      const id = normalizeNotionId(entry.targetId);
      if (!before || !after || !id || entry.targetType !== 'card') {
        throw new CardActionError(
          409,
          'undo_unsupported',
          'The audit entry has no restorable state',
        );
      }
      if (this.writing.has(id)) {
        throw new CardActionError(409, 'write_in_progress', 'A change to this card is in progress');
      }
      this.writing.add(id);
      try {
        const live = await this.readBefore(id);
        if (live.archived) {
          throw new CardActionError(409, 'card_archived', 'This card is archived or in the trash');
        }
        if (!holdsValue(live, after)) {
          const title = getCard(this.d.store, id)?.title ?? 'This card';
          throw new CardActionError(
            409,
            'undo_conflict',
            `Cannot undo: "${title}" was changed in Notion after this write (it is now "${live.name ?? 'no status'}", this write left it at "${after.status ?? 'no status'}"). Undoing would overwrite that edit. Nothing was written; change it in Notion if you still want it.`,
            { expected: after.status, actual: live.name },
          );
        }
        if (norm(before.status) === norm(live.name) && before.optionId === live.optionId) {
          throw new CardActionError(409, 'no_change', 'The card already has its previous status');
        }

        const target = await this.restoreTarget(before);
        const out = await this.guarded(id, live, target, { action: 'undo', undoOf: entry.id });
        return { dryRun: out.dryRun, auditId: out.auditId };
      } finally {
        this.writing.delete(id);
      }
    },
  };

  /**
   * "Undo bulk": one click, one `undo` audit row, however many cards. Every card goes back to its stored previous
   * status unless it was edited since: such a card is left alone and reported, the others are still restored, and
   * the batch stays undoable for what is left. If no card can be restored: 409, nothing written, no audit row.
   */
  readonly bulkUndoHandler: UndoHandler = {
    action: BULK_ACTION,
    undo: async (header: AuditEntry): Promise<UndoOutcome> => {
      const batchId = header.batchId;
      if (!batchId) {
        throw new CardActionError(409, 'undo_unsupported', 'This entry has no batch');
      }
      const rows = this.d.audit
        .listBatch(batchId)
        .filter((r) => r.action === BULK_ITEM_ACTION && !r.dryRun && r.undoneAt === null);
      if (rows.length === 0) {
        throw new CardActionError(409, 'already_undone', 'Every card of this batch is restored');
      }

      const restorable: RestorePlan[] = [];
      const blocked: BlockedCard[] = [];
      const locked: string[] = [];
      const targets = new Map<string, Promise<Target>>();
      try {
        for (const row of rows) {
          const id = normalizeNotionId(row.targetId) ?? row.targetId;
          const title = getCard(this.d.store, id)?.title ?? id;
          try {
            if (this.writing.has(id)) {
              throw new CardActionError(
                409,
                'write_in_progress',
                'A change to this card is in progress',
              );
            }
            this.writing.add(id);
            locked.push(id);
            const before = parseState(row.before);
            const after = parseState(row.after);
            if (!before || !after) {
              throw new CardActionError(
                409,
                'undo_unsupported',
                'The audit entry has no restorable state',
              );
            }
            const live = await this.readBefore(id);
            if (live.archived) {
              throw new CardActionError(
                409,
                'card_archived',
                'This card is archived or in the trash',
              );
            }
            if (!holdsValue(live, after)) {
              throw new CardActionError(
                409,
                'undo_conflict',
                `Changed in Notion after this write (it is now "${live.name ?? 'no status'}", this write left it at "${after.status ?? 'no status'}").`,
              );
            }
            const key = `${before.status}|${before.optionId}`;
            let target = targets.get(key);
            if (!target) {
              target = this.restoreTarget(before);
              targets.set(key, target);
            }
            restorable.push({ row, id, title, live, target: await target });
          } catch (e) {
            blocked.push({ cardId: id, title, ...this.failure(e) });
          }
        }

        if (restorable.length === 0) {
          const first = blocked.find((b) => b.code === 'undo_conflict') ?? blocked[0];
          throw new CardActionError(
            409,
            first?.code ?? 'undo_unsupported',
            `Nothing was restored or written. ${blocked.map((b) => `"${b.title}": ${b.message}`).join(' ')}`,
            { blocked },
          );
        }

        const restored: RestorePlan[] = [];
        const out = await guardedWrite(
          { dryRun: this.d.config, audit: this.d.audit, log: this.d.log },
          {
            actor: 'user',
            action: 'undo',
            targetType: 'batch',
            targetId: batchId,
            confirmed: true, // the user's Undo click
            batchId,
            undoOf: header.id,
            before: {
              cards: restorable.map((r) => ({ cardId: r.id, status: r.live.name })),
            },
            after: {
              cards: restorable.map((r) => ({ cardId: r.id, status: r.target.name || null })),
              blocked,
            },
            afterResult: () => ({
              cards: restored.map((r) => ({ cardId: r.id, status: r.target.name || null })),
              blocked,
            }),
            run: async () => {
              let stopped = false;
              let firstError: unknown;
              for (const r of restorable) {
                if (stopped) {
                  blocked.push({ cardId: r.id, title: r.title, ...NOT_ATTEMPTED });
                  continue;
                }
                try {
                  const live = await this.setOnNotion(r.id, r.target);
                  restored.push(r);
                  applyWrittenStatus(
                    this.d.store,
                    r.id,
                    live?.name
                      ? canonicalName(live.name, this.knownStatuses())
                      : r.target.name || null,
                    live?.lastEditedAt ?? null,
                  );
                  this.changed(r.id);
                } catch (e) {
                  firstError ??= e;
                  const failure = this.failure(e);
                  stopped = STOP_BATCH_CODES.has(failure.code);
                  blocked.push({ cardId: r.id, title: r.title, ...failure });
                }
              }
              // Nothing changed: no audit row, the error goes to the caller like any failed write.
              if (restored.length === 0) throw firstError;
            },
          },
        ).catch(mapNotionError);

        const shown = out.dryRun ? restorable : restored;
        return {
          dryRun: out.dryRun,
          auditId: out.audit.id,
          undoneIds: [
            ...restored.map((r) => r.row.id),
            ...(restored.length === rows.length ? [header.id] : []),
          ],
          batch: {
            restored: shown.map((r) => ({
              cardId: r.id,
              title: r.title,
              status: r.target.name || null,
            })),
            blocked,
          },
        };
      } finally {
        for (const id of locked) this.writing.delete(id);
      }
    },
  };
}

function pick(l: LivePageStatus): Omit<Before, 'source'> {
  return { name: l.name, optionId: l.optionId, lastEditedAt: l.lastEditedAt, archived: l.archived };
}

interface StoredState {
  status: string | null;
  optionId: string | null;
}

interface BulkPlanItem {
  id: string;
  title: string;
  kind: BulkReadyKind;
  /** null only when `unavailable`. */
  before: Before | null;
  reason: BulkFailure | null;
}

interface RestorePlan {
  row: AuditEntry;
  id: string;
  title: string;
  live: Before;
  target: Target;
}

type BlockedCard = { cardId: string; title: string } & BulkFailure;

/** Notion still holds what our write left (option id when both are known; name otherwise). */
function holdsValue(live: Before, after: StoredState): boolean {
  return live.optionId !== null && after.optionId !== null
    ? live.optionId === after.optionId
    : norm(live.name) === norm(after.status);
}

/** `before` / `after` of a `card.status` audit row. */
function parseState(v: unknown): StoredState | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const status = r.status;
  const optionId = r.optionId;
  if (status !== null && typeof status !== 'string') return null;
  if (optionId !== null && typeof optionId !== 'string') return null;
  return { status, optionId };
}
