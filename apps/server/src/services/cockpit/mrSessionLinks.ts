import { SessionMrLinkSchema, type SessionMrLink } from '@relay/shared';
import { z } from 'zod';

/** Settings row (`state.<name>`) that keeps the links across restarts. */
export const MR_SESSION_LINKS_STATE = 'cockpit.mrSessions';
/** Old links beyond this are dropped; ended sessions are pruned as the session list is read. */
const MAX_LINKS = 200;

const StoredSchema = z.record(z.string(), SessionMrLinkSchema);

/**
 * Which agent session works on which MR. The host keeps sessions; this keeps only the link, so MR Detail can open
 * "its" session and the Cockpit can go back to the MR. Kept in a settings row: no host change, no migration.
 */
export class MrSessionLinks {
  private links: Record<string, SessionMrLink>;

  constructor(
    private readonly state: {
      load: () => unknown;
      save: (value: Record<string, SessionMrLink> | undefined) => void;
    },
  ) {
    const parsed = StoredSchema.safeParse(state.load() ?? {});
    this.links = parsed.success ? parsed.data : {};
  }

  get(sessionId: string): SessionMrLink | undefined {
    return this.links[sessionId];
  }

  set(sessionId: string, link: SessionMrLink): void {
    const next = { ...this.links };
    delete next[sessionId];
    next[sessionId] = link;
    const entries = Object.entries(next);
    this.links = Object.fromEntries(entries.slice(-MAX_LINKS));
    this.save();
  }

  /** Drops links of sessions the host no longer has. */
  prune(sessionIds: ReadonlySet<string>): void {
    const kept = Object.entries(this.links).filter(([id]) => sessionIds.has(id));
    if (kept.length === Object.keys(this.links).length) return;
    this.links = Object.fromEntries(kept);
    this.save();
  }

  private save(): void {
    this.state.save(Object.keys(this.links).length > 0 ? this.links : undefined);
  }
}
