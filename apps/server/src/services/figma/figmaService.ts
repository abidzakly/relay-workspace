import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FigmaBridgeStatus, FigmaFrame, FigmaFrames } from '@relay/shared';
import { ActionError } from '../actionError';
import {
  BridgeToolError,
  BridgeUnavailableError,
  type BridgeFile,
  type FigmaBridge,
} from './bridgeClient';
import type { FigmaSnapshotStore } from './snapshotStore';

/**
 * Figma frames for the Test Bench, read through the Figma MCP bridge: the plugin in the Figma
 * desktop app answers, so there is no token and no REST rate limit. The file must be open in Figma with the plugin
 * running. The frame list is cached in memory, rendered PNGs on disk; both for a short while, so a designer's change
 * shows up after a refresh.
 */

const FRAMES_TTL_MS = 5 * 60_000;
const IMAGE_TTL_MS = 10 * 60_000;
const MAX_FRAMES = 400;
const MAX_PAGES = 40;
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'INSTANCE']);

export class FigmaError extends ActionError {
  constructor(status: number, code: string, message?: string) {
    super(status, code, message);
    this.name = 'FigmaError';
  }
}

export interface FigmaServiceDeps {
  bridge: FigmaBridge;
  /** `<data dir>/figma`. */
  cacheDir: string;
  /** Saved card snapshots, served when the bridge is down. */
  snapshots?: FigmaSnapshotStore;
  now?: () => number;
}

export interface FigmaNodeSpec {
  fileKey: string;
  fileName: string | null;
  nodeId: string;
  /** The bridge's `get_node` tree, as is. */
  node: unknown;
  /** `get_styles` / `get_variable_defs`, or `{ unavailable: reason }`. */
  styles: unknown;
  variables: unknown;
}

const OFFLINE_CODES = new Set(['figma_bridge_unavailable', 'figma_file_not_open']);
const KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const NODE_RE = /^\d+:\d+$/;

const NOT_OPEN =
  'Open this file in the Figma desktop app and run the Figma MCP Bridge plugin (Plugins > Development).';

export class FigmaService {
  private readonly frameCache = new Map<string, { at: number; value: FigmaFrames }>();
  private readonly now: () => number;

