import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ConversationEvent } from '@relay/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeConversation, type ConversationStatus, toolSummary } from './claudeConversation';

function setup(
  extra: { execModel?: string; execEffort?: string; execSwitch?: 'ask' | 'auto' } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 4242 });
  const sent: Record<string, unknown>[] = [];
  stdin.on('data', (d: Buffer) => {
    for (const l of d.toString().split('\n'))
      if (l) sent.push(JSON.parse(l) as Record<string, unknown>);
  });
  const conv = new ClaudeConversation({
    file: 'claude',
    args: [],
    cwd: '/w',
    env: {},
    ...extra,
    spawnChild: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  const events: ConversationEvent[] = [];
  const statuses: ConversationStatus[] = [];
  conv.onData((d) => events.push(JSON.parse(d) as ConversationEvent));
  conv.onStatus((s) => statuses.push(s));
  const feed = async (o: unknown) => {
    stdout.write(`${JSON.stringify(o)}\n`);
    await new Promise((r) => setImmediate(r));
  };
  return { conv, child, sent, events, statuses, feed };
}

const askPlan = {
  type: 'control_request',
  request_id: 'req-1',
  request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' } },
};
const askBash = {
  type: 'control_request',
  request_id: 'req-2',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'git push' },
    description: 'Push the branch',
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings' }],
  },
};
const replyTo = (sent: Record<string, unknown>[], id: string) =>
  sent
    .map(
      (m) => m.response as { request_id?: string; response?: Record<string, unknown> } | undefined,
    )
    .find((r) => r?.request_id === id)?.response;

