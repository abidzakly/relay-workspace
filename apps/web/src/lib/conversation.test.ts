import type { ConversationEvent } from '@relay/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_DOC, foldEvent, splitEvents } from './conversation';

const fold = (events: ConversationEvent[]) => events.reduce(foldEvent, EMPTY_DOC);

describe('foldEvent', () => {
  it('groups consecutive tools and marks their results', () => {
    const d = fold([
      { k: 'tool', id: 'a', name: 'Read', summary: 'Read a' },
      { k: 'tool', id: 'b', name: 'Bash', summary: 'Ran b' },
      { k: 'tool_done', id: 'b', ok: false, output: 'boom' },
    ]);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({
      kind: 'tools',
      tools: [
        { id: 'a', state: 'running' },
        { id: 'b', state: 'error', output: 'boom' },
      ],
    });
  });
  it('closes an ask when it is answered, keeping its place', () => {
    const d = fold([
      {
        k: 'ask',
        id: 'r',
        ask: 'plan',
        tool: 'ExitPlanMode',
        summary: 's',
        detail: null,
        plan: '# P',
        questions: [],
        canRemember: false,
      },
      { k: 'text', text: 'after' },
      { k: 'ask_done', id: 'r', outcome: 'approved' },
      { k: 'mode', mode: 'acceptEdits' },
    ]);
    expect(d.items[0]).toMatchObject({ kind: 'ask', ask: { plan: '# P', outcome: 'approved' } });
    expect(d.mode).toBe('acceptEdits');
  });
  it('only a stopped or failed turn adds a line', () => {
    expect(fold([{ k: 'turn', outcome: 'done' }]).items).toEqual([]);
    expect(fold([{ k: 'turn', outcome: 'failed', message: 'Not logged in' }]).items).toEqual([
      { kind: 'notice', level: 'error', text: 'Not logged in' },
    ]);
  });
});

describe('splitEvents', () => {
  it('keeps an unfinished line for the next chunk and drops a cut-off one', () => {
    const r = splitEvents('xx"}\n{"k":"text","text":"hi"}\n{"k":"te');
    expect(r.events).toEqual([{ k: 'text', text: 'hi' }]);
    expect(r.rest).toBe('{"k":"te');
  });
});
