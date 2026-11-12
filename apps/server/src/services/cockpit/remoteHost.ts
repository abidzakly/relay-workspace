import type { SquashResult, WsCommit } from './branchOps';
import {
  AgentRefusedError,
  AgentUnreachableError,
  type HostAgentClient,
} from '../../hostAgent/client';
import type { CockpitSession, DiffFile, FlutterDevice, RunTargets } from '@relay/shared';
import { readNdjson } from '../../hostAgent/protocol';
import type { SessionEvent } from './sessions';
import type { ExistingBranch, IntegrityStep } from './workflowOps';
import type {
  CleanupApplyResult,
  TmpCleanupFacts,
  WsCleanupFacts,
  WsCleanupItem,
} from './wsCleanup';
import {
  CockpitHostError,
  type AiRunRequest,
  type CockpitHost,
  type CockpitHostHealth,
  type SessionStartOpts,
  type WsRef,
  type WsValidation,
} from './host';
import type { DiffMode, WsStatus } from './workspaceFs';

/** Maps agent failures to `CockpitHostError` (the agent answers `{ error, code }` on refusals). */
export async function viaAgent<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      throw new CockpitHostError('agent_unreachable', e.message, 503);
    if (e instanceof AgentRefusedError) {
      let code = 'agent_refused';
      let message = e.message;
      let details: unknown;
      try {
        const b = JSON.parse(e.detail) as { code?: unknown; error?: unknown; details?: unknown };
        if (typeof b.code === 'string') code = b.code;
        if (typeof b.error === 'string') message = b.error;
        details = b.details;
      } catch {
        /* not JSON */
      }
      throw new CockpitHostError(code, message, e.status >= 500 ? 502 : e.status, details);
    }
    throw e;
  }
}

/** The dashboard in Docker: everything runs on the Mac through `pnpm agent`. */
export class RemoteCockpitHost implements CockpitHost {
  constructor(protected readonly agent: HostAgentClient) {}

  health(refresh = false): Promise<CockpitHostHealth> {
    return viaAgent(() =>
      this.agent.json<CockpitHostHealth>(
        'GET',
        `/v1/cockpit/health${refresh ? '?refresh=1' : ''}`,
        undefined,
        20_000,
      ),
    );
  }

  ai(req: AiRunRequest): Promise<{ text: string }> {
    return viaAgent(() =>
      this.agent.json<{ text: string }>('POST', '/v1/cockpit/ai', req, req.timeoutMs + 10_000),
    );
  }

  private ws<T>(op: string, body: Record<string, unknown>, timeoutMs = 90_000): Promise<T> {
    return viaAgent(() => this.agent.json<T>('POST', `/v1/cockpit/ws/${op}`, body, timeoutMs));
  }

  wsValidate(ref: WsRef): Promise<WsValidation> {
    return this.ws('validate', { ref });
  }
  async wsEnsureAgentRules(ref: WsRef): Promise<void> {
    await this.ws('agent-rules', { ref });
  }
  wsStatus(ref: WsRef): Promise<WsStatus> {
    return this.ws('status', { ref });
  }
  wsDiff(ref: WsRef, mode: DiffMode, base?: string): Promise<{ files: DiffFile[]; label: string }> {
    return this.ws('diff', { ref, mode, ...(base ? { base } : {}) });
  }
  wsTree(ref: WsRef): Promise<{ paths: string[]; truncated: boolean }> {
    return this.ws('tree', { ref });
  }
  wsReadFile(ref: WsRef, rel: string): Promise<{ content: string; hash: string; size: number }> {
    return this.ws('read', { ref, rel });
  }
  wsWriteFile(
    ref: WsRef,
    rel: string,
    content: string,
    expectedHash: string | null,
  ): Promise<{ hash: string }> {
    return this.ws('write', { ref, rel, content, expectedHash });
  }
  wsCheckpoint(ref: WsRef): Promise<{ n: number }> {
    return this.ws('checkpoint', { ref });
  }

