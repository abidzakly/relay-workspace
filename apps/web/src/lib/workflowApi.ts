import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BaseSuggestResult,
  CardContentPreview,
  CardStartAttachment,
  ExplainThreadResult,
} from '@relay/shared';
import { get, post } from './api';
import { sessionKeys } from './sessionApi';

/** Cockpit: attention inbox, integrity gate, card start; agent sessions from reviewer threads. */
export interface AttentionItem {
  kind: 'agent_waiting' | 'turn_review' | 'ready_for_mr' | 'saved_note';
  title: string;
  detail: string;
  to: string;
  at: number;
}
export interface IntegrityStep {
  name: string;
  ok: boolean;
  tail: string;
  durationMs: number;
}
const e = encodeURIComponent;

export function useAttention() {
  return useQuery({
    queryKey: ['cockpit', 'sessions', 'attention'],
    queryFn: async () => (await get<{ items: AttentionItem[] }>('/api/cockpit/attention')).items,
    refetchInterval: 30_000,
  });
}

export function useIntegrity(ws: string) {
  return useMutation<{ ok: boolean; steps: IntegrityStep[] }, Error, void>({
    mutationFn: () => post(`/api/cockpit/ws/${e(ws)}/integrity`, {}),
  });
}

/** What Start with agent reads from the Notion card (whole body + parent), for the dialog preview. */
export function useCardContent(cardId: string | null) {
  return useQuery({
    queryKey: ['cockpit', 'card-content', cardId ?? ''],
    queryFn: ({ signal }) =>
      get<CardContentPreview>(`/api/cockpit/card-content/${e(cardId!)}`, { signal }),
    enabled: !!cardId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useBases(ws: string | null) {
  return useQuery({
    queryKey: ['cockpit', 'workspaces', ws ?? '', 'bases'],
    queryFn: async () =>
      (await get<{ items: { name: string; label: string }[] }>(`/api/cockpit/ws/${e(ws!)}/bases`))
        .items,
    enabled: !!ws,
  });
}

export function useBaseSuggest() {
  return useMutation<BaseSuggestResult, Error, { cardId: string; workspaceId: string }>({
    mutationFn: (b) => post('/api/cockpit/base-suggest', b),
  });
}

/** "Explain with AI" on a reviewer's thread: checks the comment against the MR's commits and changes. */
export function useThreadExplain() {
  return useMutation<
    ExplainThreadResult,
    Error,
    { repoId: string; iid: number; discussionId: string; context?: string }
  >({ mutationFn: (b) => post('/api/cockpit/thread-explain', b) });
}

export type ThreadAgentMode = 'review' | 'fix';

/** Starts an agent session on a reviewer's thread; the caller then navigates to it. */
export function useThreadAgent() {
  const qc = useQueryClient();
  return useMutation<
    {
      workspaceId: string;
      sessionId: string;
      branch: string;
      attachments: number;
      failedAttachments: number;
    },
    Error,
    {
      repoId: string;
      iid: number;
      discussionId: string;
      mode: ThreadAgentMode;
      agent?: 'claude' | 'cursor';
      model?: string;
    }
  >({
    mutationFn: (b) => post('/api/cockpit/thread-agent', b),
    onSettled: () => void qc.invalidateQueries({ queryKey: sessionKeys.list }),
  });
}

export function useCardStart() {
  const qc = useQueryClient();
  return useMutation<
    { branch: string; sessionId: string | null; workspaceId: string; worktree: boolean },
    Error,
    {
      cardId: string;
      workspaceId: string;
      base: string;
      agent: 'claude' | 'cursor' | null;
      replace?: boolean;
      /** The card's branch already exists: `replace` resets it to the base, `reuse` checks it out as it is. */
      existing?: 'replace' | 'reuse';
      /** Bulk start: a busy workspace gives the card its own git worktree. */
      worktree?: 'auto';
      extraPrompt?: string;
      figmaUrl?: string;
      attachments?: CardStartAttachment[];
    }
  >({
    mutationFn: (b) => post('/api/cockpit/card-start', b),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.list });
      // A worktree start adds a workspace.
      void qc.invalidateQueries({ queryKey: ['cockpit', 'workspaces'] });
    },
  });
}
