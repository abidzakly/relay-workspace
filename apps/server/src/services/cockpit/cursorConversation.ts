import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  ConversationCommandSchema,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationMode,
} from '@relay/shared';
import type { NodePtyProcess } from '../ptyBackend';
import { launchSpec, signalTree } from '../../util/platform';
import { toolSummary, type ConversationStatus } from './claudeConversation';

/**
 * A Cursor session as a document, like `ClaudeConversation`. `cursor-agent` has no stdin protocol, so every turn is one
 * `cursor-agent -p --output-format stream-json` run that resumes the same chat (`--resume <chatId>`). Its events are
 * reduced to `ConversationEvent` lines on the session stream, so attach, replay and the host agent need no changes.
 *
 * Approval: a plan turn runs with `--mode plan` and ends with Cursor's `createPlan` tool; that plan becomes an `ask`
 * the user approves or revises. Headless Cursor approves its own `switchMode` out of plan mode, so a plan turn that
 * tries to leave plan mode is stopped on the spot. After approval the turns run with `--force` (edits and commands
 * without asking), as the user chose.
 */

const TOOL_OUTPUT_MAX = 1_500;
const TEXT_MAX = 100_000;
const STDERR_MAX = 2_000;
/** Text deltas are batched this long: one event per token would flood the ring buffer. */
const DELTA_FLUSH_MS = 120;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Cursor's tool keys under the names the document already knows (`toolSummary`). Null = not shown. */
const TOOL_NAMES: Record<string, string | null> = {
  readToolCall: 'Read',
  editToolCall: 'Edit',
  writeToolCall: 'Write',
  deleteToolCall: 'Delete',
  shellToolCall: 'Bash',
  globToolCall: 'Glob',
  grepToolCall: 'Grep',
  lsToolCall: 'List',
  webSearchToolCall: 'WebSearch',
  webFetchToolCall: 'WebFetch',
  mcpToolCall: 'MCP',
  createPlanToolCall: null,
  switchModeToolCall: null,
  updateTodosToolCall: null,
  todoToolCall: null,
  // How Cursor finds its SwitchMode tool after approval: bookkeeping.
  getMcpToolsToolCall: null,
};

/** One Cursor tool call as `{name, summary}` for the document, or null when it is not shown. Pure; exported for tests. */
export function cursorTool(
  call: Json,
  cwd: string,
): { key: string; name: string; summary: string } | null {
  const key = Object.keys(call).find((k) => k.endsWith('ToolCall'));
  if (!key) return null;
  const mapped = key in TOOL_NAMES ? TOOL_NAMES[key] : key.replace(/ToolCall$/, '');
  if (mapped === null || mapped === undefined) return null;
  const args = rec(rec(call[key]).args);
  const input: Json = {
    path: args.path ?? args.targetDirectory,
    command: args.command,
    pattern: args.globPattern ?? args.pattern ?? args.query,
    url: args.url,
    query: args.searchTerm ?? args.query,
  };
  let summary: string;
  switch (mapped) {
    case 'Delete':
      summary = `Deleted ${str(input.path) ?? 'a file'}`;
      break;
    case 'List':
      summary = `Listed ${str(input.path) ?? 'a folder'}`;
      break;
    case 'MCP':
      summary = `Used ${str(args.toolName) ?? str(args.name) ?? 'an MCP tool'}`;
      break;
    default:
      summary = toolSummary(mapped, input, cwd);
  }
  return { key, name: mapped, summary };
}

/** A tool call's outcome: ok, plus a short output for the expanded row. */
function toolResult(call: Json, key: string): { ok: boolean; output: string } {
  const result = rec(rec(call[key]).result);
  const err = rec(result.error);
  if (Object.keys(err).length > 0 || result.rejected) {
    const msg = str(err.modelVisibleError) ?? str(err.error) ?? str(err.message) ?? 'Failed';
    return { ok: false, output: msg };
  }
  const ok = rec(result.success);
  const output =
    [str(ok.stdout), str(ok.stderr)].filter(Boolean).join('\n') ||
    str(ok.content) ||
    str(ok.diffString) ||
    '';
  const exit = typeof ok.exitCode === 'number' ? ok.exitCode : 0;
  return { ok: exit === 0, output };
}

