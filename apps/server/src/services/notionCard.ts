import {
  normalizeName,
  statusGroupTest,
  type Card,
  type GlobalConfig,
  type StatusGroups,
} from '@relay/shared';
import {
  detectStatusProp,
  detectTitleProp,
  findProp,
  parseProperties,
  resolveOptions,
  type NotionProp,
  type OptionResolution,
  type StatusProp,
} from './notionSchema';
import { normalizeNotionId } from './notionUrl';

/**
 * Pure mapping Notion -> `Card`. No I/O.
 * Shapes follow Notion's DOCUMENTED page / property-value objects (API 2025-09-03): UNVERIFIED against a
 * live sample. Anything missing or of an unexpected type degrades to null / [] and never throws.
 */

type Role = 'title' | 'status' | 'type' | 'assignee' | 'estimation' | 'branchName' | 'parent';

/** Property types we can read for each role (lenient on purpose; `testNotion` is the strict checker). */
const ROLE_TYPES: Record<Exclude<Role, 'title' | 'status'>, readonly string[]> = {
  type: ['select', 'status', 'multi_select'],
  assignee: ['people'],
  estimation: ['date'],
  branchName: ['rich_text', 'title', 'formula'],
  parent: ['relation'],
};

export interface SchemaProblem {
  role: Role;
  kind: 'missing' | 'wrong_type' | 'ambiguous';
  message: string;
}

export interface RoleProps {
  title?: NotionProp;
  status?: StatusProp;
  type?: NotionProp;
  assignee?: NotionProp;
  estimation?: NotionProp;
  branchName?: NotionProp;
  parent?: NotionProp;
  /** Optional: only `sla.assignedAtSource: "property"` uses it, so its absence is not a problem. */
  assignedAt?: NotionProp;
  /** Optional roles: a missing one is not a problem (the feature using it just shows nothing). */
  productDomain?: NotionProp;
  point?: NotionProp;
  sprint?: NotionProp;
  subTasks?: NotionProp;
}

/** Optional roles and the property types each can read. */
export const OPTIONAL_ROLE_TYPES = {
  productDomain: ['select', 'multi_select', 'status', 'rich_text', 'formula', 'rollup'],
  point: ['number', 'select', 'formula', 'rich_text'],
  sprint: ['select', 'multi_select', 'status', 'rich_text', 'formula', 'rollup'],
  subTasks: ['relation'],
} as const satisfies Record<string, readonly string[]>;
export type OptionalRole = keyof typeof OPTIONAL_ROLE_TYPES;

