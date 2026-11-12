import { normalizeName, type GlobalConfig } from '@relay/shared';
import type { AppDb } from '../db';
import type { Logger } from '../util/logger';
import { HttpNetworkError, type HttpClient, type HttpResponse } from './httpClient';
import {
  buildMeMatcher,
  mineQueryFilter,
  normalizePage,
  readLiveStatus,
  resolveSchema,
  type LivePageStatus,
  type NormalizedPage,
  type ResolvedSchema,
} from './notionCard';
import { NOTION_API_BASE } from './notion';
import type { NotionOption, StatusProp } from './notionSchema';
import {
  archiveMissing,
  identityKey,
  readSyncState,
  upsertCards,
  writeSyncState,
  type NotionSyncState,
} from './notionStore';

/**
 * NotionService — READ + CACHE plus ONE write: the status of a page (`setPageStatus`).
 * Reads are GETs of the schema / a page or POSTs to `/data_sources/:id/query`. The write is a single
 * `PATCH /pages/:id` that is never retried and is only ever called through `guardedWrite` (user-confirmed,
 * dry-run aware, audited): see `CardActions`.
 *  - schema fetch + status/select auto-detect (`resolveSchema`)
 *  - query with `next_cursor` pagination
 *  - full sync (startup + safety net) and incremental sync (`last_edited_time on_or_after lastPoll − 5 s`)
 *  - card normalization + upsert into `cards`, incl. `assigned_at_first_seen`
 * Response shapes follow Notion's documented API: UNVERIFIED against a live sample.
 */

/** The incremental filter starts this long before the previous poll. */
export const INCREMENTAL_OVERLAP_MS = 5_000;
export const PAGE_SIZE = 100;
/** 500 pages x 100 = 50k cards; beyond that a sync stops and reports `truncated`. */
export const DEFAULT_MAX_PAGES = 500;
/** How long a fetched schema is reused by incremental polls. */
export const SCHEMA_TTL_MS = 10 * 60_000;

export type NotionErrorKind =
  | 'not_configured'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'bad_request'
  | 'bad_response'
  | 'network'
  | 'timeout';

/** Never carries the token, headers, query, request body or response body. `code` = Notion's error code (a short enum). */
export class NotionApiError extends Error {
  constructor(
    readonly kind: NotionErrorKind,
    readonly status: number | undefined,
    readonly path: string,
    readonly code?: string,
  ) {
    super(
      `Notion ${kind}${status !== undefined ? ` (HTTP ${status})` : ''}${code ? ` [${code}]` : ''} on ${path}`,
    );
    this.name = 'NotionApiError';
  }
}

export type SyncMode = 'full' | 'incremental';

export interface NotionSyncReport {
  mode: SyncMode;
  startedAt: number;
  finishedAt: number;
  /** Incremental only: the `on_or_after` instant (epoch ms) sent to Notion. */
  windowFrom: number | null;
  /** An incremental request that had no cursor yet ran as a full sync. */
  promotedToFull: boolean;
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  stale: number;
  skipped: { id?: string; reason: string }[];
  /** Full only: cached cards that Notion no longer returned, now flagged archived. */
  archivedMissing: number;
  /** true = stopped at `maxPages`; cursor NOT advanced, nothing archived. */
  truncated: boolean;
  firstSeen: { recorded: number; approx: number };
  identity: {
    configured: boolean;
    cardsWithAssignee: number;
    cardsAssignedToMe: number;
    /** `no_match`: full sync saw assigned cards but none is me — check username / assigneeAliases. */
    status: 'ok' | 'unconfigured' | 'no_match';
  };
  /** Configured properties that are missing / of the wrong type (those fields stay null/[]). */
  problems: { role: string; kind: string; message: string }[];
  /** Card statuses/types seen that match no configured status / SLA type. */
  unmapped: { statuses: string[]; types: string[] };
  /** Cards with more than one relation in the parent property (first one used). */
  multiParent: number;
}

/** A raw Notion block plus the block it sits under (null = the page itself). */
export interface NotionBlock {
  id: string;
  type: string;
  parentId: string | null;
  has_children?: boolean;
  [key: string]: unknown;
}

export interface NotionServiceOptions {
  /** Read on every sync, so Settings edits apply without a restart. */
  getGlobal: () => GlobalConfig;
  http: HttpClient;
  store: AppDb;
  log: Logger;
  now?: () => number;
  maxPages?: number;
  pageSize?: number;
  schemaTtlMs?: number;
}

interface Creds {
  token: string;
  dataSourceId: string;
  version: string;
  cfg: GlobalConfig;
}

