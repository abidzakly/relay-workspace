import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ConversationCommandSchema,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationMode,
} from '@relay/shared';
import type { NodePtyProcess } from '../ptyBackend';
import { launchSpec, signalTree } from '../../util/platform';

/**
 * A Claude session as a document instead of a terminal: `claude -p` speaking stream-json over stdio, the same control
 * protocol the Agent SDK uses. Its output is reduced to `ConversationEvent` lines, which travel the session stream
 * like terminal output does, so attach, replay and the host agent need no changes. In plan mode every tool the CLI's
 * own rules do not already allow waits for an answer from the user. Once a plan is approved, tool permissions are always
 * allowed; a question from the agent still waits.
 */

const TOOL_OUTPUT_MAX = 1_500;
const TEXT_MAX = 100_000;
const STDERR_MAX = 2_000;

/** Tools the document does not list: bookkeeping, or shown as a question or plan instead. */
const HIDDEN_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'ExitPlanMode', 'AskUserQuestion']);

type Json = Record<string, unknown>;
const rec = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A plain-language line for one tool call. Pure; exported for tests. */
export function toolSummary(name: string, input: Json, cwd: string): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const shown = path ? (path.startsWith(cwd) ? relative(cwd, path) || path : path) : null;
  switch (name) {
    case 'Read':
      return `Read ${shown ?? 'a file'}`;
    case 'Edit':
    case 'NotebookEdit':
      return `Edited ${shown ?? 'a file'}`;
    case 'Write':
      return `Wrote ${shown ?? 'a file'}`;
    case 'Bash':
      return str(input.description) ?? `Ran ${str(input.command) ?? 'a command'}`;
    case 'Grep':
    case 'Glob':
      return `Searched for ${str(input.pattern) ?? 'files'}`;
    case 'WebFetch':
      return `Opened ${str(input.url) ?? 'a page'}`;
    case 'WebSearch':
      return `Searched the web for ${str(input.query) ?? 'something'}`;
    case 'Task':
    case 'Agent':
      return str(input.description) ?? 'Ran a subagent';
    default:
      return name;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => str(rec(c).text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function questionsOf(input: Json): Extract<ConversationEvent, { k: 'ask' }>['questions'] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.map((raw) => {
    const q = rec(raw);
    const options = Array.isArray(q.options) ? q.options : [];
    return {
      question: str(q.question) ?? '',
      multiSelect: q.multiSelect === true,
      options: options.map((o) => ({
        label: str(rec(o).label) ?? '',
        description: str(rec(o).description),
      })),
    };
  });
}

/** One `can_use_tool` request as the document shows it. Pure; exported for tests. */
export function askEvent(id: string, r: Json, cwd: string): ConversationEvent {
  const tool = str(r.tool_name) ?? 'tool';
  const input = rec(r.input);
  const suggestions = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [];
  if (tool === 'ExitPlanMode') {
    return {
      k: 'ask',
      id,
      ask: 'plan',
      tool,
      summary: 'The plan is ready for your review',
      detail: null,
      plan: (str(input.plan) ?? '').slice(0, TEXT_MAX),
      questions: [],
      canRemember: false,
    };
  }
  if (tool === 'AskUserQuestion') {
    return {
      k: 'ask',
      id,
      ask: 'question',
      tool,
      summary: 'The agent has a question',
      detail: null,
      plan: null,
      questions: questionsOf(input),
      canRemember: false,
    };
  }
  return {
    k: 'ask',
    id,
    ask: 'permission',
    tool,
    summary: str(r.description) ?? str(r.title) ?? toolSummary(tool, input, cwd),
    detail:
      str(input.command) ?? str(input.file_path) ?? str(input.url) ?? str(r.blocked_path) ?? null,
    plan: null,
    questions: [],
    canRemember: suggestions.length > 0,
  };
}

export interface ConversationStatus {
  /** A turn is in flight and no decision is pending. */
  working: boolean;
  /** The user is needed: a decision is pending, or a turn just ended. */
  waiting: boolean;
}

export interface ClaudeConversationOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The model the session starts on, reported to the picker. */
  model?: string;
  /** When a plan is approved the session switches to this model (and effort): plan big, execute cheaper. */
  execModel?: string;
  execEffort?: string;
  /** `ask` (default): the user picks at Approve. `auto`: switch silently. */
  execSwitch?: 'ask' | 'auto';
  /** Tests inject a fake child. */
  spawnChild?: (
    file: string,
    args: string[],
    o: { cwd: string; env: Record<string, string> },
  ) => ChildProcessWithoutNullStreams;
}

