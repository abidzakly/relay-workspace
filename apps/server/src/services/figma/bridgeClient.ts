import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Logger } from '../../util/logger';

/**
 * Client for the Figma MCP bridge (https://github.com/gethopp/figma-mcp-bridge): a stdio MCP server that talks to the
 * plugin running in the Figma desktop app. The first bridge process on the Mac leads (port 1994, plugin WebSocket); any
 * other one, e.g. the one a coding tool starts, follows it. So running this client next to Cursor is fine.
 *
 * The bridge is started lazily on the first call and restarted on the next call after it dies. No Figma token is involved.
 */

export interface BridgeFile {
  fileKey: string;
  fileName: string;
}

/** What `FigmaService` needs from the bridge; the tests replace it. */
export interface FigmaBridge {
  /** Calls a bridge tool and returns its JSON payload. Throws `BridgeToolError` when the tool refuses. */
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Files that have the plugin open right now. Starts the bridge when needed. */
  files(): Promise<BridgeFile[]>;
  /** The reason the last start failed (null when it is, or was never, down). */
  lastError(): string | null;
  /** True while a bridge process is running. */
  running(): boolean;
  close(): Promise<void>;
}

/** The bridge process could not be started, or died while answering. */
export class BridgeUnavailableError extends Error {}
/** The bridge answered, but the tool failed (plugin not connected, node not found, ...). */
export class BridgeToolError extends Error {}

export const DEFAULT_BRIDGE_CMD = 'npx -y @gethopp/figma-mcp-bridge';
const CALL_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 60_000;

export interface McpFigmaBridgeOptions {
  /** Shell-style command line; split on whitespace (no quoting). */
  command?: string;
  log: Logger;
}

export class McpFigmaBridge implements FigmaBridge {
  private client: Client | null = null;
  private starting: Promise<Client> | null = null;
  private error: string | null = null;
  private closed = false;

  constructor(private readonly o: McpFigmaBridgeOptions) {}

  running(): boolean {
    return this.client !== null;
  }

  lastError(): string | null {
    return this.error;
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Client> {
    if (this.closed) throw new BridgeUnavailableError('The Figma bridge is shut down.');
    const [command, ...args] = (this.o.command?.trim() || DEFAULT_BRIDGE_CMD).split(/\s+/);
    // The SDK passes a safe default environment (PATH, HOME, ...): no secret of ours reaches the child.
    const transport = new StdioClientTransport({
      command: command!,
      args,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'relay', version: '1.0.0' });
    transport.onclose = () => {
      if (this.client === client) this.client = null;
      this.o.log.info('figma bridge stopped');
    };
    try {
      await client.connect(transport, { timeout: START_TIMEOUT_MS });
    } catch (err) {
      await transport.close().catch(() => undefined);
      this.error = `Could not start the Figma bridge (${command}): ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.o.log.warn(this.error);
      throw new BridgeUnavailableError(this.error);
    }
    this.error = null;
    this.client = client;
    this.o.log.info('figma bridge started');
    return client;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = await this.connect();
    let res: Awaited<ReturnType<Client['callTool']>>;
    try {
      res = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
    } catch (err) {
      throw new BridgeUnavailableError(
        `The Figma bridge did not answer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    if (res.isError) throw new BridgeToolError(text || `Figma bridge tool ${tool} failed.`);
    try {
      return JSON.parse(text);
    } catch {
      throw new BridgeToolError(`Figma bridge tool ${tool} returned something unreadable.`);
    }
  }

  async files(): Promise<BridgeFile[]> {
    const out = await this.call('list_files');
    return Array.isArray(out) ? (out as BridgeFile[]) : [];
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }
}
