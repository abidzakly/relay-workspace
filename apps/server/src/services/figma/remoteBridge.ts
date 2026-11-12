import {
  AgentRefusedError,
  AgentUnreachableError,
  type HostAgentClient,
} from '../../hostAgent/client';
import {
  BridgeToolError,
  BridgeUnavailableError,
  type BridgeFile,
  type FigmaBridge,
} from './bridgeClient';

/**
 * The Figma bridge when the dashboard runs in Docker: the bridge runs on the Mac (`pnpm agent`), next to the Figma
 * desktop app, and this class asks the host agent for it. Same calls and errors as `McpFigmaBridge`.
 */

// The agent's own call timeout is 60s; leave it room to answer before the dashboard gives up.
const CALL_TIMEOUT_MS = 65_000;
const FILES_TIMEOUT_MS = 10_000;

export class RemoteFigmaBridge implements FigmaBridge {
  private error: string | null = null;

  constructor(private readonly agent: HostAgentClient) {}

  running(): boolean {
    return this.agent.lastHealth().health !== null;
  }

  lastError(): string | null {
    return this.error;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.agent.json('POST', '/v1/figma/call', { tool, args }, CALL_TIMEOUT_MS);
    } catch (e) {
      throw this.map(e);
    }
  }

  async files(): Promise<BridgeFile[]> {
    try {
      const out = await this.agent.json<unknown>(
        'GET',
        '/v1/figma/files',
        undefined,
        FILES_TIMEOUT_MS,
      );
      this.error = null;
      return Array.isArray(out) ? (out as BridgeFile[]) : [];
    } catch (e) {
      throw this.map(e);
    }
  }

  async close(): Promise<void> {
    // The agent owns the bridge process; nothing to stop here.
  }

  private map(e: unknown): Error {
    if (e instanceof AgentUnreachableError) {
      this.error = e.message;
      return new BridgeUnavailableError(e.message);
    }
    if (e instanceof AgentRefusedError) {
      let body: { message?: string } = {};
      try {
        body = JSON.parse(e.detail) as typeof body;
      } catch {
        /* not JSON */
      }
      const message =
        body.message ?? `The host agent refused the Figma request (HTTP ${e.status}).`;
      if (e.status === 422) return new BridgeToolError(message);
      this.error = message;
      return new BridgeUnavailableError(message);
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}
