import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deckSourceKey,
  type DeckExplainRequest,
  type DeckExplainResult,
  type DeckGradeResult,
  type DeckPayload,
  type DeckRequestChangeResult,
  type DeckSource,
  type DeckState,
  type DeckStatePatch,
  type DeckStatus,
  type DeckSummary,
} from '@relay/shared';
import { get, post, put } from './api';

/** Review Deck API. Opening is a POST (it may run AI triage), cached per source. */

export const deckKeys = {
  open: (s: DeckSource) => ['deck', deckSourceKey(s)] as const,
  /** Under `cockpit/ready`: SSE `cockpit.changed {what:'ready'}` means a branch moved, so a push refreshes it. */
  status: (deckId: string) => ['cockpit', 'ready', 'deck-status', deckId] as const,
};

export function useDeck(source: DeckSource | null) {
  return useQuery({
    queryKey: source ? deckKeys.open(source) : ['deck', 'none'],
    queryFn: () => post<DeckPayload>('/api/deck/open', { source }),
    enabled: source !== null,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

/** Throws away the stored deck (cards, progress, notes) and builds it again; the result replaces the cached deck. */
export function useRebuildDeck(source: DeckSource | null) {
  const qc = useQueryClient();
  return useMutation<DeckPayload, Error, void>({
    mutationFn: () => post('/api/deck/open', { source, rebuild: true }),
    onSuccess: (data) => {
      if (source) qc.setQueryData(deckKeys.open(source), data);
      void qc.invalidateQueries({ queryKey: deckKeys.status(data.deckId) });
    },
  });
}

export const saveDeckState = (deckId: string, diffSha: string, patch: DeckStatePatch) =>
  put<DeckState>(`/api/deck/${deckId}/state`, { ...patch, diffSha });

export function useExplain(deckId: string) {
  return useMutation<DeckExplainResult, Error, DeckExplainRequest>({
    mutationFn: (b) => post(`/api/deck/${deckId}/explain`, b),
  });
}

export function useGrade(deckId: string) {
  return useMutation<DeckGradeResult, Error, { cardId: string; answer: string }>({
    mutationFn: (b) => post(`/api/deck/${deckId}/grade`, b),
  });
}

export function useRequestChange(deckId: string) {
  const qc = useQueryClient();
  return useMutation<DeckRequestChangeResult, Error, { noteIds: string[]; send: boolean }>({
    mutationFn: (b) => post(`/api/deck/${deckId}/request-change`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: deckKeys.status(deckId) }),
  });
}

export function useCompleteDeck(deckId: string) {
  const qc = useQueryClient();
  return useMutation<DeckSummary, Error, void>({
    mutationFn: () => post(`/api/deck/${deckId}/complete`),
    // Create MR's review section reads this.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cockpit', 'ready', 'preview'] });
      // The turn banner and "Needs your attention" drop a turn once its deck is done.
      void qc.invalidateQueries({ queryKey: ['cockpit', 'sessions'] });
      void qc.invalidateQueries({ queryKey: deckKeys.status(deckId) });
    },
  });
}

/** Where a finished deck stands against its branch. `waitingForPush` adds a poll, for hosts without a push webhook. */
export function useDeckStatus(deckId: string, enabled: boolean, waitingForPush: boolean) {
  return useQuery({
    queryKey: deckKeys.status(deckId),
    queryFn: ({ signal }) => get<DeckStatus>(`/api/deck/${deckId}/status`, { signal }),
    enabled,
    refetchInterval: waitingForPush ? 60_000 : false,
    retry: false,
  });
}

/** Deck route for a source (`/review/:source/:id/deck`). */
export function deckPath(s: DeckSource): string {
  const e = encodeURIComponent;
  if (s.kind === 'mr') return `/review/mr/${e(`${s.repoId}!${s.iid}`)}/deck`;
  if (s.kind === 'compare')
    return `/review/compare/${e(s.repoId)}/deck?from=${e(s.from)}&to=${e(s.to)}`;
  const q = new URLSearchParams({ mode: s.mode, ...(s.base ? { base: s.base } : {}) });
  return `/review/local/${e(s.workspaceId)}/deck?${q.toString()}`;
}

/** Inverse of `deckPath` (route params + search). Null when malformed. */
export function deckSourceFrom(
  kind: string | undefined,
  id: string | undefined,
  search: URLSearchParams,
): DeckSource | null {
  if (!id) return null;
  if (kind === 'mr') {
    const m = /^([a-z0-9][a-z0-9-]*)!(\d+)$/.exec(id);
    return m ? { kind: 'mr', repoId: m[1]!, iid: Number(m[2]) } : null;
  }
  if (kind === 'compare') {
    const from = search.get('from');
    const to = search.get('to');
    return from && to ? { kind: 'compare', repoId: id, from, to } : null;
  }
  if (kind === 'local') {
    const mode = search.get('mode');
    if (mode !== 'working' && mode !== 'branch' && mode !== 'turn') return null;
    const base = search.get('base');
    return { kind: 'local', workspaceId: id, mode, ...(base ? { base } : {}) };
  }
  return null;
}
