import type { TestRunProfile } from '@relay/shared';
import {
  aiGeneratedByLabel,
  AgentModelsSchema,
  SessionStartSchema,
  type AgentModels,
  type CockpitSession,
  type ConversationCommand,
  type SessionStartInput,
} from '@relay/shared';
import type { EventBus } from '../../sync/eventBus';
import type { Logger } from '../../util/logger';
import type { AiService } from '../ai/aiService';
import type { Notifier } from '../notifier';
import { CockpitHostError, type CockpitHost } from './host';
import type { WorkspaceService } from './workspaces';

/**
 * Cockpit sessions on the server side. The host owns the PTYs; this service adds:
 *  - a checkpoint before every composer prompt to an agent (so "Review turn" shows only that turn's changes),
 *  - turn-done detection (host idle heuristic) → web push + `cockpit.changed` with the turn's file count/headline.
 */

export interface TurnInfo {
  checkpoint: number | null;
  files: number | null;
  headline: string | null;
  at: number;
  workspaceId: string;
  /** The user finished a review deck of this turn's changes. */
  reviewed?: boolean;
}

export type SessionView = CockpitSession & { turn: TurnInfo | null };

export interface SessionServiceDeps {
  host: CockpitHost;
  workspaces: WorkspaceService;
  log: Logger;
  bus?: EventBus;
  notifier?: Notifier;
  ai?: AiService;
  /** Settings' coding agent for new sessions that nobody picked an agent for. Default Claude. */
  preferredAgent?: () => 'claude' | 'cursor';
  /** Settings' plan / execution models. Default: Opus 5.5 plans, Sonnet 5.5 (medium) executes. */
  agentModels?: () => AgentModels;
  /** Cursor's TUI needs a moment to draw before the first prompt (ms). Tests set 0. */
  cursorBootMs?: number;
  now?: () => number;
  pollMs?: number;
}

const AGENT_KINDS = new Set(['claude', 'cursor']);
/** Bracketed paste: a multi-line prompt arrives as one paste, Enter then submits it. */
export const asPrompt = (text: string): string =>
  `\x1b[200~${text.replace(/\r\n/g, '\n')}\x1b[201~`;

export class CockpitSessionService {
  private readonly turns = new Map<string, TurnInfo>();
  private readonly waiting = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly d: SessionServiceDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private changed(id?: string): void {
    try {
      this.d.bus?.emit({ type: 'cockpit.changed', what: 'sessions', ...(id ? { id } : {}) });
    } catch {
      /* cosmetic */
    }
  }

  async list(): Promise<SessionView[]> {
    const items = await this.d.host.sessions();
    return items.map((s) => ({ ...s, turn: this.turns.get(s.id) ?? null }));
  }

  async start(req: SessionStartInput): Promise<CockpitSession> {
    const parsed = SessionStartSchema.parse(req);
    if (parsed.kind === 'claude' || parsed.kind === 'cursor') {
      // Plan on the big model, execute on the cheaper one. A model picked by the caller other than the plan model
      // stays as picked.
      const cfg = this.d.agentModels?.() ?? AgentModelsSchema.parse({});
      parsed.model ??= parsed.kind === 'claude' ? cfg.planModel : cfg.cursorModel;
      if (
        parsed.kind === 'claude' &&
        parsed.model === cfg.planModel &&
        cfg.execModel !== parsed.model
      ) {
        parsed.execModel ??= cfg.execModel;
        parsed.execEffort ??= cfg.execEffort;
        parsed.execSwitch ??= cfg.execSwitch;
      }
    }
    const s = await this.d.host.sessionStart(this.d.workspaces.ref(parsed.workspaceId), {
      kind: parsed.kind,
      deviceId: parsed.deviceId,
      cols: parsed.cols,
      rows: parsed.rows,
      flavor: parsed.flavor,
      mode: parsed.mode,
      ios: parsed.ios,
      model: parsed.model,
      execModel: parsed.execModel,
      execEffort: parsed.execEffort,
      execSwitch: parsed.execSwitch,
    });
    this.changed(s.id);
    this.ensurePolling();
    return s;
  }

