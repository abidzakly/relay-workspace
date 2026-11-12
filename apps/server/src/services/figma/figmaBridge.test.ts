import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BridgeToolError,
  BridgeUnavailableError,
  type BridgeFile,
  type FigmaBridge,
} from './bridgeClient';
import { FigmaService } from './figmaService';

const KEY = 'AbCdEfGhIjKlMn';
const PNG = Buffer.from('not-really-a-png');

class FakeBridge implements FigmaBridge {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  open: BridgeFile[] = [{ fileKey: KEY, fileName: 'Design' }];
  down: string | null = null;
  toolError: string | null = null;
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.down) throw new BridgeUnavailableError(this.down);
    this.calls.push({ tool, args });
    if (this.toolError) throw new BridgeToolError(this.toolError);
    if (tool === 'list_files') return this.open;
    if (tool === 'get_metadata') {
      return {
        fileName: 'Design',
        pages: [
          { id: '0:1', name: 'Login' },
          { id: '0:2', name: 'Home' },
        ],
      };
    }
    if (tool === 'get_node') {
      return args.nodeId === '0:1'
        ? {
            children: [
              { id: '1:2', name: 'Login / empty', type: 'FRAME' },
              { id: '1:3', name: 'note', type: 'TEXT' },
            ],
          }
        : { children: [{ id: '2:5', name: 'Home', type: 'COMPONENT' }] };
    }
    if (tool === 'get_screenshot') {
      return { exports: [{ nodeId: '1:2', base64: PNG.toString('base64') }] };
    }
    throw new Error(`unexpected ${tool}`);
  }
  async files() {
    return this.call('list_files') as Promise<BridgeFile[]>;
  }
  lastError() {
    return this.down;
  }
  running() {
    return !this.down;
  }
  async close() {}
}

describe('FigmaService on the bridge', () => {
  let dir: string;
  let bridge: FakeBridge;
  let svc: FigmaService;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figma-'));
    bridge = new FakeBridge();
    svc = new FigmaService({ bridge, cacheDir: dir });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('lists top-level frames of every page, skipping non-frames', async () => {
    const f = await svc.frames(KEY);
    expect(f.fileName).toBe('Design');
    expect(f.frames).toEqual([
      { id: '1:2', name: 'Login / empty', page: 'Login' },
      { id: '2:5', name: 'Home', page: 'Home' },
    ]);
    expect(f.truncated).toBe(false);
  });

  it('caches frames until forced', async () => {
    await svc.frames(KEY);
    const n = bridge.calls.length;
    await svc.frames(KEY);
    expect(bridge.calls.length).toBe(n);
    await svc.frames(KEY, { force: true });
    expect(bridge.calls.length).toBeGreaterThan(n);
  });

  it('renders a PNG and serves the second read from disk', async () => {
    expect((await svc.image(KEY, '1:2')).equals(PNG)).toBe(true);
    const shots = () => bridge.calls.filter((c) => c.tool === 'get_screenshot').length;
    expect(shots()).toBe(1);
    await svc.image(KEY, '1:2');
    expect(shots()).toBe(1);
    expect(bridge.calls.find((c) => c.tool === 'get_screenshot')?.args).toMatchObject({
      nodeIds: ['1:2'],
      fileKey: KEY,
      format: 'PNG',
    });
  });

  it('says 409 when the file does not have the plugin open', async () => {
    bridge.open = [];
    await expect(svc.frames(KEY)).rejects.toMatchObject({
      status: 409,
      code: 'figma_file_not_open',
    });
  });

  it('says 503 when the bridge cannot start, and reports it as down', async () => {
    bridge.down = 'no npx';
    await expect(svc.image(KEY, '1:2')).rejects.toMatchObject({
      status: 503,
      code: 'figma_bridge_unavailable',
    });
    expect(await svc.status()).toEqual({ bridge: 'down', files: [], error: 'no npx' });
  });

  it('maps a missing node to 404', async () => {
    bridge.toolError = 'Node not found: 9:9';
    // list_files is answered before the error is armed for tools: arm it after the open check
    const real = bridge.call.bind(bridge);
    bridge.call = async (tool, args) => (tool === 'list_files' ? bridge.open : real(tool, args));
    await expect(svc.image(KEY, '9:9')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects malformed ids before touching the bridge', async () => {
    await expect(svc.frames('x')).rejects.toMatchObject({ code: 'bad_file_key' });
    await expect(svc.image(KEY, '1-2')).rejects.toMatchObject({ code: 'bad_node_id' });
    expect(bridge.calls).toHaveLength(0);
  });
});
