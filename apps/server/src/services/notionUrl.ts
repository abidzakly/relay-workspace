/**
 * Notion page id extraction from free text ("same regex as vcheck:
 * notion.so|site|com", "same extract_page_id logic as nts: 32-hex last segment, dashed UUID").
 * The original vcheck/nts scripts were not available in the sandbox, so this follows that
 * description: UNVERIFIED against them.
 */

const NOTION_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*notion\.(?:so|site|com)\/[^\s<>"'`)\]]*/gi;
/** Sentence punctuation and markdown emphasis/quoting that can cling to a pasted URL (`**https://…**`). */
const TRAILING_PUNCT_RE = /[.,;:!?*_~|}]+$/;
/** A dashed UUID or a plain 32-hex id that is not part of a longer hex run. The LAST one in a segment wins. */
const ID_RE =
  /(?<![0-9a-f])([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-f])/gi;

function lastIdIn(text: string): string | undefined {
  let found: string | undefined;
  for (const m of text.matchAll(ID_RE)) found = m[1];
  return found ? normalizeNotionId(found) : undefined;
}

/** Normalises a 32-hex or dashed id to lowercase dashed UUID form (the form the Notion API returns). */
export function normalizeNotionId(raw: string): string | undefined {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idFromUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // Database "peek" links carry the page id in ?p=<id>; it wins over the (database) path id.
  const p = url.searchParams.get('p');
  if (p) {
    const id = lastIdIn(p);
    if (id) return id;
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    /* keep raw */
  }
  return lastIdIn(decoded);
}

/** First Notion page id found in `text` (an MR description), or undefined. */
export function extractNotionPageId(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  for (const match of text.matchAll(NOTION_URL_RE)) {
    const id = idFromUrl(match[0].replace(TRAILING_PUNCT_RE, ''));
    if (id) return id;
  }
  return undefined;
}