  /** An AI device test: a Claude or Cursor session limited to the bench and Marionette tools. */
  async startTestRun(workspaceId: string, testRun: TestRunProfile): Promise<CockpitSession> {
    const s = await this.d.host.sessionStart(this.d.workspaces.ref(workspaceId), {
      kind: testRun.engine,
      cols: 100,
      rows: 30,
      testRun,
    });
    this.changed(s.id);
    this.ensurePolling();
    return s;
  }

  private async session(id: string): Promise<CockpitSession> {
    const s = (await this.d.host.sessions()).find((x) => x.id === id);
    if (!s) throw new CockpitHostError('session_not_found', 'Unknown session.', 404);
    return s;
  }

  input(id: string, data: string): Promise<void> {
    return this.d.host.sessionInput(id, data);
  }

  /**
   * A composer prompt. For an agent: checkpoint the workspace first (the turn's "before"), then paste + Enter.
   * A failing checkpoint does not block the prompt (the turn review then falls back to the previous checkpoint).
   */
  async prompt(id: string, text: string): Promise<{ checkpoint: number | null }> {
    const s = await this.session(id);
    let n: number | null = null;
    if (AGENT_KINDS.has(s.kind)) {
      try {
        n = (await this.d.host.wsCheckpoint(this.d.workspaces.ref(s.workspaceId))).n;
      } catch (e) {
        this.d.log.warn({ id, err: (e as Error).message }, 'checkpoint before prompt failed');
      }
      this.turns.set(id, {
        checkpoint: n,
        files: null,
        headline: null,
        at: this.now(),
        workspaceId: s.workspaceId,
      });
      this.waiting.set(id, false);
    }
    if (s.kind === 'claude') {
      const cmd: ConversationCommand = { type: 'prompt', text };
      await this.d.host.sessionInput(id, JSON.stringify(cmd));
    } else {
      await this.d.host.sessionInput(id, AGENT_KINDS.has(s.kind) ? asPrompt(text) : text);
      await this.d.host.sessionInput(id, '\r');
    }
    this.ensurePolling();
    return { checkpoint: n };
  }

  resize(id: string, cols: number, rows: number): Promise<void> {
    return this.d.host.sessionResize(id, cols, rows);
  }

  async kill(id: string): Promise<void> {
    await this.d.host.sessionKill(id);
    this.changed(id);
  }

  /** A new agent session of the configured preference (Settings → AI). */
  async startPreferred(
    workspaceId: string,
    pick: { kind?: 'claude' | 'cursor'; model?: string } = {},
  ): Promise<CockpitSession> {
    const kind = pick.kind ?? this.d.preferredAgent?.() ?? 'claude';
    const s = await this.start({
      workspaceId,
      kind,
      cols: 100,
      rows: 30,
      ...(pick.model ? { model: pick.model } : {}),
    });
    if (kind === 'cursor') await new Promise((r) => setTimeout(r, this.d.cursorBootMs ?? 2_500));
    return s;
  }