export class NotionService {
  private readonly now: () => number;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly schemaTtlMs: number;
  private schemaCache?: { key: string; at: number; schema: ResolvedSchema };
  /** Serializes syncs: two never overlap. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Syncs that are queued but have not started yet, per mode. */
  private readonly queued = new Map<SyncMode, Promise<NotionSyncReport>>();

  constructor(private readonly o: NotionServiceOptions) {
    this.now = o.now ?? Date.now;
    this.maxPages = o.maxPages ?? DEFAULT_MAX_PAGES;
    this.pageSize = Math.min(Math.max(o.pageSize ?? PAGE_SIZE, 1), 100);
    this.schemaTtlMs = o.schemaTtlMs ?? SCHEMA_TTL_MS;
  }

  static fromConfig(
    config: { getGlobal(): GlobalConfig },
    deps: Omit<NotionServiceOptions, 'getGlobal'>,
  ): NotionService {
    return new NotionService({ ...deps, getGlobal: () => config.getGlobal() });
  }

  // ───────────── low level ─────────────

  private creds(): Creds {
    const cfg = this.o.getGlobal();
    const { token, dataSourceId, version } = cfg.notion;
    if (!token) throw new NotionApiError('not_configured', undefined, '(config)', 'no_token');
    if (!dataSourceId) {
      throw new NotionApiError('not_configured', undefined, '(config)', 'no_data_source');
    }
    return { token, dataSourceId, version, cfg };
  }

  private async call(
    c: { token: string; version: string },
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    opts: { once?: boolean } = {},
  ): Promise<unknown> {
    let res: HttpResponse;
    try {
      res = await this.o.http.send({
        method,
        url: `${NOTION_API_BASE}${path}`,
        headers: { authorization: `Bearer ${c.token}`, 'notion-version': c.version },
        ...(body !== undefined ? { body } : {}),
        // A replayed write could land twice (or after the user moved on): writes are sent exactly once.
        ...(method === 'PATCH' || opts.once ? { maxRetries: 0 } : {}),
      });
    } catch (e) {
      const timeout = e instanceof HttpNetworkError && e.kind === 'timeout';
      throw new NotionApiError(timeout ? 'timeout' : 'network', undefined, path);
    }
    if (res.status === 200) {
      if (res.json === undefined || typeof res.json !== 'object' || res.json === null) {
        throw new NotionApiError('bad_response', res.status, path);
      }
      return res.json;
    }
    const rawCode = (res.json as { code?: unknown } | undefined)?.code;
    const code =
      typeof rawCode === 'string' && /^[a-z_]{1,40}$/.test(rawCode) ? rawCode : undefined;
    const kind: NotionErrorKind =
      res.status === 401
        ? 'auth'
        : res.status === 403
          ? 'forbidden'
          : res.status === 404
            ? 'not_found'
            : res.status === 429
              ? 'rate_limited'
              : res.status === 400
                ? 'bad_request'
                : res.status >= 500 || res.status === 409
                  ? 'server'
                  : 'bad_response';
    throw new NotionApiError(kind, res.status, path, code);
  }