export interface CursorConversationOptions {
  file: string;
  /** Per-turn arguments besides print/stream/mode/resume, e.g. `--model x`, `--approve-mcps`. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
  model?: string;
  /** `plan` (default): the first turns plan, nothing is edited until a plan is approved. */
  startMode?: ConversationMode;
  /** Pass `--force` once out of plan mode (the user's choice for sessions; a device test does without). */
  forceAfterPlan?: boolean;
  /** Tests inject a fake child. */
  spawnChild?: (
    file: string,
    args: string[],
    o: { cwd: string; env: Record<string, string> },
  ) => ChildProcessWithoutNullStreams;
}

export class CursorConversation implements NodePtyProcess {
  private readonly o: CursorConversationOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number }) => void) | null = null;
  private statusListener: ((s: ConversationStatus) => void) | null = null;
  private backlog: string[] = [];
  private mode: ConversationMode;
  private chatId: string | null = null;
  /** Prompts sent while a turn runs; they run in order. */
  private readonly queue: { text: string; mode: ConversationMode }[] = [];
  private turnEnded = false;
  private exited = false;
  /** The plan waiting for the user, by ask id. */
  private pendingPlan: string | null = null;
  private plans = 0;
  // Per turn:
  private turnMode: ConversationMode = 'plan';
  private planText: string | null = null;
  private sawDeltas = false;
  private delta = '';
  private deltaTimer: NodeJS.Timeout | null = null;
  private readonly shownTools = new Map<string, string>();
  private gotResult = false;
  private stopReason: 'user' | 'plan_escape' | null = null;
  private stderr = '';

  constructor(o: CursorConversationOptions) {
    this.o = o;
    this.mode = o.startMode ?? 'plan';
    if (o.model) this.emit({ k: 'model', model: o.model });
    this.emit({ k: 'mode', mode: this.mode });
  }

  /** The running turn's process, else this server's: a session with no turn in flight has no process of its own. */
  get pid(): number {
    return this.child?.pid ?? process.pid;
  }

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
    for (const line of this.backlog) listener(line);
    this.backlog = [];
  }

  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }

  onStatus(listener: (s: ConversationStatus) => void): void {
    this.statusListener = listener;
  }

  /** The session's input: one `ConversationCommand` as JSON. Anything else is ignored. */
  write(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const cmd = ConversationCommandSchema.safeParse(parsed);
    if (cmd.success) this.run(cmd.data);
  }

  /** Ends the session: stops a running turn and reports the exit. */
  kill(): void {
    if (this.exited) return;
    this.queue.length = 0;
    this.stopTurn('user');
    this.finish(0);
  }

  private emit(e: ConversationEvent): void {
    if (e.k !== 'text_delta') this.flushDelta();
    const line = `${JSON.stringify(e)}\n`;
    if (this.dataListener) this.dataListener(line);
    else this.backlog.push(line);
  }

  private flushDelta(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (!this.delta) return;
    const text = this.delta;
    this.delta = '';
    this.emit({ k: 'text_delta', text });
  }

  private status(): void {
    const needsUser = this.pendingPlan !== null;
    const working = this.child !== null || this.queue.length > 0;
    this.statusListener?.({
      working: working && !needsUser,
      waiting: needsUser || (this.turnEnded && !working),
    });
  }

  private run(cmd: ConversationCommand): void {
    switch (cmd.type) {
      case 'prompt':
        this.emit({ k: 'user', text: cmd.text });
        // A new message while a plan waits is feedback on it.
        if (this.pendingPlan) {
          this.emit({ k: 'ask_done', id: this.pendingPlan, outcome: 'revised' });
          this.pendingPlan = null;
        }
        this.enqueue(cmd.text, this.mode);
        break;
      case 'answer':
        this.answer(cmd);
        break;
      case 'interrupt':
        this.queue.length = 0;
        this.stopTurn('user');
        break;
      case 'mode':
        this.mode = cmd.mode;
        this.emit({ k: 'mode', mode: cmd.mode });
        break;
      case 'model':
        this.emit({
          k: 'notice',
          level: 'info',
          text: 'Cursor keeps the model it started on: start a new session to change it.',
        });
        break;
    }
    this.status();
  }

  private answer(cmd: Extract<ConversationCommand, { type: 'answer' }>): void {
    if (cmd.id !== this.pendingPlan) return;
    this.pendingPlan = null;
    if (cmd.allow) {
      this.emit({ k: 'ask_done', id: cmd.id, outcome: 'approved' });
      this.mode = 'acceptEdits';
      this.emit({ k: 'mode', mode: this.mode });
      this.enqueue(
        'The user approved your plan. First call SwitchMode to switch to agent mode (plan mode cannot edit), then carry the plan out.',
        this.mode,
      );
      return;
    }
    const note = cmd.message?.trim();
    if (!note) {
      this.emit({ k: 'ask_done', id: cmd.id, outcome: 'rejected' });
      return;
    }
    this.emit({ k: 'ask_done', id: cmd.id, outcome: 'revised' });
    this.enqueue(`The user wants changes to the plan before approving it:\n\n${note}`, 'plan');
  }

  private enqueue(text: string, mode: ConversationMode): void {
    this.queue.push({ text, mode });
    this.next();
  }

  private next(): void {
    if (this.child || this.exited) return;
    const turn = this.queue.shift();
    if (!turn) return;
    this.startTurn(turn.text, turn.mode);
  }

  private startTurn(text: string, mode: ConversationMode): void {
    this.turnMode = mode;
    this.turnEnded = false;
    this.planText = null;
    this.sawDeltas = false;
    this.gotResult = false;
    this.stopReason = null;
    this.stderr = '';
    this.shownTools.clear();
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      ...this.o.args,
      ...(mode === 'plan' ? ['--mode', 'plan'] : this.o.forceAfterPlan ? ['--force'] : []),
      ...(this.chatId ? ['--resume', this.chatId] : []),
    ];
    const start =
      this.o.spawnChild ??
      ((file, a, opts) => {
        const l = launchSpec(file, a);
        return spawn(l.file, l.args, {
          ...opts,
          windowsVerbatimArguments: l.windowsVerbatimArguments,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = start(this.o.file, args, { cwd: this.o.cwd, env: this.o.env });
    } catch (e) {
      this.emit({
        k: 'notice',
        level: 'error',
        text: `Cursor could not start: ${(e as Error).message}`,
      });
      this.endTurn();
      return;
    }
    this.child = child;
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_MAX);
    });
    createInterface({ input: child.stdout }).on('line', (l) => {
      if (this.child === child) this.onLine(l);
    });
    child.on('error', (e) => {
      if (this.child !== child) return;
      this.emit({ k: 'notice', level: 'error', text: `Cursor could not start: ${e.message}` });
    });
    child.on('close', (code) => {
      if (this.child === child) this.onTurnExit(code ?? 0);
    });
    child.stdin.end(text);
    this.status();
  }

  private stopTurn(reason: 'user' | 'plan_escape'): void {
    const child = this.child;
    if (!child?.pid) return;
    this.stopReason = reason;
    signalTree(child.pid, 'SIGTERM', () => child.kill('SIGTERM'));
  }

  private onLine(line: string): void {
    let e: Json;
    try {
      e = rec(JSON.parse(line));
    } catch {
      return;
    }
    switch (e.type) {
      case 'system':
        this.chatId ??= str(e.session_id);
        break;
      case 'assistant':
        this.onAssistant(e);
        break;
      case 'tool_call':
        this.onToolCall(e);
        break;
      case 'result':
        this.onResult(e);
        break;
    }
  }

  private onAssistant(e: Json): void {
    const content = rec(e.message).content;
    if (!Array.isArray(content)) return;
    const text = content
      .map((c) => (rec(c).type === 'text' ? (str(rec(c).text) ?? '') : ''))
      .join('');
    if (!text) return;
    // With partial output, deltas carry a timestamp; the closing message repeats the whole text and is skipped.
    if (typeof e.timestamp_ms === 'number') {
      this.sawDeltas = true;
      this.delta += text;
      this.deltaTimer ??= setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
    } else if (!this.sawDeltas) {
      this.emit({ k: 'text', text: text.slice(0, TEXT_MAX) });
    } else {
      // The next message of the turn streams as a new block.
      this.flushDelta();
      this.sawDeltas = false;
    }
  }

  private onToolCall(e: Json): void {
    const id = str(e.call_id);
    const call = rec(e.tool_call);
    if (!id) return;
    if (e.subtype === 'started') {
      if (this.turnMode === 'plan' && 'switchModeToolCall' in call) {
        // Headless, Cursor would approve this itself and start editing: only the user leaves plan mode.
        this.stopTurn('plan_escape');
        return;
      }
      const t = cursorTool(call, this.o.cwd);
      if (!t) return;
      this.shownTools.set(id, t.key);
      this.emit({ k: 'tool', id, name: t.name, summary: t.summary });
      return;
    }
    if (e.subtype !== 'completed') return;
    if ('createPlanToolCall' in call) {
      const plan = str(rec(rec(call.createPlanToolCall).args).plan);
      if (plan) this.planText = plan.slice(0, TEXT_MAX);
      return;
    }
    const key = this.shownTools.get(id);
    if (!key) return;
    this.shownTools.delete(id);
    const r = toolResult(call, key);
    this.emit({
      k: 'tool_done',
      id,
      ok: r.ok,
      ...(r.output ? { output: r.output.slice(0, TOOL_OUTPUT_MAX) } : {}),
    });
  }

  private onResult(e: Json): void {
    this.gotResult = true;
    if (e.is_error === true) {
      const message = str(e.result);
      this.emit({ k: 'turn', outcome: 'failed', ...(message ? { message } : {}) });
    } else this.emit({ k: 'turn', outcome: 'done' });
    if (this.turnMode === 'plan' && this.planText) {
      const id = `cursor-plan-${++this.plans}`;
      this.pendingPlan = id;
      this.emit({
        k: 'ask',
        id,
        ask: 'plan',
        tool: 'createPlan',
        summary: 'The plan is ready for your review',
        detail: null,
        plan: this.planText,
        questions: [],
        canRemember: false,
      });
    }
  }

  private onTurnExit(code: number): void {
    if (this.exited) {
      this.child = null;
      return;
    }
    this.flushDelta();
    // Tools still open when the process ended did not finish.
    for (const id of this.shownTools.keys()) this.emit({ k: 'tool_done', id, ok: false });
    this.shownTools.clear();
    if (this.stopReason === 'plan_escape') {
      this.emit({
        k: 'notice',
        level: 'error',
        text: 'Cursor tried to leave plan mode before you approved a plan, so the turn was stopped. Ask it for a plan, or switch the session out of plan mode.',
      });
      this.emit({ k: 'turn', outcome: 'stopped' });
    } else if (this.stopReason === 'user') {
      this.emit({ k: 'turn', outcome: 'stopped' });
    } else if (!this.gotResult) {
      const message = this.stderr.trim() || `cursor-agent exited with ${code}`;
      this.emit({ k: 'turn', outcome: 'failed', message });
    }
    this.endTurn();
  }

  private endTurn(): void {
    this.child = null;
    this.turnEnded = true;
    if (this.exited) return;
    this.next();
    this.status();
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.flushDelta();
    if (this.pendingPlan) {
      this.emit({ k: 'ask_done', id: this.pendingPlan, outcome: 'cancelled' });
      this.pendingPlan = null;
    }
    this.exitListener?.({ exitCode: code });
  }
}
