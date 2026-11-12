import type { Card } from '@relay/shared';
import type { AppDb } from '../../db/open';
import type { Logger } from '../../util/logger';
import type { HttpClient } from '../httpClient';
import { blocksToMarkdown, type NotionAssetRef } from '../notionMarkdown';
import type { NotionService } from '../notionService';
import { getCard } from '../notionStore';

/**
 * The whole Notion card body (and its parent's, for a sub-task) as markdown, for "Start with agent". Cards do not
 * always carry an "Acceptance Criteria" heading, so nothing is filtered here: the agent reads everything and derives
 * the requirements itself. Cached per card edit for a few minutes so the dialog preview and the start share one
 * Notion read (block reads are paced at ~3 req/s), well inside the hour Notion's signed image URLs live.
 */

const CARD_MAX_CHARS = 24_000;
const PARENT_MAX_CHARS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const ASSETS_MAX = 10;
const CARD_BLOCKS_MAX = 800;
const PARENT_BLOCKS_MAX = 300;

export interface CardBodyContent {
  markdown: string;
  truncated: boolean;
  links: string[];
}

export interface CardContent {
  card: CardBodyContent;
  parent: (CardBodyContent & { id: string; title: string; url: string | null }) | null;
  /** Images and files embedded in the card body (the parent's are not downloaded). */
  assets: NotionAssetRef[];
  /** Why the parent could not be read; the card body still is. */
  parentError: string | null;
  fetchedAt: number;
}

export interface DownloadedAsset {
  name: string;
  dataBase64: string;
  ref: NotionAssetRef;
}

export interface CardContentDeps {
  notion: NotionService;
  store: AppDb;
  http: HttpClient;
  log: Logger;
  now?: () => number;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

export class CardContentService {
  private readonly cache = new Map<string, { at: number; value: CardContent }>();
  private readonly now: () => number;

  constructor(private readonly d: CardContentDeps) {
    this.now = d.now ?? Date.now;
  }

  async read(card: Card, opts: { force?: boolean } = {}): Promise<CardContent> {
    const key = `${card.id}@${card.lastEditedAt}`;
    const hit = this.cache.get(key);
    if (!opts.force && hit && this.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const notion = this.d.notion;
    const own = await notion.readBlocksDeep(card.id, { maxBlocks: CARD_BLOCKS_MAX });
    const body = blocksToMarkdown(own.blocks, {
      maxChars: CARD_MAX_CHARS,
      truncated: own.truncated,
    });

    let parent: CardContent['parent'] = null;
    let parentError: string | null = null;
    if (card.parentId) {
      try {
        const cached = getCard(this.d.store, card.parentId);
        const title = cached?.title ?? (await this.pageTitle(card.parentId)) ?? '(parent card)';
        const blocks = await notion.readBlocksDeep(card.parentId, { maxBlocks: PARENT_BLOCKS_MAX });
        const md = blocksToMarkdown(blocks.blocks, {
          maxChars: PARENT_MAX_CHARS,
          truncated: blocks.truncated,
        });
        parent = {
          id: card.parentId,
          title,
          url: cached?.url ?? null,
          markdown: md.markdown,
          truncated: md.truncated,
          links: md.links,
        };
      } catch (e) {
        parentError = e instanceof Error ? e.message : String(e);
        this.d.log.warn({ cardId: card.id, err: parentError }, 'card content: parent unreadable');
      }
    }

    const value: CardContent = {
      card: { markdown: body.markdown, truncated: body.truncated, links: body.links },
      parent,
      assets: body.assets.slice(0, ASSETS_MAX),
      parentError,
      fetchedAt: this.now(),
    };
    for (const [k, v] of this.cache) if (this.now() - v.at >= CACHE_TTL_MS) this.cache.delete(k);
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  /**
   * Downloads the card's embedded images/files (max 10, 5 MB each: the HTTP client's cap). A failure is reported,
   * never thrown: the agent still gets the text and is told which attachment is missing.
   */
  async downloadAssets(
    content: CardContent,
  ): Promise<{ ok: DownloadedAsset[]; failed: { ref: NotionAssetRef; reason: string }[] }> {
    const ok: DownloadedAsset[] = [];
    const failed: { ref: NotionAssetRef; reason: string }[] = [];
    for (const ref of content.assets) {
      try {
        const res = await this.d.http.send({ url: ref.url, binary: true, timeoutMs: 30_000 });
        if (res.status !== 200 || !res.bytes) throw new Error(`HTTP ${res.status}`);
        const type = String(res.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim();
        const ext = EXT_BY_TYPE[type] ?? extOf(ref.name) ?? (ref.kind === 'image' ? 'png' : 'bin');
        ok.push({
          name: `notion-${ref.kind}-${ref.n}.${ext}`,
          dataBase64: res.bytes.toString('base64'),
          ref,
        });
      } catch (e) {
        failed.push({ ref, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ok, failed };
  }

  /** Title of a page that is not in the card cache (a parent owned by someone else). */
  private async pageTitle(pageId: string): Promise<string | null> {
    const page = rec(await this.d.notion.request('GET', `/pages/${encodeURIComponent(pageId)}`));
    for (const v of Object.values(rec(page.properties))) {
      const p = rec(v);
      if (p.type !== 'title' || !Array.isArray(p.title)) continue;
      const t = p.title
        .map((s) => String(rec(s).plain_text ?? ''))
        .join('')
        .trim();
      if (t) return t;
    }
    return null;
  }
}

function extOf(name: string): string | null {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}