  constructor(private readonly d: FigmaServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Figma is always offered: the bridge starts on demand. `status()` tells what is actually reachable. */
  get configured(): boolean {
    return true;
  }

  /** Bridge process state and the files with the plugin open. Never throws. */
  async status(): Promise<FigmaBridgeStatus> {
    try {
      return { bridge: 'up', files: await this.d.bridge.files(), error: null };
    } catch (err) {
      return {
        bridge: 'down',
        files: [],
        error: this.d.bridge.lastError() ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  /** Runs a bridge tool on one open file; maps bridge failures to dashboard errors. */
  private async tool(
    fileKey: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    let open: BridgeFile[];
    try {
      open = await this.d.bridge.files();
    } catch (err) {
      throw this.unavailable(err);
    }
    if (!open.some((f) => f.fileKey === fileKey)) {
      throw new FigmaError(409, 'figma_file_not_open', NOT_OPEN);
    }
    try {
      return await this.d.bridge.call(name, { ...args, fileKey });
    } catch (err) {
      if (err instanceof BridgeToolError) {
        if (/not found/i.test(err.message)) {
          throw new FigmaError(404, 'figma_not_found', 'Figma file or frame not found.');
        }
        if (/no plugin connected/i.test(err.message)) {
          throw new FigmaError(409, 'figma_file_not_open', NOT_OPEN);
        }
        throw new FigmaError(502, 'figma_failed', err.message.slice(0, 300));
      }
      throw this.unavailable(err);
    }
  }

  private unavailable(err: unknown): FigmaError {
    return new FigmaError(
      503,
      'figma_bridge_unavailable',
      err instanceof BridgeUnavailableError ? err.message : 'The Figma bridge is not reachable.',
    );
  }

  /** Top-level frames of every page (what a designer hands off), for the per-AC frame picker. */
  async frames(fileKey: string, opts: { force?: boolean } = {}): Promise<FigmaFrames> {
    if (!KEY_RE.test(fileKey)) throw new FigmaError(422, 'bad_file_key');
    const hit = this.frameCache.get(fileKey);
    if (hit && !opts.force && this.now() - hit.at < FRAMES_TTL_MS) return hit.value;
    const meta = (await this.tool(fileKey, 'get_metadata', {})) as {
      fileName?: string;
      pages?: Array<{ id?: string; name?: string }>;
    };
    const frames: FigmaFrame[] = [];
    let truncated = (meta.pages?.length ?? 0) > MAX_PAGES;
    for (const page of (meta.pages ?? []).slice(0, MAX_PAGES)) {
      if (!page.id || !NODE_RE.test(page.id)) continue;
      const node = (await this.tool(fileKey, 'get_node', { nodeId: page.id })) as {
        children?: Array<{ id?: string; name?: string; type?: string }>;
      };
      for (const c of node.children ?? []) {
        if (!c.id || !NODE_RE.test(c.id) || !FRAME_TYPES.has(c.type ?? '')) continue;
        if (frames.length >= MAX_FRAMES) {
          truncated = true;
          break;
        }
        frames.push({ id: c.id, name: c.name ?? c.id, page: page.name ?? '' });
      }
    }
    const value: FigmaFrames = {
      fileKey,
      fileName: typeof meta.fileName === 'string' ? meta.fileName : fileKey,
      lastModified: null,
      frames,
      truncated,
    };
    this.frameCache.set(fileKey, { at: this.now(), value });
    return value;
  }

  /**
   * Everything the bridge can read about one node, for a coding agent: the node and all its visible descendants with
   * their bounds and styles (fills, strokes, effects, radius, auto-layout, padding, constraints; text: characters,
   * font family/style/weight/size, line height, letter spacing, alignment), plus the file's local styles and
   * variables (design tokens). Styles and variables are best effort: a failure is noted, the node still comes back.
   */
  async nodeSpec(fileKey: string, nodeId: string): Promise<FigmaNodeSpec> {
    if (!KEY_RE.test(fileKey)) throw new FigmaError(422, 'bad_file_key');
    if (!NODE_RE.test(nodeId)) throw new FigmaError(422, 'bad_node_id');
    const node = await this.tool(fileKey, 'get_node', { nodeId });
    const extra = async (name: string): Promise<unknown> => {
      try {
        return await this.tool(fileKey, name, {});
      } catch (err) {
        return { unavailable: err instanceof Error ? err.message : String(err) };
      }
    };
    const meta = (await extra('get_metadata')) as { fileName?: unknown };
    return {
      fileKey,
      fileName: typeof meta.fileName === 'string' ? meta.fileName : null,
      nodeId,
      node,
      styles: await extra('get_styles'),
      variables: await extra('get_variable_defs'),
    };
  }

  /** PNG of one node (2x), from the disk cache when it is fresh. */
  async image(fileKey: string, nodeId: string, opts: { force?: boolean } = {}): Promise<Buffer> {
    if (!KEY_RE.test(fileKey)) throw new FigmaError(422, 'bad_file_key');
    if (!NODE_RE.test(nodeId)) throw new FigmaError(422, 'bad_node_id');
    const dir = join(this.d.cacheDir, fileKey);
    const file = join(dir, `${nodeId.replace(':', '-')}.png`);
    if (!opts.force) {
      const st = await stat(file).catch(() => null);
      if (st && this.now() - st.mtimeMs < IMAGE_TTL_MS) return readFile(file);
    }
    let out: { exports?: Array<{ base64?: string }> };
    try {
      out = (await this.tool(fileKey, 'get_screenshot', {
        nodeIds: [nodeId],
        format: 'PNG',
        scale: 2,
      })) as typeof out;
    } catch (err) {
      // Bridge or plugin away: an older render (cache, then a card's saved snapshot) beats no design at all.
      if (!(err instanceof FigmaError) || !OFFLINE_CODES.has(err.code)) throw err;
      const stale =
        (await readFile(file).catch(() => null)) ??
        (await this.d.snapshots?.image(fileKey, nodeId).catch(() => null)) ??
        null;
      if (stale) return stale;
      throw err;
    }
    const b64 = out.exports?.[0]?.base64;
    if (!b64) {
      throw new FigmaError(502, 'figma_render_failed', 'Figma could not render this frame.');
    }
    const bytes = Buffer.from(b64, 'base64');
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.part`, bytes);
    await rename(`${file}.part`, file);
    return bytes;
  }
}
