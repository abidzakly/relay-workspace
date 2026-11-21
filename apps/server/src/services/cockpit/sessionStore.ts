import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CockpitSessionSchema, CONVERSATION_MODES, type CockpitSession } from '@relay/shared';
import { z } from 'zod';
import type { Logger } from '../../util/logger';

/**
 * Agent sessions (Claude, Cursor) kept on disk until the user ends them, so a chat survives a host restart: `meta.json`
 * (what to restart and resume) and `events.ndjson` (every conversation event, the same lines the stream replays).
 * One directory per session under `<DATA_DIR>/cockpit-sessions`.
 */

const ID_RE = /^[0-9a-f-]{36}$/;

export const PersistedSpecSchema = z.object({
  cwd: z.string().min(1),
  wsId: z.string().min(1),
  kind: z.enum(['claude', 'cursor']),
  model: z.string().optional(),
  execModel: z.string().optional(),
  execEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  execSwitch: z.enum(['ask', 'auto']).optional(),
  /** The CLI's own session (Claude) or chat (Cursor) id: `--resume`. */
  resumeId: z.string().max(128).optional(),
  mode: z.enum(CONVERSATION_MODES).optional(),
});
export type PersistedSpec = z.infer<typeof PersistedSpecSchema>;

const MetaSchema = z.object({ info: CockpitSessionSchema, spec: PersistedSpecSchema });

export interface PersistedSession {
  info: CockpitSession;
  spec: PersistedSpec;
  events: string;
}

export class SessionStore {
  constructor(
    private readonly root: string,
    private readonly log: Logger,
  ) {}

  private dir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`bad session id ${id}`);
    return join(this.root, id);
  }

  /** Any session on disk: the host restores them on start. */
  hasAny(): boolean {
    try {
      return readdirSync(this.root).some((n) => ID_RE.test(n));
    } catch {
      return false;
    }
  }

  saveMeta(info: CockpitSession, spec: PersistedSpec): void {
    try {
      const d = this.dir(info.id);
      mkdirSync(d, { recursive: true, mode: 0o700 });
      writeFileSync(join(d, 'meta.json'), JSON.stringify({ info, spec }), { mode: 0o600 });
    } catch (e) {
      this.log.warn({ id: info.id, err: (e as Error).message }, 'cockpit session meta not saved');
    }
  }

  appendEvents(id: string, data: string): void {
    try {
      const d = this.dir(id);
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
      appendFileSync(join(d, 'events.ndjson'), data, { mode: 0o600 });
    } catch (e) {
      this.log.warn({ id, err: (e as Error).message }, 'cockpit session events not saved');
    }
  }

  /** Everything written so far (a full replay after the ring buffer dropped its start). */
  readEvents(id: string): string {
    try {
      return readFileSync(join(this.dir(id), 'events.ndjson'), 'utf8');
    } catch {
      return '';
    }
  }

  remove(id: string): void {
    try {
      rmSync(this.dir(id), { recursive: true, force: true });
    } catch (e) {
      this.log.warn({ id, err: (e as Error).message }, 'cockpit session not removed');
    }
  }

  loadAll(): PersistedSession[] {
    let names: string[];
    try {
      names = readdirSync(this.root).filter((n) => ID_RE.test(n));
    } catch {
      return [];
    }
    const out: PersistedSession[] = [];
    for (const id of names) {
      try {
        const meta = MetaSchema.parse(
          JSON.parse(readFileSync(join(this.root, id, 'meta.json'), 'utf8')),
        );
        if (meta.info.id !== id) continue;
        out.push({ ...meta, events: this.readEvents(id) });
      } catch (e) {
        this.log.warn({ id, err: (e as Error).message }, 'cockpit session on disk is unreadable');
      }
    }
    return out;
  }
}
