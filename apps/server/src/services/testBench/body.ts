import { createHash } from 'node:crypto';
import type { AcItem } from '@relay/shared';
import type { NotionBlock } from '../notionService';
import { plain } from '../notionCard';

/**
 * Reads what the Test Bench needs from a card body. Pure. Ported from dashboard-qa `services/notion/body.ts`, with
 * two fixes: blocks come from a recursive reader (nested lists and toggles at any depth stay inside their AC
 * section), and each AC carries a stable `key` derived from its text.
 *
 *  - AC: to-do / bulleted / numbered items under a heading that matches `headings` (until the next heading of the
 *    same or a higher level). A not-met item may carry its reason after `reasonMarker`. A stray to-do anywhere else
 *    still counts (cards without the template headings).
 *  - Figma: the first figma.com link anywhere. Docs: every docs.google.com link.
 *  - Description: the plain text outside AC sections, clipped.
 */

export interface ParsedBody {
  ac: AcItem[];
  figmaUrl: string | null;
  docLinks: string[];
  description: string;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const HEADING_LEVEL: Record<string, number> = { heading_1: 1, heading_2: 2, heading_3: 3 };
const ITEM_TYPES = new Set(['to_do', 'bulleted_list_item', 'numbered_list_item']);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const FIGMA_RE = /^https:\/\/([a-z0-9-]+\.)*figma\.com\//i;

const normHeading = (s: string) =>
  s
    .toLowerCase()
    .replace(/[:：*_#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A heading is an AC heading when it contains one of `headings`; very short ones ("QA") must match a whole word. */
export function isAcHeading(text: string, headings: readonly string[]): boolean {
  const h = normHeading(text);
  return headings.some((raw) => {
    const want = normHeading(raw);
    if (!want) return false;
    if (want.length <= 3) return h.split(/[^\p{L}\p{N}]+/u).includes(want);
    return h.includes(want);
  });
}

/** Splits "text — reason: why" into text and reason (null when there is no marker or nothing after it). */
export function splitReason(text: string, marker: string): { text: string; reason: string | null } {
  const at = text.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (at < 0) return { text: text.trim(), reason: null };
  const reason = text.slice(at + marker.length).trim();
  const head = text
    .slice(0, at)
    .replace(/[\s—–\-|(]+$/u, '')
    .trim();
  return { text: head, reason: reason || null };
}

/** Stable AC key: same words → same key, whatever the spacing, case or block id. */
export function acKey(text: string): string {
  const norm = text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(norm).digest('base64url').slice(0, 16);
}

function linksOf(block: NotionBlock): string[] {
  const out: string[] = [];
  const slot = rec(block[block.type]);
  for (const seg of Array.isArray(slot.rich_text) ? slot.rich_text : []) {
    const s = rec(seg);
    const href = typeof s.href === 'string' ? s.href : rec(rec(s.text).link).url;
    if (typeof href === 'string') out.push(href);
    const t = typeof s.plain_text === 'string' ? s.plain_text : '';
    out.push(...(t.match(URL_RE) ?? []));
  }
  const direct = slot.url;
  if (typeof direct === 'string') out.push(direct);
  const ext = rec(slot.external).url;
  if (typeof ext === 'string') out.push(ext);
  return out;
}

export function parseBody(
  blocks: readonly NotionBlock[],
  opts: { headings: readonly string[]; reasonMarker: string; descriptionMax?: number },
): ParsedBody {
  const ac: AcItem[] = [];
  const keys = new Set<string>();
  const links: string[] = [];
  const description: string[] = [];
  // The open AC section: its heading level and the blocks inside it (nested children count as inside).
  let section: { title: string; level: number } | null = null;
  const inSection = new Set<string>();

  const push = (b: NotionBlock, raw: string, sectionTitle: string | null) => {
    const { text, reason } = splitReason(raw, opts.reasonMarker);
    if (!text) return;
    let key = acKey(text);
    // Two identical lines stay two items.
    for (let n = 2; keys.has(key); n++) key = acKey(`${text}#${n}`);
    keys.add(key);
    ac.push({
      id: b.id,
      key,
      text,
      notionChecked: b.type === 'to_do' && rec(b.to_do).checked === true,
      reason,
      section: sectionTitle,
      kind: b.type === 'to_do' ? 'todo' : 'bullet',
      parentId: b.parentId,
    });
  };

  for (const b of blocks) {
    links.push(...linksOf(b));
    const text = plain(rec(b[b.type]).rich_text).trim();
    const level = HEADING_LEVEL[b.type];
    if (level !== undefined) {
      if (isAcHeading(text, opts.headings))
        section = { title: text.replace(/[:：\s]+$/u, ''), level };
      else if (!section || level <= section.level) section = null;
      // A toggle heading's children belong to it.
      if (section) inSection.add(b.id);
      continue;
    }
    const inside = section !== null && (b.parentId === null || inSection.has(b.parentId));
    if (inside) inSection.add(b.id);
    if (inside && ITEM_TYPES.has(b.type)) {
      push(b, text, section!.title);
      continue;
    }
    if (!inside && b.type === 'to_do' && text) {
      push(b, text, null);
      continue;
    }
    const prose =
      b.type === 'paragraph' ||
      ITEM_TYPES.has(b.type) ||
      b.type === 'quote' ||
      b.type === 'callout';
    if (!inside && text && prose) {
      // The template's grey hint lines are not content.
      if (rec(b[b.type]).color === 'gray') continue;
      description.push(b.type === 'paragraph' ? text : `• ${text}`);
    }
  }

  const unique = [...new Set(links.map((l) => l.replace(/[.,;]+$/, '')))];
  const max = opts.descriptionMax ?? 1500;
  const desc = description.join('\n');
  return {
    ac,
    figmaUrl: unique.find((l) => FIGMA_RE.test(l)) ?? null,
    docLinks: unique.filter((l) => /^https:\/\/docs\.google\.com\//i.test(l)),
    description: desc.length > max ? `${desc.slice(0, max)}…` : desc,
  };
}

export { parseFigmaUrl } from '@relay/shared';