  /**
   * A raw Notion call with the configured token (no data source needed). `once` = never retried (writes that would
   * duplicate, e.g. creating a page). Errors are `NotionApiError`.
   */
  async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    opts: { once?: boolean } = {},
  ): Promise<unknown> {
    const cfg = this.o.getGlobal();
    const { token, version } = cfg.notion;
    if (!token) throw new NotionApiError('not_configured', undefined, '(config)', 'no_token');
    return this.call({ token, version }, method, path, body, opts);
  }

  // ───────────── page body (Test Bench) ─────────────

  /**
   * Every block of a page in document order, children right after their parent (toggles, columns, callouts,
   * nested lists), each tagged with the block it sits under. Follows `next_cursor`. Calls are sequential and spaced
   * to stay under Notion's ~3 req/s. Stops at `maxBlocks` / `maxDepth` and reports `truncated`.
   * Child pages and databases are not entered (they are other documents).
   */
  async readBlocksDeep(
    pageId: string,
    opts: { maxBlocks?: number; maxDepth?: number; minGapMs?: number } = {},
  ): Promise<{ blocks: NotionBlock[]; truncated: boolean }> {
    const maxBlocks = opts.maxBlocks ?? 1500;
    const maxDepth = opts.maxDepth ?? 5;
    const gap = opts.minGapMs ?? 340;
    const out: NotionBlock[] = [];
    let truncated = false;
    let last = 0;
    const pace = async () => {
      const wait = last + gap - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = this.now();
    };
    const walk = async (parent: string, depth: number): Promise<void> => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        if (out.length >= maxBlocks) {
          truncated = true;
          return;
        }
        await pace();
        const q = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
        const json = (await this.request(
          'GET',
          `/blocks/${encodeURIComponent(parent)}/children${q}`,
        )) as { results?: unknown; next_cursor?: unknown; has_more?: unknown };
        const results = Array.isArray(json.results) ? json.results : [];
        for (const raw of results) {
          if (out.length >= maxBlocks) {
            truncated = true;
            return;
          }
          if (typeof raw !== 'object' || raw === null) continue;
          const b = raw as Record<string, unknown>;
          if (typeof b.id !== 'string' || typeof b.type !== 'string') continue;
          out.push({ ...b, id: b.id, type: b.type, parentId: parent === pageId ? null : parent });
          const nested =
            b.has_children === true && b.type !== 'child_page' && b.type !== 'child_database';
          if (nested) {
            if (depth + 1 > maxDepth) truncated = true;
            else await walk(b.id, depth + 1);
          }
        }
        const next = typeof json.next_cursor === 'string' ? json.next_cursor : undefined;
        if (json.has_more !== true || !next || seen.has(next)) return;
        seen.add(next);
        cursor = next;
      }
    };
    await walk(pageId, 0);
    return { blocks: out, truncated };
  }

  // ───────────── schema ─────────────

  /** `GET /data_sources/:id` -> property roles + status option ids. Cached for `schemaTtlMs` (config changes bust it). */
  async fetchSchema(opts: { force?: boolean } = {}): Promise<ResolvedSchema> {
    const c = this.creds();
    return this.schemaFor(c, opts.force ?? false);
  }

  private async schemaFor(c: Creds, force: boolean): Promise<ResolvedSchema> {
    const n = c.cfg.notion;
    const key = JSON.stringify([c.dataSourceId, c.version, n.props, n.statuses]);
    const hit = this.schemaCache;
    if (!force && hit && hit.key === key && this.now() - hit.at < this.schemaTtlMs)
      return hit.schema;

    const path = `/data_sources/${encodeURIComponent(c.dataSourceId)}`;
    const json = await this.call(c, 'GET', path);
    const schema = resolveSchema(json, n);
    if (!schema) throw new NotionApiError('bad_response', 200, path, 'no_properties');
    this.schemaCache = { key, at: this.now(), schema };
    return schema;
  }

  // ───────────── single page: live status read + status write ─────────────

  /** The status property of the data source (fresh schema when `force`), or why there is none. */
  async statusProperty(
    opts: { force?: boolean } = {},
  ): Promise<{ ok: true; prop: StatusProp; schema: ResolvedSchema } | { ok: false }> {
    const schema = await this.schemaFor(this.creds(), opts.force ?? false);
    const prop = schema.roles.status;
    return prop ? { ok: true, prop, schema } : { ok: false };
  }

  /**
   * Maps a status name to the property's option (case/whitespace-insensitive, like `nts`). Uses a FRESH schema
   * so an option renamed in Notion is noticed. `ambiguous` = several options match once normalized.
   */
  async resolveStatusOption(
    name: string,
  ): Promise<
    | { ok: true; prop: StatusProp; option: NotionOption }
    | { ok: false; reason: 'no_status_property' | 'option_missing' | 'option_ambiguous' }
  > {
    const st = await this.statusProperty({ force: true });
    if (!st.ok) return { ok: false, reason: 'no_status_property' };
    const key = normalizeName(name);
    const hits = st.prop.options.filter((o) => normalizeName(o.name) === key);
    if (hits.length === 0) return { ok: false, reason: 'option_missing' };
    if (hits.length > 1) return { ok: false, reason: 'option_ambiguous' };
    return { ok: true, prop: st.prop, option: hits[0]! };
  }

  /** `GET /pages/:id` -> the live status (never from the cache). */
  async readPageStatus(pageId: string): Promise<LivePageStatus> {
    const c = this.creds();
    const schema = await this.schemaFor(c, false);
    const prop = schema.roles.status;
    const path = `/pages/${encodeURIComponent(pageId)}`;
    if (!prop) throw new NotionApiError('not_configured', undefined, path, 'no_status_prop');
    const live = readLiveStatus(await this.call(c, 'GET', path), prop);
    if (!live) throw new NotionApiError('bad_response', 200, path, 'no_status_value');
    return live;
  }

  /**
   * THE Notion write: `PATCH /pages/:id { properties: { [statusProp]: { [type]: { id } } } }`, using
   * the resolved option id. `optionId = null` clears a `select` (used by undo when the card had no status).
   * Returns the status read back from Notion's answer, or `null` when the answer cannot be mapped (the write
   * still happened). Call only through `guardedWrite`.
   */
  async setPageStatus(
    pageId: string,
    prop: StatusProp,
    optionId: string | null,
  ): Promise<LivePageStatus | null> {
    const c = this.creds();
    const path = `/pages/${encodeURIComponent(pageId)}`;
    if (optionId === null && prop.type !== 'select') {
      throw new NotionApiError('bad_request', undefined, path, 'cannot_clear_status');
    }
    const key = prop.id || prop.name;
    const json = await this.call(c, 'PATCH', path, {
      properties: { [key]: { [prop.type]: optionId === null ? null : { id: optionId } } },
    });
    return readLiveStatus(json, prop) ?? null;
  }

  // ───────────── query (pagination) ─────────────

  /**
   * `POST /data_sources/:id/query`, following `next_cursor` until `has_more` is false. Yields one array per
   * response page. Stops (and reports it) at `maxPages` or when Notion repeats a cursor.
   */
  private async *queryPages(
    c: Creds,
    base: Record<string, unknown>,
    state: { pages: number; truncated: boolean },
  ): AsyncGenerator<unknown[]> {
    const path = `/data_sources/${encodeURIComponent(c.dataSourceId)}/query`;
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      if (state.pages >= this.maxPages) {
        state.truncated = true;
        return;
      }
      const json = (await this.call(c, 'POST', path, {
        ...base,
        page_size: this.pageSize,
        ...(cursor ? { start_cursor: cursor } : {}),
      })) as { results?: unknown; next_cursor?: unknown; has_more?: unknown };
      if (!Array.isArray(json.results))
        throw new NotionApiError('bad_response', 200, path, 'no_results');
      state.pages++;
      yield json.results;

      const next =
        typeof json.next_cursor === 'string' && json.next_cursor.length > 0
          ? json.next_cursor
          : undefined;
      if (!next || json.has_more === false) return;
      if (seenCursors.has(next)) {
        // A cursor that repeats would loop forever: treat as an incomplete listing.
        state.truncated = true;
        this.o.log.warn(
          { pages: state.pages },
          'notion query returned a repeated cursor; stopping',
        );
        return;
      }
      seenCursors.add(next);
      cursor = next;
    }
  }

  // ───────────── sync ─────────────

  /** Everything in the data source; reconciles trashed/moved cards; advances the cursor. */
  fullSync(): Promise<NotionSyncReport> {
    return this.enqueue('full');
  }

  /** Cards edited since the last poll (− 5 s). With no cursor yet it runs as a full sync. */
  incrementalSync(): Promise<NotionSyncReport> {
    return this.enqueue('incremental');
  }

  private enqueue(mode: SyncMode): Promise<NotionSyncReport> {
    // A request that arrives while an identical one is still WAITING shares it (webhook bursts). One that
    // arrives while a sync is already running gets its own run afterwards, so it sees the newest edits.
    const waiting = this.queued.get(mode);
    if (waiting) return waiting;
    const start = () => {
      this.queued.delete(mode);
      return this.run(mode);
    };
    const promise = this.tail.then(start, start);
    this.queued.set(mode, promise);
    this.tail = promise.catch(() => undefined);
    return promise;
  }

  private async run(requested: SyncMode): Promise<NotionSyncReport> {
    const c = this.creds();
    const { cfg } = c;
    const startedAt = this.now();
    const prior = readSyncState(this.o.store, c.dataSourceId);
    const identity = identityKey({
      assigneeProp: cfg.notion.props.assignee,
      myUsername: cfg.gitlab.myUsername,
      aliases: cfg.notion.assigneeAliases,
    });
    // New "me" settings: every cached card must be re-checked, so the run is full and counts as a baseline.
    const identityChanged = prior !== undefined && prior.identityKey !== identity;
    const mode: SyncMode =
      requested === 'incremental' && prior && !identityChanged ? 'incremental' : 'full';
    const promotedToFull = requested === 'incremental' && mode === 'full';

    const schema = await this.schemaFor(c, mode === 'full');

    const windowFrom = mode === 'incremental' ? prior!.lastPollAt - INCREMENTAL_OVERLAP_MS : null;
    const edited =
      windowFrom !== null
        ? {
            timestamp: 'last_edited_time',
            last_edited_time: { on_or_after: new Date(windowFrom).toISOString() },
          }
        : undefined;
    // Only my cards (like `nts list`). Without a Notion user id the sync refuses to run: reading the whole data
    // source is far too heavy. A full run archives cached cards that are no longer mine.
    const mine = mineQueryFilter(schema.roles.assignee, cfg.notion.assigneeAliases);
    if (!mine) {
      throw new NotionApiError('not_configured', undefined, '(config)', 'no_user_id');
    }
    const filter = edited ? { and: [edited, mine] } : mine;
    const base: Record<string, unknown> = {
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      ...(filter ? { filter } : {}),
    };

    const me = buildMeMatcher(cfg.gitlab.myUsername, cfg.notion.assigneeAliases);
    const knownStatuses = cfg.notion.statuses;
    const knownTypes = Object.keys(cfg.sla.rules);
    const knownStatusKeys = new Set(knownStatuses.map((s) => s.trim().toLowerCase()));

    const report: NotionSyncReport = {
      mode,
      startedAt,
      finishedAt: startedAt,
      windowFrom,
      promotedToFull,
      pages: 0,
      fetched: 0,
      created: 0,
      updated: 0,
      stale: 0,
      skipped: [],
      archivedMissing: 0,
      truncated: false,
      firstSeen: { recorded: 0, approx: 0 },
      identity: {
        configured: me.configured,
        cardsWithAssignee: 0,
        cardsAssignedToMe: 0,
        status: me.configured ? 'ok' : 'unconfigured',
      },
      problems: schema.problems.map(({ role, kind, message }) => ({ role, kind, message })),
      unmapped: { statuses: [], types: [] },
      multiParent: 0,
    };

    const seen = new Set<string>();
    const unmappedStatuses = new Set<string>();
    const unmappedTypes = new Set<string>();
    const typeKeys = new Set(knownTypes.map((t) => t.trim().toLowerCase()));
    const paging = { pages: 0, truncated: false };

    for await (const results of this.queryPages(c, base, paging)) {
      const items: NormalizedPage[] = [];
      for (const raw of results) {
        report.fetched++;
        const n = normalizePage(raw, { schema, knownStatuses, knownTypes, me, now: startedAt });
        if (!n.ok) {
          if (report.skipped.length < 50) {
            report.skipped.push({ ...(n.id ? { id: n.id } : {}), reason: n.reason });
          }
          continue;
        }
        seen.add(n.fields.id);
        items.push(n);
        if (n.assigneeCount > 0) report.identity.cardsWithAssignee++;
        if (n.assignedToMe) report.identity.cardsAssignedToMe++;
        if (n.multiParent) report.multiParent++;
        const st = n.fields.status;
        if (st && !knownStatusKeys.has(st.trim().toLowerCase())) unmappedStatuses.add(st);
        const ty = n.fields.type;
        if (ty && !typeKeys.has(ty.trim().toLowerCase())) unmappedTypes.add(ty);
      }
      const out = upsertCards(this.o.store, items, {
        now: startedAt,
        previousPollAt: prior?.lastPollAt ?? null,
        identityChanged,
      });
      report.created += out.created;
      report.updated += out.updated;
      report.stale += out.stale;
      report.firstSeen.recorded += out.firstSeen.recorded;
      report.firstSeen.approx += out.firstSeen.approx;
    }

    report.pages = paging.pages;
    report.truncated = paging.truncated;
    report.unmapped = {
      statuses: [...unmappedStatuses].sort().slice(0, 20),
      types: [...unmappedTypes].sort().slice(0, 20),
    };
    if (
      me.configured &&
      mode === 'full' &&
      report.identity.cardsWithAssignee > 0 &&
      report.identity.cardsAssignedToMe === 0
    ) {
      report.identity.status = 'no_match';
    }

    // A truncated listing is incomplete: do not advance the cursor and do not archive anything.
    if (!report.truncated) {
      if (mode === 'full') report.archivedMissing = archiveMissing(this.o.store, seen, startedAt);
      const state: NotionSyncState = {
        dataSourceId: c.dataSourceId,
        lastPollAt: startedAt,
        lastFullAt: mode === 'full' ? startedAt : (prior?.lastFullAt ?? null),
        identityKey: identity,
      };
      writeSyncState(this.o.store, state, this.now());
    }
    report.finishedAt = this.now();

    const level = report.truncated || report.identity.status !== 'ok' ? 'warn' : 'info';
    this.o.log[level](
      {
        mode,
        pages: report.pages,
        fetched: report.fetched,
        created: report.created,
        updated: report.updated,
        stale: report.stale,
        skipped: report.skipped.length,
        archivedMissing: report.archivedMissing,
        truncated: report.truncated,
        firstSeen: report.firstSeen,
        identity: report.identity.status,
        problems: report.problems.length,
        ms: report.finishedAt - startedAt,
      },
      'notion sync',
    );
    return report;
  }
}
