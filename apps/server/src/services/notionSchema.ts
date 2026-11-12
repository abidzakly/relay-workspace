import { normalizeName } from '@relay/shared';

/**
 * Pure helpers over the Notion data source schema (mirrors `nts`):
 *  - status property: `status` type first, else a `select` named "Status"
 *  - option names are resolved to option ids, case/whitespace-insensitively
 * Shape = documented `GET /v1/data_sources/:id` response (`properties` map). UNVERIFIED against a live sample.
 */

export interface NotionOption {
  id: string;
  name: string;
}

export interface NotionProp {
  id: string;
  name: string;
  type: string;
  /** Options for `status` / `select` / `multi_select` properties, else empty. */
  options: NotionOption[];
  /** Rollups only: the relation property it reads through. */
  rollupOf?: string;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Extracts the property list; `undefined` when the payload has no `properties` object. */
export function parseProperties(json: unknown): NotionProp[] | undefined {
  const properties = rec(json).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const out: NotionProp[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const p = rec(raw);
    const type = typeof p.type === 'string' ? p.type : '';
    if (!type) continue;
    const name = typeof p.name === 'string' && p.name ? p.name : key;
    const id = typeof p.id === 'string' ? p.id : '';
    const optionsRaw = rec(p[type]).options;
    const options: NotionOption[] = [];
    if (Array.isArray(optionsRaw)) {
      for (const o of optionsRaw) {
        const r = rec(o);
        if (typeof r.name === 'string' && typeof r.id === 'string') {
          options.push({ id: r.id, name: r.name });
        }
      }
    }
    const rollupOf = type === 'rollup' ? rec(p.rollup).relation_property_name : undefined;
    out.push({ id, name, type, options, ...(typeof rollupOf === 'string' ? { rollupOf } : {}) });
  }
  return out;
}

export interface PropLookup {
  prop: NotionProp;
  /** False when found only via the case/whitespace-insensitive match. */
  exact: boolean;
}

/** Exact name first, then a unique normalized match. `ambiguous` = several normalized matches. */
export function findProp(
  props: readonly NotionProp[],
  name: string,
): PropLookup | { ambiguous: NotionProp[] } | undefined {
  const exact = props.find((p) => p.name === name);
  if (exact) return { prop: exact, exact: true };
  const key = normalizeName(name);
  const hits = props.filter((p) => normalizeName(p.name) === key);
  if (hits.length === 1) return { prop: hits[0]!, exact: false };
  if (hits.length > 1) return { ambiguous: hits };
  return undefined;
}

export type StatusProp = NotionProp & { type: 'status' | 'select' };
const isStatusProp = (p: NotionProp): p is StatusProp => p.type === 'status' || p.type === 'select';

export type StatusDetection =
  | { ok: true; prop: StatusProp; via: 'status-type' | 'select-named-status' | 'configured' }
  | { ok: false; reason: 'not_found' | 'wrong_type' | 'ambiguous'; found?: NotionProp };

/** `configured` = `notion.props.status` ("auto" or a property name). */
export function detectStatusProp(
  props: readonly NotionProp[],
  configured: string,
): StatusDetection {
  if (normalizeName(configured) === 'auto') {
    const byType = props.find((p) => p.type === 'status');
    if (byType && isStatusProp(byType)) return { ok: true, prop: byType, via: 'status-type' };
    const sel = props.filter(
      (p): p is StatusProp => p.type === 'select' && normalizeName(p.name) === 'status',
    );
    if (sel.length === 1) return { ok: true, prop: sel[0]!, via: 'select-named-status' };
    if (sel.length > 1) return { ok: false, reason: 'ambiguous' };
    return { ok: false, reason: 'not_found' };
  }
  const hit = findProp(props, configured);
  if (!hit) return { ok: false, reason: 'not_found' };
  if ('ambiguous' in hit) return { ok: false, reason: 'ambiguous' };
  if (!isStatusProp(hit.prop)) return { ok: false, reason: 'wrong_type', found: hit.prop };
  return { ok: true, prop: hit.prop, via: 'configured' };
}

/** `auto` = the (single) `title` property. */
export function detectTitleProp(
  props: readonly NotionProp[],
  configured: string,
):
  | { ok: true; prop: NotionProp }
  | { ok: false; reason: 'not_found' | 'wrong_type'; found?: NotionProp } {
  if (normalizeName(configured) === 'auto') {
    const t = props.find((p) => p.type === 'title');
    return t ? { ok: true, prop: t } : { ok: false, reason: 'not_found' };
  }
  const hit = findProp(props, configured);
  if (!hit || 'ambiguous' in hit) return { ok: false, reason: 'not_found' };
  return hit.prop.type === 'title'
    ? { ok: true, prop: hit.prop }
    : { ok: false, reason: 'wrong_type', found: hit.prop };
}

export interface OptionResolution {
  /** Configured name -> resolved option (first match when ambiguous). */
  resolved: { configured: string; option: NotionOption }[];
  missing: string[];
  /** Configured names that match more than one option once normalized. */
  ambiguous: string[];
  /** Notion options no configured status maps to. */
  unmapped: NotionOption[];
}

export function resolveOptions(
  options: readonly NotionOption[],
  configured: readonly string[],
): OptionResolution {
  const resolved: OptionResolution['resolved'] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const used = new Set<string>();
  for (const name of configured) {
    const key = normalizeName(name);
    const hits = options.filter((o) => normalizeName(o.name) === key);
    if (hits.length === 0) {
      missing.push(name);
      continue;
    }
    if (hits.length > 1) ambiguous.push(name);
    resolved.push({ configured: name, option: hits[0]! });
    for (const h of hits) used.add(h.id);
  }
  return { resolved, missing, ambiguous, unmapped: options.filter((o) => !used.has(o.id)) };
}
