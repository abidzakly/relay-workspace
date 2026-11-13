import { useEffect, useReducer } from 'react';
import type { ConversationEvent, ConversationMode } from '@relay/shared';

/**
 * An agent session (Claude or Cursor) as a document. The session stream carries one `ConversationEvent` JSON per line; this folds them
 * into what the page shows. The fold is pure, so a replay after a reconnect ends up in the same place.
 */

export interface DocTool {
  id: string;
  name: string;
  summary: string;
  state: 'running' | 'ok' | 'error';
  output: string | null;
}

export type DocAsk = Extract<ConversationEvent, { k: 'ask' }> & {
  outcome: Extract<ConversationEvent, { k: 'ask_done' }>['outcome'] | null;
};

export type DocItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: DocTool[] }
  | { kind: 'ask'; ask: DocAsk }
  | { kind: 'notice'; level: 'info' | 'error'; text: string };

export interface ConversationDoc {
  items: DocItem[];
  mode: ConversationMode;
  /** The model the session runs on; null until the server reports one. */
  model: string | null;
}

export const EMPTY_DOC: ConversationDoc = { items: [], mode: 'plan', model: null };

function replaceTool(items: DocItem[], id: string, patch: (t: DocTool) => DocTool): DocItem[] {
  return items.map((it) =>
    it.kind === 'tools' && it.tools.some((t) => t.id === id)
      ? { ...it, tools: it.tools.map((t) => (t.id === id ? patch(t) : t)) }
      : it,
  );
}

const TURN_NOTICE = { stopped: 'Stopped.', failed: 'The agent stopped because of an error.' };

export function foldEvent(doc: ConversationDoc, e: ConversationEvent): ConversationDoc {
  const { items } = doc;
  switch (e.k) {
    case 'user':
      return { ...doc, items: [...items, { kind: 'user', text: e.text }] };
    case 'text':
      return { ...doc, items: [...items, { kind: 'text', text: e.text }] };
    case 'text_delta': {
      const last = items.at(-1);
      return last?.kind === 'text'
        ? { ...doc, items: [...items.slice(0, -1), { kind: 'text', text: last.text + e.text }] }
        : { ...doc, items: [...items, { kind: 'text', text: e.text }] };
    }
    case 'tool': {
      const tool: DocTool = {
        id: e.id,
        name: e.name,
        summary: e.summary,
        state: 'running',
        output: null,
      };
      const last = items.at(-1);
      // Consecutive tool calls are one quiet line, not a wall of rows.
      return last?.kind === 'tools'
        ? {
            ...doc,
            items: [...items.slice(0, -1), { kind: 'tools', tools: [...last.tools, tool] }],
          }
        : { ...doc, items: [...items, { kind: 'tools', tools: [tool] }] };
    }
    case 'tool_done':
      return {
        ...doc,
        items: replaceTool(items, e.id, (t) => ({
          ...t,
          state: e.ok ? 'ok' : 'error',
          output: e.output ?? null,
        })),
      };
    case 'ask':
      return { ...doc, items: [...items, { kind: 'ask', ask: { ...e, outcome: null } }] };
    case 'ask_done':
      return {
        ...doc,
        items: items.map((it) =>
          it.kind === 'ask' && it.ask.id === e.id
            ? { ...it, ask: { ...it.ask, outcome: e.outcome } }
            : it,
        ),
      };
    case 'turn':
      if (e.outcome === 'done') return doc;
      return {
        ...doc,
        items: [
          ...items,
          {
            kind: 'notice',
            level: e.outcome === 'failed' ? 'error' : 'info',
            text: e.message ?? TURN_NOTICE[e.outcome],
          },
        ],
      };
    case 'notice':
      return { ...doc, items: [...items, { kind: 'notice', level: e.level, text: e.text }] };
    case 'mode':
      return { ...doc, mode: e.mode };
    case 'model':
      return { ...doc, model: e.model };
  }
}

/** Splits stream text into events; what follows the last newline waits for the next chunk. Exported for tests. */
export function splitEvents(buffer: string): { events: ConversationEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: ConversationEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as ConversationEvent);
    } catch {
      /* the cut-off first line of a replay */
    }
  }
  return { events, rest };
}

type Action = { t: 'events'; events: ConversationEvent[] } | { t: 'reset' };

function reduce(doc: ConversationDoc, a: Action): ConversationDoc {
  if (a.t === 'events') return a.events.reduce(foldEvent, doc);
  return {
    ...EMPTY_DOC,
    items: [
      {
        kind: 'notice',
        level: 'info',
        text: 'The earliest part of this session is no longer available.',
      },
    ],
  };
}

/** Follows a session's stream from the start; after a dropped connection it resumes from the last offset. */
export function useConversation(sessionId: string): ConversationDoc {
  const [doc, dispatch] = useReducer(reduce, EMPTY_DOC);
  useEffect(() => {
    let offset = 0;
    let buffer = '';
    let ended = false;
    let source: EventSource | null = null;
    const connect = () => {
      source?.close();
      source = new EventSource(
        `/api/cockpit/sessions/${encodeURIComponent(sessionId)}/stream?since=${offset}`,
      );
      source.addEventListener('out', (ev) => {
        const m = JSON.parse((ev as MessageEvent<string>).data) as { data: string; offset: number };
        const data = m.data.slice(Math.max(0, offset - m.offset));
        offset = Math.max(offset, m.offset + m.data.length);
        const { events, rest } = splitEvents(buffer + data);
        buffer = rest;
        if (events.length > 0) dispatch({ t: 'events', events });
      });
      source.addEventListener('reset', (ev) => {
        offset = (JSON.parse((ev as MessageEvent<string>).data) as { offset: number }).offset;
        buffer = '';
        dispatch({ t: 'reset' });
      });
      source.addEventListener('exit', () => {
        ended = true;
        source?.close();
      });
      source.onerror = () => {
        if (!ended && source?.readyState === EventSource.CLOSED) setTimeout(connect, 1_500);
      };
    };
    connect();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ended) connect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      ended = true;
      source?.close();
    };
  }, [sessionId]);
  return doc;
}
