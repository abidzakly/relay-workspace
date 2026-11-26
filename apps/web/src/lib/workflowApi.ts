import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BaseSuggestResult,
  CardContentPreview,
  CardStartAttachment,
  ExplainThreadChatResult,
  ExplainThreadResult,
  MrChatMessage,
  QueuedCardStart,
} from '@relay/shared';
import { del, get, post } from './api';
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

/** "Ask AI" on a reviewer's thread: checks the comment against the MR's commits and changes. */
export function useThreadExplain() {
  return useMutation<
    ExplainThreadResult,
    Error,
    { repoId: string; iid: number; discussionId: string; context?: string }
  >({ mutationFn: (b) => post('/api/cockpit/thread-explain', b) });
}

/** A follow-up in a thread's "Ask AI" chat: the server keeps nothing, so the history goes along each time. */
export function useThreadChat() {
  return useMutation<
    ExplainThreadChatResult,
    Error,
    {
      repoId: string;
      iid: number;
      discussionId: string;
      question: string;
      history: MrChatMessage[];
    }
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
      reused: boolean;
    },
    Error,
    {
      repoId: string;
      iid: number;
      discussionId: string;
      mode: ThreadAgentMode;
      agent?: 'claude' | 'cursor';
      model?: string;
      /** The thread's "Ask AI" chat so far, handed to the agent as context. */
      conversation?: MrChatMessage[];
      /** Start a fresh session even when one already works on this MR. */
      newSession?: boolean;
    }
  >({
    mutationFn: (b) => post('/api/cockpit/thread-agent', b),
    onSettled: () => void qc.invalidateQueries({ queryKey: sessionKeys.list }),
  });
}

export interface ReviseResult {
  workspaceId: string;
  sessionId: string;
  branch: string;
  attachments: number;
  failedAttachments: number;
}

/** The brief from the Make more changes / Propose changes dialog. */
export interface ReviseBrief {
  agent?: 'claude' | 'cursor';
  model?: string;
  extraPrompt?: string;
  figmaUrl?: string;
  attachments?: CardStartAttachment[];
}

/** "Make more changes" on a draft MR: a new agent session on its branch with the user's brief; the caller navigates. */
export function useMrRevise() {
  const qc = useQueryClient();
  return useMutation<ReviseResult, Error, ReviseBrief & { repoId: string; iid: number }>({
    mutationFn: (b) => post('/api/cockpit/mr-revise', b),
    onSettled: () => void qc.invalidateQueries({ queryKey: sessionKeys.list }),
  });
}

/** "Propose changes" on Create MR: the same, on a branch that has no MR yet (no branch picker). */
export function useBranchRevise() {
  const qc = useQueryClient();
  return useMutation<ReviseResult, Error, ReviseBrief & { repoId: string; branch: string }>({
    mutationFn: (b) => post('/api/cockpit/branch-revise', b),
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

const queueKey = ['cockpit', 'queue'] as const;

/** Stacked card starts waiting for their parent card's branch. Refreshed by `cockpit.changed {what: 'queue'}`. */
export function useStartQueue() {
  return useQuery({
    queryKey: queueKey,
    queryFn: async () =>
      (await get<{ items: QueuedCardStart[] }>('/api/cockpit/card-start/queue')).items,
  });
}

export function useEnqueueCardStart() {
  const qc = useQueryClient();
  return useMutation<
    QueuedCardStart,
    Error,
    {
      cardId: string;
      parentCardId: string;
      workspaceId: string;
      agent: 'claude' | 'cursor';
      extraPrompt?: string;
      figmaUrl?: string;
      attachments?: CardStartAttachment[];
    }
  >({
    mutationFn: (b) => post('/api/cockpit/card-start/queue', b),
    onSettled: () => void qc.invalidateQueries({ queryKey: queueKey }),
  });
}

export function useQueuedStartNow() {
  const qc = useQueryClient();
  return useMutation<QueuedCardStart, Error, { id: string; existing?: 'replace' | 'reuse' }>({
    mutationFn: ({ id, existing }) =>
      post(`/api/cockpit/card-start/queue/${e(id)}/start`, existing ? { existing } : {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queueKey });
      void qc.invalidateQueries({ queryKey: sessionKeys.list });
      void qc.invalidateQueries({ queryKey: ['cockpit', 'workspaces'] });
    },
  });
}

export function useCancelQueuedStart() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => del(`/api/cockpit/card-start/queue/${e(id)}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: queueKey }),
  });
}
