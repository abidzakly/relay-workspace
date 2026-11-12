import { randomBytes } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  POSTRACK_READ_TOOLS,
  POSTRACK_WRITE_TOOLS,
  postrackToolIsWrite,
  type PostrackToolsProfile,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import { ActionError } from '../actionError';
import type { PostrackService } from './postrackService';

/** A token not yet tied to a session (the session is still starting) stays usable this long. */
const UNBOUND_TTL_MS = 2 * 60_000;

interface Grant {
  write: boolean;
  sessionId: string | null;
  at: number;
}

/**
 * The Postrack tools as one agent session sees them. Each Claude session with Postrack gets its own token, valid while
 * that session lives. The token decides whether the write tools exist for it: without "Agent may update Postrack" they
 * are left out of the tool list and refused when called anyway. The Postrack credential stays in Relay.
 */
export class PostrackAgentTools {
  private readonly grants = new Map<string, Grant>();

  constructor(
    private readonly d: {
      postrack: PostrackService;
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

  /** The tools for a new Claude session, or null when Postrack is off or not set up (the session starts without). */
  profileFor(want: { write: boolean }): PostrackToolsProfile | null {
    if (!this.d.postrack.enabled() || !this.d.postrack.configured()) return null;
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
    if ((POSTRACK_READ_TOOLS as readonly string[]).includes(name)) return true;
    return write && (POSTRACK_WRITE_TOOLS as readonly string[]).includes(name);
  }

  async list(token: string | undefined): Promise<{ tools: Tool[]; write: boolean }> {
    const g = await this.grant(token);
    // Tools Postrack adds later are left out until Relay knows whether they write.
    const tools = (await this.d.postrack.listTools()).filter((t) => this.allowed(t.name, g.write));
    return { tools, write: g.write };
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
            text: postrackToolIsWrite(name)
              ? `${name} changes Postrack, and this session may only read it. List the change in your report instead; the user applies it or starts the card again with "Agent may update Postrack".`
              : `${name} is not a Postrack tool this session can use.`,
          },
        ],
        isError: true,
      };
    }
    let result: CallToolResult;
    try {
      result = await this.d.postrack.callTool(name, args);
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
    if (postrackToolIsWrite(name)) {
      // Ids only: bodies can hold anything, secrets included.
      const ids = Object.fromEntries(
        Object.entries(args).filter(
          ([k, v]) => /(^id$|Id$|^key$|^name$)/.test(k) && typeof v === 'string',
        ),
      );
      this.d.audit.write({
        actor: 'user',
        action: `postrack.${name}`,
        targetType: 'postrack',
        targetId: String(
          args.id ?? args.environmentId ?? args.collectionId ?? args.folderId ?? name,
        ),
        before: null,
        after: { via: 'agent', sessionId: g.sessionId, ok: !result.isError, ...ids },
      });
    }
    return result;
  }
}