export interface ResolvedSchema {
  props: NotionProp[];
  roles: RoleProps;
  /** Configured status names -> Notion options (undefined when there is no usable status property). */
  statusOptions?: OptionResolution;
  problems: SchemaProblem[];
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Resolves every configured property role against a `GET /data_sources/:id` payload. */
export function resolveSchema(
  json: unknown,
  notion: Pick<GlobalConfig['notion'], 'props' | 'statuses'>,
): ResolvedSchema | undefined {
  const props = parseProperties(json);
  if (!props) return undefined;
  const roles: RoleProps = {};
  const problems: SchemaProblem[] = [];

  const title = detectTitleProp(props, notion.props.title);
  if (title.ok) roles.title = title.prop;
  else {
    problems.push({
      role: 'title',
      kind: title.reason === 'wrong_type' ? 'wrong_type' : 'missing',
      message: `title property "${clip(notion.props.title)}" not usable (${title.reason})`,
    });
  }

  const status = detectStatusProp(props, notion.props.status);
  if (status.ok) roles.status = status.prop;
  else {
    problems.push({
      role: 'status',
      kind: status.reason === 'not_found' ? 'missing' : status.reason,
      message: `status property "${clip(notion.props.status)}" not usable (${status.reason})`,
    });
  }

  for (const role of Object.keys(ROLE_TYPES) as (keyof typeof ROLE_TYPES)[]) {
    const configured = notion.props[role];
    const hit = findProp(props, configured);
    if (!hit) {
      problems.push({
        role,
        kind: 'missing',
        message: `property "${clip(configured)}" not found`,
      });
    } else if ('ambiguous' in hit) {
      problems.push({
        role,
        kind: 'ambiguous',
        message: `property "${clip(configured)}" matches several properties once case/spacing is ignored`,
      });
    } else if (!ROLE_TYPES[role].includes(hit.prop.type)) {
      problems.push({
        role,
        kind: 'wrong_type',
        message: `property "${clip(hit.prop.name)}" is ${hit.prop.type}, expected ${ROLE_TYPES[role].join('/')}`,
      });
    } else {
      roles[role] = hit.prop;
    }
  }

  const assignedAt = findProp(props, notion.props.assignedAt);
  if (assignedAt && !('ambiguous' in assignedAt) && assignedAt.prop.type === 'date') {
    roles.assignedAt = assignedAt.prop;
  }

  for (const role of Object.keys(OPTIONAL_ROLE_TYPES) as OptionalRole[]) {
    const hit = findProp(props, notion.props[role]);
    if (!hit || 'ambiguous' in hit) continue;
    if ((OPTIONAL_ROLE_TYPES[role] as readonly string[]).includes(hit.prop.type)) {
      roles[role] = hit.prop;
    } else if (hit.prop.type === 'relation' && role !== 'subTasks') {
      // A relation holds page ids, not names: read the rollup that shows the related page's title instead.
      const rollup = props.find((p) => p.type === 'rollup' && p.rollupOf === hit.prop.name);
      if (rollup) roles[role] = rollup;
    }
  }

  return {
    props,
    roles,
    ...(roles.status
      ? { statusOptions: resolveOptions(roles.status.options, notion.statuses) }
      : {}),
    problems,
  };
}

// ───────────────────────────── identity ("is this person me?") ─────────────────────────────

/** Lowercased letters/digits only, so "Jane Doe", "jane.doe" and "janedoe" are the same key. */
export function looseKey(s: string): string {
  return normalizeName(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface MeMatcher {
  /** false = no username / aliases configured (first-seen can never be recorded). */
  configured: boolean;
  matches(person: NotionPerson): boolean;
}

export interface NotionPerson {
  id?: string;
  name?: string;
  email?: string;
}

const USER_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** The aliases that are Notion user ids, dashed and lower-cased. Names and e-mails cannot be filtered on by Notion. */
export function notionUserIds(aliases: readonly string[]): string[] {
  const out = new Set<string>();
  for (const a of aliases) {
    const t = a.trim();
    if (!USER_ID_RE.test(t)) continue;
    const hex = t.replace(/-/g, '').toLowerCase();
    out.add(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  }
  return [...out];
}

/**
 * Query filter that returns only my cards, like `nts list` (`<people prop> contains <user id>`). Undefined when it
 * cannot be built: no user id among the aliases, or an Assignee property that is not `people` / `created_by`.
 */
export function mineQueryFilter(
  assignee: NotionProp | undefined,
  aliases: readonly string[],
): Record<string, unknown> | undefined {
  if (!assignee || (assignee.type !== 'people' && assignee.type !== 'created_by')) return undefined;
  const ids = notionUserIds(aliases);
  if (ids.length === 0) return undefined;
  const one = (id: string) => ({ property: assignee.name, [assignee.type]: { contains: id } });
  return ids.length === 1 ? one(ids[0]!) : { or: ids.map(one) };
}

/** `myUsername` + `notion.assigneeAliases`, compared against a person's name, e-mail (and its local part) and id. */
export function buildMeMatcher(
  myUsername: string | undefined,
  aliases: readonly string[],
): MeMatcher {
  const keys = new Set<string>();
  for (const raw of [myUsername ?? '', ...aliases]) {
    const k = looseKey(raw);
    if (k) keys.add(k);
  }
  return {
    configured: keys.size > 0,
    matches(person) {
      if (keys.size === 0) return false;
      const candidates: string[] = [];
      if (person.name) candidates.push(person.name);
      if (person.id) candidates.push(person.id);
      if (person.email) {
        candidates.push(person.email);
        const at = person.email.indexOf('@');
        if (at > 0) candidates.push(person.email.slice(0, at));
      }
      return candidates.some((c) => {
        const k = looseKey(c);
        return k !== '' && keys.has(k);
      });
    },
  };
}

// ───────────────────────────── page -> card ─────────────────────────────

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Joins a Notion rich-text array (`plain_text` of each segment). */
export function plain(v: unknown): string {
  return arr(v)
    .map((seg) => str(rec(seg).plain_text) ?? str(rec(rec(seg).text).content) ?? '')
    .join('');
}

/** The value object of a page property: by name, falling back to the property id (renamed since the schema was read). */
function propValue(
  properties: Record<string, unknown>,
  prop: NotionProp | undefined,
): Record<string, unknown> | undefined {
  if (!prop) return undefined;
  const byName = properties[prop.name];
  if (byName !== undefined) return rec(byName);
  if (prop.id) {
    for (const v of Object.values(properties)) {
      if (str(rec(v).id) === prop.id) return rec(v);
    }
  }
  return undefined;
}

/** Text of title / rich_text / formula(string) / select-like values; undefined when absent or not text. */
function textOf(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  switch (value.type) {
    case 'title':
      return plain(value.title);
    case 'rich_text':
      return plain(value.rich_text);
    case 'formula':
      return str(rec(value.formula).string);
    case 'url':
      return str(value.url);
    default:
      return undefined;
  }
}

/** Option name of a status / select (first of a multi_select); null when empty. */
function optionNameOf(value: Record<string, unknown> | undefined): string | null | undefined {
  if (!value) return undefined;
  switch (value.type) {
    case 'status':
      return str(rec(value.status).name) ?? null;
    case 'select':
      return str(rec(value.select).name) ?? null;
    case 'multi_select':
      return str(rec(arr(value.multi_select)[0]).name) ?? null;
    default:
      return undefined;
  }
}

/** Option name or text, whichever the property holds (a rollup: its first item's). */
function labelOf(value: Record<string, unknown> | undefined): string | undefined {
  if (value?.type === 'rollup') {
    const r = rec(value.rollup);
    if (r.type === 'array') {
      for (const item of arr(r.array)) {
        const t = labelOf(rec(item));
        if (t) return t;
      }
      return undefined;
    }
    return undefined;
  }
  const o = optionNameOf(value);
  if (o !== undefined) return o ?? undefined;
  return textOf(value);
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };

/** A number from number / formula(number) / select or text holding a number ("3", "3 pts"). */
function numberOf(value: Record<string, unknown> | undefined): number | null {
  if (!value) return null;
  if (value.type === 'number') return typeof value.number === 'number' ? value.number : null;
  if (value.type === 'formula') {
    const f = rec(value.formula);
    if (typeof f.number === 'number') return f.number;
  }
  const t = labelOf(value);
  const roman = t ? ROMAN[t.trim().toUpperCase()] : undefined;
  if (roman !== undefined) return roman;
  const m = t?.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Configured spelling when `raw` equals one of `known` ignoring case/whitespace; else `raw` (trimmed). */
export function canonicalName(raw: string, known: readonly string[]): string {
  const key = normalizeName(raw);
  return known.find((k) => normalizeName(k) === key) ?? raw.trim();
}

/**
 * The configured status a write should use, or null when the board has none for it. A request for one spelling of
 * Complete resolves to the spelling this workspace has ("Complete" -> "Completed").
 */
export function resolveStatus(
  requested: string,
  known: readonly string[],
  groups: StatusGroups,
): string | null {
  const name = canonicalName(requested, known);
  if (known.some((k) => normalizeName(k) === normalizeName(name))) return name;
  const { isComplete } = statusGroupTest(groups);
  return isComplete(requested) ? (known.find((k) => isComplete(k)) ?? null) : null;
}

function peopleOf(value: Record<string, unknown> | undefined): NotionPerson[] {
  if (!value || value.type !== 'people') return [];
  const out: NotionPerson[] = [];
  for (const raw of arr(value.people)) {
    const u = rec(raw);
    const id = str(u.id);
    const name = str(u.name)?.trim();
    const email = str(rec(u.person).email);
    if (!id && !name && !email) continue;
    out.push({
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    });
  }
  return out;
}

const iso = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/** Everything of a `Card` the page itself provides. `assignedAt*` / `syncedAt` are decided by the store. */
export type CardFields = Omit<Card, 'assignedAtFirstSeen' | 'assignedAtApprox' | 'syncedAt'>;

export interface NormalizedPage {
  fields: CardFields;
  /** At least one assignee is me (per `MeMatcher`). */
  assignedToMe: boolean;
  /** Raw value of the optional Notion "Assigned at" date property. */
  assignedAtProperty?: string | null;
  /** Number of assignees on the page (identity diagnostics). */
  assigneeCount: number;
  /** More than one relation target in the parent property (only the first is used). */
  multiParent: boolean;
}

export type NormalizeResult =
  ({ ok: true } & NormalizedPage) | { ok: false; id?: string; reason: string };

export interface NormalizeContext {
  schema: ResolvedSchema;
  knownStatuses: readonly string[];
  knownTypes: readonly string[];
  me: MeMatcher;
  /** Fallback for a page without usable timestamps. */
  now: number;
}

export function normalizePage(page: unknown, ctx: NormalizeContext): NormalizeResult {
  const p = rec(page);
  const rawId = str(p.id);
  const id = rawId ? normalizeNotionId(rawId) : undefined;
  if (!id)
    return { ok: false, ...(rawId ? { id: clip(rawId, 40) } : {}), reason: 'page has no valid id' };
  if (p.object !== undefined && p.object !== 'page') {
    return { ok: false, id, reason: `result is a "${clip(String(p.object), 20)}", not a page` };
  }

  const properties = rec(p.properties);
  const { roles } = ctx.schema;

  let title = textOf(propValue(properties, roles.title));
  if (title === undefined && !roles.title) {
    // No configured/detected title property: the page's own `title` value still tells us.
    for (const v of Object.values(properties)) {
      if (rec(v).type === 'title') {
        title = textOf(rec(v));
        break;
      }
    }
  }

  const rawStatus = optionNameOf(propValue(properties, roles.status));
  const rawType = optionNameOf(propValue(properties, roles.type));

  const people = peopleOf(propValue(properties, roles.assignee));
  const names: string[] = [];
  for (const person of people) {
    const label = person.name ?? person.email ?? person.id;
    if (label && !names.includes(label)) names.push(label);
  }

  const date = rec(rec(propValue(properties, roles.estimation)).date);
  const estimationStart = str(date.start) ?? null;
  const estimationEnd = estimationStart ? (str(date.end) ?? null) : null;

  const branchRaw = textOf(propValue(properties, roles.branchName))?.trim();

  const relation = arr(rec(propValue(properties, roles.parent)).relation);
  const parentIds = relation
    .map((r) => str(rec(r).id))
    .map((r) => (r ? normalizeNotionId(r) : undefined))
    .filter((r): r is string => r !== undefined);

  const subTaskIds = arr(rec(propValue(properties, roles.subTasks)).relation)
    .map((r) => str(rec(r).id))
    .map((r) => (r ? normalizeNotionId(r) : undefined))
    .filter((r): r is string => r !== undefined);

  const domainRaw = labelOf(propValue(properties, roles.productDomain))?.trim();
  const sprintRaw = labelOf(propValue(properties, roles.sprint))?.trim();

  const created = iso(p.created_time);
  const lastEdited = iso(p.last_edited_time) ?? created ?? ctx.now;

  return {
    ok: true,
    fields: {
      id,
      title: (title ?? '').trim(),
      status: rawStatus ? canonicalName(rawStatus, ctx.knownStatuses) : null,
      type: rawType ? canonicalName(rawType, ctx.knownTypes) : null,
      assignees: names,
      estimationStart,
      estimationEnd,
      branchName: branchRaw ? branchRaw : null,
      parentId: parentIds[0] ?? null,
      productDomain: domainRaw ? domainRaw : null,
      point: numberOf(propValue(properties, roles.point)),
      sprint: sprintRaw ? sprintRaw : null,
      subTaskIds,
      url: str(p.url) ?? null,
      notionCreatedAt: created,
      lastEditedAt: lastEdited,
      archived: p.in_trash === true || p.archived === true,
    },
    assignedToMe: people.some((person) => ctx.me.matches(person)),
    assignedAtProperty: str(rec(rec(propValue(properties, roles.assignedAt)).date).start) ?? null,
    assigneeCount: people.length,
    multiParent: parentIds.length > 1,
  };
}

// ───────────────────────────── live status of one page (write path) ─────────────────────────────

/** What the write path needs from `GET /pages/:id` / the `PATCH /pages/:id` answer. */
export interface LivePageStatus {
  /** Normalized page id. */
  id: string;
  /** Option name as Notion has it, `null` when the property is empty. */
  name: string | null;
  /** Option id, `null` when the property is empty. */
  optionId: string | null;
  lastEditedAt: number | null;
  /** Archived or in the trash: a write would be refused (or pointless). */
  archived: boolean;
}

/** Reads the status property of a page object. `undefined` when the payload is not a page or has no such property. */
export function readLiveStatus(page: unknown, statusProp: NotionProp): LivePageStatus | undefined {
  const p = rec(page);
  const id = str(p.id) ? normalizeNotionId(str(p.id)!) : undefined;
  if (!id) return undefined;
  if (p.object !== undefined && p.object !== 'page') return undefined;
  const value = propValue(rec(p.properties), statusProp);
  if (!value) return undefined;
  const slot = value.type === 'status' ? rec(value.status) : rec(value.select);
  if (value.type !== 'status' && value.type !== 'select') return undefined;
  return {
    id,
    name: str(slot.name) ?? null,
    optionId: str(slot.id) ?? null,
    lastEditedAt: iso(p.last_edited_time),
    archived: p.archived === true || p.in_trash === true,
  };
}