  private s<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 20_000,
  ): Promise<T> {
    return viaAgent(() =>
      this.agent.json<T>(method, `/v1/cockpit/sessions${path}`, body, timeoutMs),
    );
  }

  sessionStart(ref: WsRef, opts: SessionStartOpts): Promise<CockpitSession> {
    return this.s('POST', '', { ref, ...opts });
  }
  sessions(): Promise<CockpitSession[]> {
    return this.s('GET', '');
  }
  async sessionInput(id: string, data: string): Promise<void> {
    await this.s('POST', `/${id}/input`, { data });
  }
  async sessionResize(id: string, cols: number, rows: number): Promise<void> {
    await this.s('POST', `/${id}/resize`, { cols, rows });
  }
  async sessionKill(id: string): Promise<void> {
    await this.s('POST', `/${id}/kill`, {});
  }
  async sessionAttach(
    id: string,
    since: number,
    onEvent: (e: SessionEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const body = await viaAgent(() =>
      this.agent.stream(`/v1/cockpit/sessions/${id}/attach?since=${since}`, signal),
    );
    try {
      for await (const e of readNdjson<SessionEvent | { t: 'hb' }>(body)) {
        if (e.t === 'hb') continue;
        onEvent(e);
        if (e.t === 'exit') return;
      }
    } catch (e) {
      if (!signal.aborted) throw e;
    }
  }
  flutterDevices(ref: WsRef): Promise<FlutterDevice[]> {
    return this.ws('devices', { ref }, 120_000);
  }
  flutterRunTargets(ref: WsRef): Promise<RunTargets> {
    return this.ws('run-targets', { ref });
  }
  async flutterLaunchEmulator(ref: WsRef, emulatorId: string): Promise<void> {
    await this.ws('launch-emulator', { ref, emulatorId });
  }
  wsIntegrity(ref: WsRef): Promise<{ ok: boolean; steps: IntegrityStep[] }> {
    return this.ws('integrity', { ref }, 11 * 60_000);
  }
  wsLog(ref: WsRef, base: string): Promise<WsCommit[]> {
    return this.ws('log', { ref, base });
  }
  wsSquashForMr(ref: WsRef, branch: string, base: string): Promise<SquashResult> {
    return this.ws('squash-for-mr', { ref, branch, base }, 3 * 60_000);
  }
  wsStartBranch(
    ref: WsRef,
    branch: string,
    base: string,
    existing?: ExistingBranch,
  ): Promise<{ branch: string; base: string; replaced: boolean; reused?: boolean }> {
    // `replace` too: a host agent older than `existing` still understands that one.
    return this.ws('start-branch', {
      ref,
      branch,
      base,
      existing,
      replace: existing === 'replace',
    });
  }

  wsAddWorktree(
    ref: WsRef,
    branch: string,
    base: string,
    existing?: ExistingBranch,
  ): Promise<{ path: string; replaced?: boolean; reused?: boolean }> {
    return this.ws('add-worktree', { ref, branch, base, existing }, 3 * 60_000);
  }

  async wsRemoveWorktree(ref: WsRef, path: string): Promise<void> {
    await this.ws('remove-worktree', { ref, path });
  }

  wsCleanTree(
    ref: WsRef,
    mode: 'stash' | 'discard',
  ): Promise<{ mode: 'stash' | 'discard'; stash: string | null }> {
    return this.ws('clean-tree', { ref, clean: mode });
  }

  wsCheckoutBranch(ref: WsRef, branch: string): Promise<{ branch: string; synced: boolean }> {
    return this.ws('checkout-branch', { ref, branch });
  }

  wsSaveAttachment(
    ref: WsRef,
    group: string,
    name: string,
    dataBase64: string,
  ): Promise<{ path: string }> {
    return this.ws('save-attachment', { ref, group, name, dataBase64 });
  }
  wsCleanupFacts(ref: WsRef, base: string): Promise<WsCleanupFacts> {
    return this.ws('cleanup-facts', { ref, base });
  }
  wsCleanupApply(
    ref: WsRef,
    base: string,
    items: readonly WsCleanupItem[],
  ): Promise<CleanupApplyResult> {
    // A prune fetches and may run `git gc`.
    return this.ws('cleanup-apply', { ref, base, items }, 7 * 60_000);
  }
  tmpCleanupFacts(): Promise<TmpCleanupFacts> {
    return viaAgent(() =>
      this.agent.json<TmpCleanupFacts>('POST', '/v1/cockpit/tmp-cleanup/facts', {}, 60_000),
    );
  }
  tmpCleanupApply(names: readonly string[]): Promise<CleanupApplyResult> {
    return viaAgent(() =>
      this.agent.json<CleanupApplyResult>(
        'POST',
        '/v1/cockpit/tmp-cleanup/apply',
        { names },
        60_000,
      ),
    );
  }
}