describe('ClaudeConversation', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('never answers a permission request on its own', async () => {
    await t.feed(askBash);
    expect(replyTo(t.sent, 'req-2')).toBeUndefined();
    expect(t.events.at(-1)).toMatchObject({
      k: 'ask',
      ask: 'permission',
      summary: 'Push the branch',
      detail: 'git push',
      canRemember: true,
    });
    expect(t.statuses.at(-1)).toEqual({ working: false, waiting: true });
  });

  it('approving a plan allows file edits and reports the new mode', async () => {
    await t.feed(askPlan);
    t.conv.write(JSON.stringify({ type: 'answer', id: 'req-1', allow: true }));
    await new Promise((r) => setImmediate(r));
    expect(replyTo(t.sent, 'req-1')).toEqual({
      behavior: 'allow',
      updatedInput: { plan: '# Plan' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(t.events.slice(-2)).toEqual([
      { k: 'ask_done', id: 'req-1', outcome: 'approved' },
      { k: 'mode', mode: 'acceptEdits' },
    ]);
  });

  const switchRequests = (x: ReturnType<typeof setup>) =>
    x.sent
      .map((m) => (m.request as { subtype?: string } | undefined) ?? {})
      .filter((r) => r.subtype === 'set_model' || r.subtype === 'apply_flag_settings');
  const approve = async (x: ReturnType<typeof setup>, extra: object = {}) => {
    x.conv.write(JSON.stringify({ type: 'answer', id: 'req-1', allow: true, ...extra }));
    await new Promise((r) => setImmediate(r));
  };
  const cfg = { execModel: 'claude-sonnet-5-5', execEffort: 'medium' } as const;

  it('ask (default): the plan offers the execution model and the choice decides', async () => {
    const yes = setup(cfg);
    await yes.feed(askPlan);
    expect(yes.events.at(-1)).toMatchObject({
      ask: 'plan',
      exec: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    await approve(yes, { execModel: true });
    expect(switchRequests(yes)).toEqual([
      { subtype: 'set_model', model: 'claude-sonnet-5-5' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: 'medium' } },
    ]);
    const keep = setup(cfg);
    await keep.feed(askPlan);
    await approve(keep, { execModel: false });
    expect(switchRequests(keep)).toEqual([]);
    const none = setup(cfg);
    await none.feed(askPlan);
    await approve(none);
    expect(switchRequests(none)).toEqual([]);
  });

  it('auto: switches without asking and the plan carries no choice', async () => {
    const x = setup({ ...cfg, execSwitch: 'auto' });
    await x.feed(askPlan);
    expect(x.events.at(-1)).not.toHaveProperty('exec');
    await approve(x);
    expect(switchRequests(x)).toHaveLength(2);
  });

  it('no execution model: plain approve, no choice', async () => {
    const x = setup();
    await x.feed(askPlan);
    expect(x.events.at(-1)).not.toHaveProperty('exec');
  });

  it('keeps the planning model when the plan is revised', async () => {
    const x = setup({ execModel: 'claude-sonnet-5-5' });
    await x.feed(askPlan);
    x.conv.write(JSON.stringify({ type: 'answer', id: 'req-1', allow: false, message: 'More' }));
    await new Promise((r) => setImmediate(r));
    expect(
      x.sent.some((m) => (m.request as { subtype?: string } | undefined)?.subtype === 'set_model'),
    ).toBe(false);
  });

  it('revising a plan sends the note back as the reason', async () => {
    await t.feed(askPlan);
    t.conv.write(
      JSON.stringify({ type: 'answer', id: 'req-1', allow: false, message: 'Add tests' }),
    );
    await new Promise((r) => setImmediate(r));
    expect(replyTo(t.sent, 'req-1')).toEqual({ behavior: 'deny', message: 'Add tests' });
    expect(t.events.at(-1)).toEqual({ k: 'ask_done', id: 'req-1', outcome: 'revised' });
  });

  it('remembers a permission for the session only, never in settings files', async () => {
    await t.feed(askBash);
    t.conv.write(JSON.stringify({ type: 'answer', id: 'req-2', allow: true, remember: true }));
    await new Promise((r) => setImmediate(r));
    expect(replyTo(t.sent, 'req-2')?.updatedPermissions).toEqual([
      { type: 'addRules', behavior: 'allow', destination: 'session' },
    ]);
  });

  it('ignores input that is not a command, such as an answer to no request', async () => {
    t.conv.write('rm -rf /\r');
    t.conv.write(JSON.stringify({ type: 'answer', id: 'nope', allow: true }));
    await new Promise((r) => setImmediate(r));
    expect(t.sent).toEqual([]);
  });

  it('turns a prompt and its turn into events and status', async () => {
    t.conv.write(JSON.stringify({ type: 'prompt', text: 'hi' }));
    expect(t.statuses.at(-1)).toEqual({ working: true, waiting: false });
    await t.feed({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.dart' } },
          { type: 'tool_use', id: 't2', name: 'TodoWrite', input: {} },
          {
            type: 'tool_use',
            id: 't3',
            name: 'Write',
            input: { file_path: '/h/.claude/plans/p.md' },
          },
        ],
      },
    });
    await t.feed({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'code' }] },
    });
    await t.feed({
      type: 'assistant',
      parent_tool_use_id: 'x',
      message: { content: [{ type: 'text', text: 'sub' }] },
    });
    await t.feed({
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
    });
    expect(t.events).toEqual([
      { k: 'user', text: 'hi' },
      { k: 'text', text: 'Reading.' },
      { k: 'tool', id: 't1', name: 'Read', summary: 'Read a.dart' },
      { k: 'tool_done', id: 't1', ok: true, output: 'code' },
      { k: 'turn', outcome: 'done' },
    ]);
    expect(t.statuses.at(-1)).toEqual({ working: false, waiting: true });
  });

  it('reports an interrupted turn as stopped, and closes its open decisions', async () => {
    t.conv.write(JSON.stringify({ type: 'prompt', text: 'hi' }));
    await t.feed(askBash);
    await t.feed({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming' });
    expect(t.events.slice(-2)).toEqual([
      { k: 'ask_done', id: 'req-2', outcome: 'cancelled' },
      { k: 'turn', outcome: 'stopped' },
    ]);
  });

  it('adds the answers to a question', async () => {
    const questions = [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }];
    await t.feed({
      type: 'control_request',
      request_id: 'q',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } },
    });
    t.conv.write(
      JSON.stringify({ type: 'answer', id: 'q', allow: true, answers: { 'Which?': 'A' } }),
    );
    await new Promise((r) => setImmediate(r));
    expect(replyTo(t.sent, 'q')).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which?': 'A' } },
    });
  });
});

describe('toolSummary', () => {
  it('reads like a sentence, with paths relative to the workspace', () => {
    expect(toolSummary('Edit', { file_path: '/w/lib/a.dart' }, '/w')).toBe('Edited lib/a.dart');
    expect(toolSummary('Bash', { command: 'ls', description: 'List files' }, '/w')).toBe(
      'List files',
    );
    expect(toolSummary('Bash', { command: 'ls' }, '/w')).toBe('Ran ls');
  });
});
