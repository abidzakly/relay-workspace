import { randomBytes } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  FIGMA_READ_TOOLS,
  FIGMA_WRITE_TOOLS,
  figmaToolIsWrite,
  type FigmaToolsProfile,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import { ActionError } from '../actionError';
import { BridgeUnavailableError, type FigmaBridge } from './bridgeClient';

/** A token not yet tied to a session (the session is still starting) stays usable this long. */
const UNBOUND_TTL_MS = 2 * 60_000;

interface Grant {
  write: boolean;
  sessionId: string | null;
  at: number;
}

/**
 * The Figma bridge tools as one agent session sees them. Each Claude session gets its own token, valid while that
 * session lives. The token decides whether the edit tools exist for it: without "Agent may edit Figma" they are left
 * out of the tool list and refused when called anyway. Edits act as whoever is signed in to the Figma desktop app.
 */
export class FigmaAgentTools {
  private readonly grants = new Map<string, Grant>();

  constructor(
    private readonly d: {
      bridge: FigmaBridge;
      audit: AuditWriter;
      /** Loopback address the agent's proxy process calls (`http://127.0.0.1:<port>`). */
      relayUrl: string;
      /** Ids of the sessions that are still running. */
      liveSessions: () => Promise<string[]>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The tools for a new Claude session, or null when the bridge cannot serve agent sessions. */
  profileFor(want: { write: boolean }): FigmaToolsProfile | null {
    if (!this.d.bridge.callTool || !this.d.bridge.listTools) return null;
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, { write: want.write, sessionId: null, at: this.now() });
    return { url: this.d.relayUrl, token, write: want.write };
  }

  bind(token: string, sessionId: string): void {
    const g = this.grants.get(token);
    if (g) g.sessionId = sessionId;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  private async grant(token: string | undefined): Promise<Grant> {
    const g = token ? this.grants.get(token) : undefined;
    if (!g || !token) throw new ActionError(401, 'bad_token', 'Unknown session token.');
    if (g.sessionId === null) {
      if (this.now() - g.at > UNBOUND_TTL_MS) {
        this.grants.delete(token);
        throw new ActionError(401, 'bad_token', 'The session token expired.');
      }
      return g;
    }
    const live = await this.d.liveSessions();
    // Drop every grant whose session is gone, this one included.
    for (const [t, x] of this.grants) {
      if (x.sessionId !== null && !live.includes(x.sessionId)) this.grants.delete(t);
    }
    if (!this.grants.has(token)) throw new ActionError(401, 'bad_token', 'The session has ended.');
    return g;
  }

  private allowed(name: string, write: boolean): boolean {
    if ((FIGMA_READ_TOOLS as readonly string[]).includes(name)) return true;
    return write && (FIGMA_WRITE_TOOLS as readonly string[]).includes(name);
  }

  async list(token: string | undefined): Promise<{ tools: Tool[]; write: boolean }> {
    const g = await this.grant(token);
    let tools: Tool[];
    try {
      tools = await this.d.bridge.listTools!();
    } catch (e) {
      if (e instanceof BridgeUnavailableError)
        throw new ActionError(503, 'bridge_unavailable', e.message);
      throw e;
    }
    return { tools: tools.filter((t) => this.allowed(t.name, g.write)), write: g.write };
  }

  async call(
    token: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const g = await this.grant(token);
    if (!this.allowed(name, g.write)) {
      return {
        content: [
          {
            type: 'text',
            text: figmaToolIsWrite(name)
              ? `${name} changes the Figma file, and this session may only read Figma. List the change in your report instead; the user applies it or starts the card again with "Agent may edit Figma".`
              : `${name} is not a Figma tool this session can use.`,
          },
        ],
        isError: true,
      };
    }
    let result: CallToolResult;
    try {
      result = await this.d.bridge.callTool!(name, args);
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
    if (figmaToolIsWrite(name)) {
      // Ids only: text content and SVG markup can be large.
      const ids = Object.fromEntries(
        Object.entries(args).filter(
          ([k, v]) =>
            /(^fileKey$|^nodeId$|^parentId$|Id$)/.test(k) &&
            (typeof v === 'string' || Array.isArray(v)),
        ),
      );
      this.d.audit.write({
        actor: 'user',
        action: `figma.${name}`,
        targetType: 'figma',
        targetId: String(args.nodeId ?? args.parentId ?? args.fileKey ?? name),
        before: null,
        after: { via: 'agent', sessionId: g.sessionId, ok: !result.isError, ...ids },
      });
    }
    return result;
  }
}
