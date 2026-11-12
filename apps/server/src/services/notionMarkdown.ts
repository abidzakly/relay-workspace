import type { NotionBlock } from './notionService';

/**
 * A Notion page body as markdown, for an agent to read. Pure. Unlike the Test Bench parser (`testBench/body.ts`),
 * nothing is dropped as "template noise": grey hint text is kept (marked as a note), because a card does not always
 * follow the template and the agent decides what matters. Images and files become numbered references the caller
 * can download and save next to the prompt.
 *
 * Blocks come from `NotionService.readBlocksDeep`: document order, children right after their parent.
 */

export interface NotionAssetRef {
  /** 1-based, matches the `[image N]` / `[file N]` placeholder in the markdown. */
  n: number;
  blockId: string;
  kind: 'image' | 'file';
  url: string;
  /** Notion-hosted (signed, expires within the hour) vs an external link. */
  hosted: boolean;
  caption: string;
  /** File name hint from the URL path or the block's name. */
  name: string;
}

export interface NotionMarkdown {
  markdown: string;
  assets: NotionAssetRef[];
  links: string[];
  truncated: boolean;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Rich text with links, code, strikethrough and emphasis kept; grey segments wrapped as a note. */
export function richToMarkdown(v: unknown): string {
  return arr(v)
    .map((seg) => {
      const s = rec(seg);
      let t = str(s.plain_text) || str(rec(s.text).content);
      if (!t) return '';
      const a = rec(s.annotations);
      const href = str(s.href) || str(rec(rec(s.text).link).url);
      if (a.code === true) t = `\`${t}\``;
      else {
        if (a.bold === true) t = `**${t}**`;
        if (a.italic === true) t = `_${t}_`;
      }
      if (a.strikethrough === true) t = `~~${t}~~`;
      if (href && href !== t) t = `[${t}](${href})`;
      if (str(a.color).startsWith('gray')) t = `(note: ${t})`;
      return t;
    })
    .join('');
}

function linksIn(slot: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const seg of arr(slot.rich_text).concat(arr(slot.caption))) {
    const s = rec(seg);
    const href = str(s.href) || str(rec(rec(s.text).link).url);
    if (href) out.push(href);
    out.push(...(str(s.plain_text).match(URL_RE) ?? []));
  }
  if (str(slot.url)) out.push(str(slot.url));
  return out;
}

function fileUrl(slot: Record<string, unknown>): { url: string; hosted: boolean } | null {
  const hosted = str(rec(slot.file).url);
  if (hosted) return { url: hosted, hosted: true };
  const ext = str(rec(slot.external).url);
  if (ext) return { url: ext, hosted: false };
  return null;
}

function nameFromUrl(url: string, fallback: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return last || fallback;
  } catch {
    return fallback;
  }
}

export function blocksToMarkdown(
  blocks: readonly NotionBlock[],
  opts: { maxChars: number; truncated?: boolean },
): NotionMarkdown {
  const depthOf = new Map<string, number>();
  const assets: NotionAssetRef[] = [];
  const links: string[] = [];
  const lines: string[] = [];
  // Numbered lists restart per parent.
  const numbered = new Map<string, number>();
  let tableRow = 0;

  for (const b of blocks) {
    const depth = b.parentId === null ? 0 : (depthOf.get(b.parentId) ?? 0) + 1;
    // A toggle/heading/list item's children are indented under it; a column/column_list is transparent.
    const transparent =
      b.type === 'column_list' || b.type === 'column' || b.type === 'synced_block';
    depthOf.set(b.id, transparent ? depth - 1 : depth);
    const pad = '  '.repeat(Math.max(0, depth));
    const slot = rec(b[b.type]);
    links.push(...linksIn(slot));
    const text = richToMarkdown(slot.rich_text).trim();
    const key = b.parentId ?? '';
    if (b.type !== 'numbered_list_item') numbered.delete(key);
    if (b.type !== 'table_row') tableRow = 0;

    switch (b.type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3': {
        const level = Number(b.type.slice(-1));
        lines.push('', `${'#'.repeat(level)} ${text}`);
        break;
      }
      case 'paragraph':
        lines.push(text ? `${pad}${text}` : '');
        break;
      case 'bulleted_list_item':
        lines.push(`${pad}- ${text}`);
        break;
      case 'numbered_list_item': {
        const n = (numbered.get(key) ?? 0) + 1;
        numbered.set(key, n);
        lines.push(`${pad}${n}. ${text}`);
        break;
      }
      case 'to_do':
        lines.push(`${pad}- [${slot.checked === true ? 'x' : ' '}] ${text}`);
        break;
      case 'toggle':
        lines.push(`${pad}- ▸ ${text}`);
        break;
      case 'quote':
        lines.push(`${pad}> ${text}`);
        break;
      case 'callout': {
        const icon = str(rec(slot.icon).emoji);
        lines.push(`${pad}> ${icon ? `${icon} ` : ''}${text}`);
        break;
      }
      case 'code': {
        const lang = str(slot.language);
        const raw = arr(slot.rich_text)
          .map((s) => str(rec(s).plain_text))
          .join('');
        lines.push(`${pad}\`\`\`${lang === 'plain text' ? '' : lang}`, raw, `${pad}\`\`\``);
        break;
      }
      case 'equation':
        lines.push(`${pad}$${str(slot.expression)}$`);
        break;
      case 'divider':
        lines.push(`${pad}---`);
        break;
      case 'table_row': {
        const cells = arr(slot.cells).map((c) => richToMarkdown(c).replace(/\|/g, '\\|').trim());
        lines.push(`${pad}| ${cells.join(' | ')} |`);
        if (tableRow === 0) lines.push(`${pad}|${cells.map(() => ' --- ').join('|')}|`);
        tableRow++;
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview':
      case 'link_to_page': {
        const url = str(slot.url);
        const caption = richToMarkdown(slot.caption).trim();
        if (url) lines.push(`${pad}- ${caption ? `${caption}: ` : ''}${url}`);
        break;
      }
      case 'image':
      case 'file':
      case 'pdf':
      case 'video':
      case 'audio': {
        const f = fileUrl(slot);
        if (!f) break;
        const kind = b.type === 'image' ? 'image' : 'file';
        const n = assets.filter((a) => a.kind === kind).length + 1;
        const caption = richToMarkdown(slot.caption).trim();
        assets.push({
          n,
          blockId: b.id,
          kind,
          url: f.url,
          hosted: f.hosted,
          caption,
          name: str(slot.name) || nameFromUrl(f.url, `${kind}-${n}`),
        });
        lines.push(`${pad}[${kind} ${n}${caption ? `: ${caption}` : ''}]`);
        break;
      }
      case 'child_page':
        lines.push(`${pad}- (sub-page) ${str(slot.title)}`);
        break;
      case 'child_database':
        lines.push(`${pad}- (database) ${str(slot.title)}`);
        break;
      default:
        if (text) lines.push(`${pad}${text}`);
    }
  }

  let markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let truncated = opts.truncated === true;
  if (markdown.length > opts.maxChars) {
    markdown = `${markdown.slice(0, opts.maxChars)}\n… (card body truncated)`;
    truncated = true;
  }
  const unique = [...new Set(links.map((l) => l.replace(/[.,;]+$/, '')))];
  return { markdown, assets, links: unique, truncated };
}
