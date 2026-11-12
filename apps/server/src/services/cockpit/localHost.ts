import { squashForMr, wsLog } from './branchOps';
import type { CockpitSession, DiffFile, FlutterDevice, RunTargets } from '@relay/shared';
import { ensureAgentRules } from './agentRules';
import {
  addWorktree,
  type ExistingBranch,
  checkoutBranch,
  cleanTree,
  integrityCheck,
  removeWorktree,
  startBranch,
} from './workflowOps';
import {
  tmpCleanupApply,
  tmpCleanupFacts,
  wsCleanupApply,
  wsCleanupFacts,
  type WsCleanupItem,
} from './wsCleanup';
import {
  chooseRunFlavor,
  flutterDevices,
  launchEmulator,
  readRunTargets,
  SessionManager,
  type SessionEvent,
} from './sessions';
import type { Logger } from '../../util/logger';
import { claudeAvailability, runClaudeCli } from './claudeCli';
import { cursorAvailability, runCursorCli } from './cursorCli';
import {
  CockpitHostError,
  type AiRunRequest,
  type CockpitHost,
  type CockpitHostHealth,
  type SessionStartOpts,
  type WsRef,
  type WsValidation,
} from './host';
import {
  checkpoint,
  guardWorkspace,
  parseWorkspaceRoots,
  readWsFile,
  saveAttachment,
  writeWsFile,
  wsDiff,
  wsIdentity,
  wsStatus,
  wsTree,
  type DiffMode,
  type WsStatus,
} from './workspaceFs';

export interface LocalCockpitHostOptions {
  log: Logger;
  /** Allowed workspace roots; default from `HOST_AGENT_WORKSPACE_ROOTS` (or `~/Work`). */
  workspaceRoots?: readonly string[];
}

/** Runs everything on this machine. Also the engine behind the host agent's `/v1/cockpit/*` routes. */
export class LocalCockpitHost implements CockpitHost {
  readonly roots: readonly string[];
  private mgr: SessionManager | null = null;

  constructor(protected readonly o: LocalCockpitHostOptions) {
    this.roots = o.workspaceRoots ?? parseWorkspaceRoots(process.env.HOST_AGENT_WORKSPACE_ROOTS);
  }

  /** Created on first use: node-pty loads only when a session is wanted. */
  private get manager(): SessionManager {
    this.mgr ??= new SessionManager(this.o.log);
    return this.mgr;
  }

  health(refresh = false): Promise<CockpitHostHealth> {
    return Promise.resolve({
      claude: claudeAvailability(refresh),
      cursor: cursorAvailability(refresh),
    });
  }

  ai(req: AiRunRequest): Promise<{ text: string }> {
    return req.engine === 'cursor' ? runCursorCli(req) : runClaudeCli(req);
  }

  protected cwd(ref: WsRef): Promise<string> {
    return guardWorkspace(ref.path, this.roots);
  }

  async wsValidate(ref: WsRef): Promise<WsValidation> {
    const real = await this.cwd(ref);
    const id = await wsIdentity(real);
    if (id.top !== real) {
      throw new CockpitHostError(
        'ws_not_repo_root',
        `Pick the repository root (${id.top}), not a sub-directory.`,
        422,
      );
    }
    return { realPath: real, branch: id.branch, origin: id.origin };
  }

  async wsEnsureAgentRules(ref: WsRef): Promise<void> {
    await ensureAgentRules(await this.cwd(ref));
  }

  async wsStatus(ref: WsRef): Promise<WsStatus> {
    return wsStatus(await this.cwd(ref));
  }

  async wsDiff(
    ref: WsRef,
    mode: DiffMode,
    base?: string,
  ): Promise<{ files: DiffFile[]; label: string }> {
    return wsDiff(await this.cwd(ref), ref.wsId, mode, base);
  }

  async wsTree(ref: WsRef): Promise<{ paths: string[]; truncated: boolean }> {
    return wsTree(await this.cwd(ref));
  }

  async wsReadFile(ref: WsRef, rel: string) {
    return readWsFile(await this.cwd(ref), rel);
  }

  async wsWriteFile(ref: WsRef, rel: string, content: string, expectedHash: string | null) {
    return writeWsFile(await this.cwd(ref), rel, content, expectedHash);
  }

  async wsCheckpoint(ref: WsRef): Promise<{ n: number }> {
    return { n: await checkpoint(await this.cwd(ref), ref.wsId) };
  }

