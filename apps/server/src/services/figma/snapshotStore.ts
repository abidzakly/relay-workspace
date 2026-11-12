import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FigmaNodeSpec } from './figmaService';

/**
 * Figma snapshots per card: the node spec and its PNG, saved when the bridge answers so a card keeps its design data
 * while the bridge (or the plugin) is down. Kept until the card's MR is merged or the card is done; storage cleanup
 * removes them (rule "figma-cards"). Layout: `<data>/figma-cards/<cardId>/<fileKey>_<node>.json|.png`.
 */

export const FIGMA_CARDS_DIR = 'figma-cards';

const CARD_RE = /^[A-Za-z0-9-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const NODE_RE = /^\d+:\d+$/;

export interface FigmaSnapshot {
  spec: FigmaNodeSpec;
  png: Buffer | null;
  savedAt: number;
}

export class FigmaSnapshotStore {
  /** `dataDir`: the dashboard data dir; snapshots live in its `figma-cards/`. */
  constructor(private readonly dataDir: string) {}

  private dir(cardId: string): string {
    if (!CARD_RE.test(cardId)) throw new Error('bad card id');
    return join(this.dataDir, FIGMA_CARDS_DIR, cardId);
  }

  private base(fileKey: string, nodeId: string): string {
    if (!KEY_RE.test(fileKey) || !NODE_RE.test(nodeId)) throw new Error('bad Figma node');
    return `${fileKey}_${nodeId.replace(':', '-')}`;
  }

  async save(cardId: string, spec: FigmaNodeSpec, png: Buffer | null): Promise<void> {
    const dir = this.dir(cardId);
    const base = this.base(spec.fileKey, spec.nodeId);
    await mkdir(dir, { recursive: true });
    const put = async (name: string, data: string | Buffer) => {
      await writeFile(join(dir, `${name}.part`), data);
      await rename(join(dir, `${name}.part`), join(dir, name));
    };
    await put(`${base}.json`, JSON.stringify(spec));
    if (png) await put(`${base}.png`, png);
  }

  async get(cardId: string, fileKey: string, nodeId: string): Promise<FigmaSnapshot | null> {
    const p = join(this.dir(cardId), this.base(fileKey, nodeId));
    const st = await stat(`${p}.json`).catch(() => null);
    if (!st) return null;
    try {
      const spec = JSON.parse(await readFile(`${p}.json`, 'utf8')) as FigmaNodeSpec;
      const png = await readFile(`${p}.png`).catch(() => null);
      return { spec, png, savedAt: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /** The newest saved PNG of a node, whichever card saved it (the Test Bench asks by file and node only). */
  async image(fileKey: string, nodeId: string): Promise<Buffer | null> {
    const name = `${this.base(fileKey, nodeId)}.png`;
    const root = join(this.dataDir, FIGMA_CARDS_DIR);
    const cards = await readdir(root).catch(() => [] as string[]);
    let best: { at: number; path: string } | null = null;
    for (const c of cards) {
      if (!CARD_RE.test(c)) continue;
      const path = join(root, c, name);
      const st = await stat(path).catch(() => null);
      if (st && (!best || st.mtimeMs > best.at)) best = { at: st.mtimeMs, path };
    }
    return best ? readFile(best.path).catch(() => null) : null;
  }
}