  /** "Send to agent now" from the deck: the workspace's agent session (a new Claude one if none runs). */
  async sendToAgent(
    workspaceId: string,
    prompt: string,
    opts: { returnTo?: string } = {},
  ): Promise<{ sessionId: string }> {
    const sessions = await this.d.host.sessions();
    let s = sessions.find(
      (x) => x.workspaceId === workspaceId && AGENT_KINDS.has(x.kind) && x.state !== 'exited',
    );
    if (!s) s = await this.startPreferred(workspaceId);
    // Only an in-app Test Bench path: a notification link must never point elsewhere.
    if (opts.returnTo && /^\/test-bench\/[a-z0-9-]+\?branch=[^\s#]+$/.test(opts.returnTo)) {
      this.returnTo.set(s.id, opts.returnTo);
    }
    await this.prompt(s.id, prompt);
    return { sessionId: s.id };
  }

  /** Where "back" goes when an agent sent from another page finishes (session id → app path). */
  private readonly returnTo = new Map<string, string>();

  // ───────────────────────────── turn-done watcher ─────────────────────────────

  private ensurePolling(): void {
    if (this.timer || this.closed) return;
    const tick = () => {
      this.timer = undefined;
      if (this.closed) return;
      void this.poll().finally(() => {
        if (!this.closed) this.timer = setTimeout(tick, this.d.pollMs ?? 3_000).unref();
      });
    };
    this.timer = setTimeout(tick, this.d.pollMs ?? 3_000).unref();
  }

  /** One pass: notices agents that just started waiting. Stops polling when nothing runs. Exported for tests. */
  async poll(): Promise<void> {
    let items: CockpitSession[];
    try {
      items = await this.d.host.sessions();
    } catch {
      return;
    }
    for (const s of items) {
      const was = this.waiting.get(s.id) ?? false;
      this.waiting.set(s.id, s.waiting);
      if (s.waiting && !was && AGENT_KINDS.has(s.kind)) await this.turnDone(s);
      if (s.state === 'exited' && was) this.changed(s.id);
    }
    if (!items.some((s) => s.state !== 'exited') && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async turnDone(s: CockpitSession): Promise<void> {
    const turn = this.turns.get(s.id) ?? {
      checkpoint: null,
      files: null,
      headline: null,
      at: this.now(),
      workspaceId: s.workspaceId,
    };
    try {
      const ref = this.d.workspaces.ref(s.workspaceId);
      const diff = await this.d.host.wsDiff(
        ref,
        'turn',
        turn.checkpoint ? String(turn.checkpoint) : undefined,
      );
      turn.files = diff.files.length;
      if (this.d.ai && diff.files.length > 0) {
        const text = diff.files
          .map((f) => `### ${f.path}\n${f.diff ?? ''}`)
          .join('\n\n')
          .slice(0, 40_000);
        turn.headline = await this.d.ai
          .run('turn-summary', { diff: text })
          .then((r) => `${r.output.headline} (${aiGeneratedByLabel(r.generatedBy)})`)
          .catch(() => null);
      }
    } catch {
      /* no checkpoint yet: still notify */
    }
    this.turns.set(s.id, turn);
    this.changed(s.id);
    const ws = (() => {
      try {
        return this.d.workspaces.get(s.workspaceId);
      } catch {
        return null;
      }
    })();
    const files = turn.files;
    this.d.notifier?.notifyCockpit({
      event: 'agentDone',
      key: `agent:${s.id}:${turn.at}`,
      ttlMs: 60_000,
      title: `${s.title} ${files ? 'finished' : 'needs you'}${ws ? ` · ${ws.name}` : ''}`,
      body:
        turn.headline ??
        (!files
          ? 'The agent is waiting for you.'
          : `Agent finished, ${files} file${files === 1 ? '' : 's'} changed → Review`),
      url: this.returnTo.has(s.id)
        ? `/cockpit?session=${s.id}&returnTo=${encodeURIComponent(this.returnTo.get(s.id)!)}`
        : files && files > 0
          ? `/review/local/${encodeURIComponent(s.workspaceId)}/deck?mode=turn${turn.checkpoint ? `&base=${turn.checkpoint}` : ''}`
          : `/cockpit?session=${s.id}`,
      tag: `agent-${s.id}`,
      repoId: ws?.repoId ?? null,
      subject: { kind: 'session', sessionId: s.id, hasFiles: Boolean(files && files > 0) },
    });
  }

  /**
   * A review deck of a workspace was finished: its turns no longer need a review. `base` is the turn deck's checkpoint;
   * without one (working / branch deck) every turn of the workspace counts.
   */
  markTurnReviewed(workspaceId: string, base?: string): void {
    for (const [id, t] of this.turns) {
      if (t.workspaceId !== workspaceId || t.reviewed) continue;
      if (base !== undefined && String(t.checkpoint ?? '') !== base) continue;
      t.reviewed = true;
      this.changed(id);
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