  async sessionStart(ref: WsRef, opts: SessionStartOpts): Promise<CockpitSession> {
    const cwd = await this.cwd(ref);
    // Covers workspaces registered earlier and rule files deleted since; a failure must not block the session.
    await ensureAgentRules(cwd).catch((e: unknown) =>
      this.o.log.warn({ wsId: ref.wsId, err: (e as Error).message }, 'agent rules not written'),
    );
    const flutter =
      opts.kind === 'flutter'
        ? {
            flavor: chooseRunFlavor(await readRunTargets(cwd), opts.flavor),
            mode: opts.mode ?? 'debug',
            ios: opts.ios ?? false,
          }
        : undefined;
    return this.manager.start({
      cwd,
      wsId: ref.wsId,
      kind: opts.kind,
      deviceId: opts.deviceId,
      cols: opts.cols,
      rows: opts.rows,
      testRun: opts.testRun,
      postrack: opts.postrack,
      flutter,
      model: opts.model,
      execModel: opts.execModel,
      execEffort: opts.execEffort,
      execSwitch: opts.execSwitch,
    });
  }

  sessions(): Promise<CockpitSession[]> {
    return Promise.resolve(this.mgr ? this.mgr.list() : []);
  }

  sessionInput(id: string, data: string): Promise<void> {
    this.manager.input(id, data);
    return Promise.resolve();
  }

  sessionResize(id: string, cols: number, rows: number): Promise<void> {
    this.manager.resize(id, cols, rows);
    return Promise.resolve();
  }

  sessionKill(id: string): Promise<void> {
    this.manager.kill(id);
    return Promise.resolve();
  }

  sessionAttach(
    id: string,
    since: number,
    onEvent: (e: SessionEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let detach: (() => void) | null = null;
      const done = () => {
        detach?.();
        resolve();
      };
      try {
        detach = this.manager.attach(id, since, (e) => {
          onEvent(e);
          if (e.t === 'exit') queueMicrotask(done);
        });
      } catch (e) {
        reject(e as Error);
        return;
      }
      if (signal.aborted) done();
      else signal.addEventListener('abort', done, { once: true });
    });
  }

  async flutterDevices(ref: WsRef): Promise<FlutterDevice[]> {
    return flutterDevices(await this.cwd(ref));
  }

  async flutterRunTargets(ref: WsRef): Promise<RunTargets> {
    return readRunTargets(await this.cwd(ref));
  }

  async flutterLaunchEmulator(ref: WsRef, emulatorId: string): Promise<void> {
    launchEmulator(await this.cwd(ref), emulatorId);
  }

  async wsIntegrity(ref: WsRef) {
    return integrityCheck(await this.cwd(ref));
  }

  async wsLog(ref: WsRef, base: string) {
    return wsLog(await this.cwd(ref), base);
  }

  async wsSquashForMr(ref: WsRef, branch: string, base: string) {
    return squashForMr(await this.cwd(ref), branch, base);
  }

  async wsStartBranch(ref: WsRef, branch: string, base: string, existing?: ExistingBranch) {
    return startBranch(await this.cwd(ref), branch, base, existing);
  }

  async wsAddWorktree(ref: WsRef, branch: string, base: string, existing?: ExistingBranch) {
    const parent = await this.cwd(ref);
    const { path, replaced, reused } = await addWorktree(parent, branch, base, existing);
    try {
      // The worktree is a workspace of its own: the same root rule applies to it.
      return { path: await guardWorkspace(path, this.roots), replaced, reused };
    } catch (e) {
      await removeWorktree(parent, path).catch(() => undefined);
      throw e;
    }
  }

  async wsRemoveWorktree(ref: WsRef, path: string) {
    await removeWorktree(await this.cwd(ref), path);
  }

  async wsCleanTree(ref: WsRef, mode: 'stash' | 'discard') {
    return cleanTree(await this.cwd(ref), mode);
  }

  async wsCheckoutBranch(ref: WsRef, branch: string) {
    return checkoutBranch(await this.cwd(ref), branch);
  }

  async wsSaveAttachment(ref: WsRef, group: string, name: string, dataBase64: string) {
    return { path: await saveAttachment(await this.cwd(ref), group, name, dataBase64) };
  }

  async wsCleanupFacts(ref: WsRef, base: string) {
    return wsCleanupFacts(await this.cwd(ref), base);
  }

  async wsCleanupApply(ref: WsRef, base: string, items: readonly WsCleanupItem[]) {
    return wsCleanupApply(await this.cwd(ref), base, items);
  }

  tmpCleanupFacts() {
    return tmpCleanupFacts();
  }

  tmpCleanupApply(names: readonly string[]) {
    return tmpCleanupApply(names);
  }

  /** Stops whatever the host owns (PTY sessions). */
  close(): void {
    this.mgr?.close();
  }
}