interface PendingAsk {
  input: Json;
  suggestions: unknown[];
  ask: 'plan' | 'question' | 'permission';
}

export class ClaudeConversation implements NodePtyProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly cwd: string;
  private readonly execModel: string | undefined;
  private readonly execEffort: string | undefined;
  private readonly execSwitch: 'ask' | 'auto';
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number }) => void) | null = null;
  private statusListener: ((s: ConversationStatus) => void) | null = null;
  /** Events from before a listener attached. */
  private backlog: string[] = [];
  private turnsInFlight = 0;
  private turnEnded = false;
  private exited = false;
  /** Every session starts in plan mode: see `commandFor`. */
  private mode: ConversationMode = 'plan';
  private readonly asks = new Map<string, PendingAsk>();
  private readonly shownTools = new Set<string>();
  private stderr = '';

  constructor(o: ClaudeConversationOptions) {
    this.cwd = o.cwd;
    this.execModel = o.execModel;
    this.execEffort = o.execEffort;
    this.execSwitch = o.execSwitch ?? 'ask';
    const start =
      o.spawnChild ??
      ((file, args, opts) => {
        const l = launchSpec(file, args);
        return spawn(l.file, l.args, {
          ...opts,
          windowsVerbatimArguments: l.windowsVerbatimArguments,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      });
    this.child = start(o.file, o.args, { cwd: o.cwd, env: o.env });
    this.child.stdin.on('error', () => undefined);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_MAX);
    });
    createInterface({ input: this.child.stdout }).on('line', (l) => this.onLine(l));
    this.child.on('error', (e) => {
      this.emit({ k: 'notice', level: 'error', text: `Claude could not start: ${e.message}` });
      this.finish(1);
    });
    this.child.on('close', (code) => this.finish(code ?? 0));
    if (o.model) this.emit({ k: 'model', model: o.model });
  }

  get pid(): number {
    return this.child.pid ?? 0;
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

  /** The session's input: one `ConversationCommand` as JSON. Anything else is ignored, it cannot reach the agent. */
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

  kill(): void {
    if (this.exited || !this.child.pid) return;
    signalTree(this.child.pid, 'SIGTERM', () => this.child.kill('SIGTERM'));
  }

  private send(o: Json): void {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(o)}\n`);
  }

  private control(request: Json): void {
    this.send({ type: 'control_request', request_id: randomUUID(), request });
  }

  private emit(e: ConversationEvent): void {
    const line = `${JSON.stringify(e)}\n`;
    if (this.dataListener) this.dataListener(line);
    else this.backlog.push(line);
  }

  private status(): void {
    const needsUser = this.asks.size > 0;
    this.statusListener?.({
      working: this.turnsInFlight > 0 && !needsUser,
      waiting: needsUser || (this.turnEnded && this.turnsInFlight === 0),
    });
  }

  private run(cmd: ConversationCommand): void {
    switch (cmd.type) {
      case 'prompt':
        this.emit({ k: 'user', text: cmd.text });
        this.turnsInFlight++;
        this.turnEnded = false;
        this.send({ type: 'user', message: { role: 'user', content: cmd.text } });
        break;
      case 'answer':
        this.answer(cmd);
        break;
      case 'interrupt':
        this.control({ subtype: 'interrupt' });
        break;
      case 'mode':
        this.mode = cmd.mode;
        this.control({ subtype: 'set_permission_mode', mode: cmd.mode });
        this.emit({ k: 'mode', mode: cmd.mode });
        break;
      case 'model':
        this.control({ subtype: 'set_model', model: cmd.model });
        this.emit({ k: 'model', model: cmd.model });
        break;
    }
    this.status();
  }

  private answer(cmd: Extract<ConversationCommand, { type: 'answer' }>): void {
    const pending = this.asks.get(cmd.id);
    if (!pending) return;
    this.asks.delete(cmd.id);
    const reply = (response: Json) =>
      this.send({
        type: 'control_response',
        response: { subtype: 'success', request_id: cmd.id, response },
      });
    if (!cmd.allow) {
      const note = cmd.message?.trim();
      const rejected = pending.ask === 'plan' && !note;
      reply({
        behavior: 'deny',
        message:
          note ||
          (rejected
            ? 'The user rejected this plan. Do not carry it out. Wait for further instructions.'
            : 'The user declined this.'),
      });
      this.emit({
        k: 'ask_done',
        id: cmd.id,
        outcome: rejected ? 'rejected' : pending.ask === 'plan' ? 'revised' : 'denied',
      });
      return;
    }
    const updatedInput =
      pending.ask === 'question' ? { ...pending.input, answers: cmd.answers ?? {} } : pending.input;
    const updatedPermissions: unknown[] = [];
    let mode: ConversationMode | null = null;
    if (pending.ask === 'plan') {
      // Leaves plan mode. `acceptEdits` is the CLI's name; every other tool is allowed in `onControlRequest`.
      mode = 'acceptEdits';
      updatedPermissions.push({ type: 'setMode', mode, destination: 'session' });
    } else if (cmd.remember) {
      // Remembered for this session only: never written to the repo's or the user's settings.
      for (const s of pending.suggestions)
        updatedPermissions.push({ ...rec(s), destination: 'session' });
    }
    reply({
      behavior: 'allow',
      updatedInput,
      ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
    });
    this.emit({
      k: 'ask_done',
      id: cmd.id,
      outcome:
        pending.ask === 'plan' ? 'approved' : pending.ask === 'question' ? 'answered' : 'allowed',
    });
    if (mode) {
      this.mode = mode;
      this.emit({ k: 'mode', mode });
      if (this.execSwitch === 'auto' || cmd.execModel === true) this.switchToExec();
      else if (this.execModel) {
        this.emit({
          k: 'notice',
          level: 'info',
          text: 'Plan approved: staying on the planning model.',
        });
      }
    }
  }

  /** The plan was approved: execute on the cheaper model. The picker in the session can still change it. */
  private switchToExec(): void {
    if (!this.execModel) return;
    this.control({ subtype: 'set_model', model: this.execModel });
    this.emit({ k: 'model', model: this.execModel });
    if (this.execEffort) {
      this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: this.execEffort } });
    }
    this.emit({
      k: 'notice',
      level: 'info',
      text: `Plan approved: executing on ${this.execModel}${this.execEffort ? ` (${this.execEffort} effort)` : ''}.`,
    });
  }

  private onLine(line: string): void {
    let e: Json;
    try {
      e = rec(JSON.parse(line));
    } catch {
      return;
    }
    switch (e.type) {
      case 'assistant':
        if (!e.parent_tool_use_id) this.onAssistant(rec(e.message));
        break;
      case 'user':
        if (!e.parent_tool_use_id) this.onToolResults(rec(e.message));
        break;
      case 'control_request':
        this.onControlRequest(e);
        break;
      case 'control_cancel_request':
        this.cancelAsk(str(e.request_id));
        break;
      case 'control_response':
        this.onControlResponse(rec(e.response));
        break;
      case 'result':
        this.onResult(e);
        break;
    }
  }

  private onAssistant(message: Json): void {
    if (!Array.isArray(message.content)) return;
    for (const raw of message.content) {
      const c = rec(raw);
      if (c.type === 'text') {
        const text = str(c.text);
        if (text) this.emit({ k: 'text', text: text.slice(0, TEXT_MAX) });
      } else if (c.type === 'tool_use') {
        const id = str(c.id);
        const name = str(c.name) ?? 'tool';
        const input = rec(c.input);
        if (!id || HIDDEN_TOOLS.has(name) || this.isPlanFile(name, input)) continue;
        this.shownTools.add(id);
        this.emit({ k: 'tool', id, name, summary: toolSummary(name, input, this.cwd) });
      }
    }
  }

  /** Plan mode drafts its plan in `~/.claude/plans`; the document shows the plan itself when it is ready. */
  private isPlanFile(name: string, input: Json): boolean {
    return (
      (name === 'Write' || name === 'Edit') &&
      (str(input.file_path)?.includes('/.claude/plans/') ?? false)
    );
  }

  private onToolResults(message: Json): void {
    if (!Array.isArray(message.content)) return;
    for (const raw of message.content) {
      const c = rec(raw);
      const id = str(c.tool_use_id);
      if (c.type !== 'tool_result' || !id || !this.shownTools.delete(id)) continue;
      const ok = c.is_error !== true;
      const output = resultText(c.content).slice(0, TOOL_OUTPUT_MAX);
      this.emit({ k: 'tool_done', id, ok, ...(output ? { output } : {}) });
    }
  }

  private onControlRequest(e: Json): void {
    const id = str(e.request_id);
    const r = rec(e.request);
    if (!id) return;
    if (r.subtype !== 'can_use_tool') {
      // Nothing else is implemented here: refuse, so the CLI does not wait forever.
      this.send({
        type: 'control_response',
        response: { subtype: 'error', request_id: id, error: 'Not supported' },
      });
      return;
    }
    const ev = askEvent(id, r, this.cwd);
    if (ev.k !== 'ask') return;
    if (ev.ask === 'plan' && this.execModel && this.execSwitch === 'ask') {
      ev.exec = { model: this.execModel, effort: this.execEffort ?? null };
    }
    if (ev.ask === 'permission' && this.mode !== 'plan') {
      // Past the plan the user does not want to approve each action. The tool still shows in the document.
      this.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: { behavior: 'allow', updatedInput: rec(r.input) },
        },
      });
      return;
    }
    this.asks.set(id, {
      input: rec(r.input),
      suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
      ask: ev.ask,
    });
    this.emit(ev);
    this.status();
  }

  private cancelAsk(id: string | null): void {
    if (!id || !this.asks.delete(id)) return;
    this.emit({ k: 'ask_done', id, outcome: 'cancelled' });
    this.status();
  }

  private onControlResponse(r: Json): void {
    if (r.subtype === 'error') {
      this.emit({
        k: 'notice',
        level: 'error',
        text: `Claude refused that change: ${str(r.error) ?? 'unknown error'}`,
      });
    }
  }

  private onResult(e: Json): void {
    for (const id of [...this.asks.keys()]) this.cancelAsk(id);
    this.turnsInFlight = Math.max(0, this.turnsInFlight - 1);
    this.turnEnded = true;
    const stopped = str(e.terminal_reason)?.startsWith('aborted') ?? false;
    if (stopped) this.emit({ k: 'turn', outcome: 'stopped' });
    else if (e.is_error === true) {
      const message = str(e.result) ?? (Array.isArray(e.errors) ? str(e.errors[0]) : null);
      this.emit({ k: 'turn', outcome: 'failed', ...(message ? { message } : {}) });
    } else this.emit({ k: 'turn', outcome: 'done' });
    this.status();
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    if (code !== 0 && this.turnsInFlight > 0 && this.stderr.trim()) {
      this.emit({ k: 'notice', level: 'error', text: this.stderr.trim() });
    }
    for (const id of [...this.asks.keys()]) this.cancelAsk(id);
    this.exitListener?.({ exitCode: code });
  }
}
