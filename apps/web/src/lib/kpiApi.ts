import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignedAtOverrideResult,
  KpiCardsResponse,
  KpiFocusResponse,
  KpiReport,
} from '@relay/shared';
import { get, put } from './api';
import { useFallbackPollMs } from './sseState';

/** Everything hangs off `root`, which `lib/sse.ts` invalidates on the events that can change a KPI. */
export const kpiKeys = {
  root: ['kpi'] as const,
  report: (month: string | undefined) => ['kpi', 'report', month ?? 'current'] as const,
  cards: (month: string | undefined) => ['kpi', 'cards', month ?? 'current'] as const,
  focus: (limit: number) => ['kpi', 'focus', limit] as const,
};

const monthQuery = (month: string | undefined): string =>
  month ? `?month=${encodeURIComponent(month)}` : '';

/** `month` undefined = the server's current month. */
export function useKpiReport(month?: string) {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: kpiKeys.report(month),
    queryFn: ({ signal }) => get<KpiReport>(`/api/kpi${monthQuery(month)}`, { signal }),
    refetchInterval: pollMs,
    placeholderData: keepPreviousData,
  });
}

export function useKpiCards(month?: string) {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: kpiKeys.cards(month),
    queryFn: ({ signal }) =>
      get<KpiCardsResponse>(`/api/kpi/cards${monthQuery(month)}`, { signal }),
    refetchInterval: pollMs,
    placeholderData: keepPreviousData,
  });
}

export function useKpiFocus(limit: number) {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: kpiKeys.focus(limit),
    queryFn: ({ signal }) => get<KpiFocusResponse>(`/api/kpi/focus?limit=${limit}`, { signal }),
    refetchInterval: pollMs,
  });
}

/** The server answers these with `content-disposition: attachment`. */
export const kpiExportUrl = (month: string, format: 'md' | 'csv'): string =>
  `/api/kpi/export?month=${encodeURIComponent(month)}&format=${format}`;

/** `assignedAt: null` removes the override. Local only, audited and undoable. */
export function useSetAssignedAt() {
  const qc = useQueryClient();
  return useMutation<
    AssignedAtOverrideResult,
    Error,
    { cardId: string; assignedAt: number | null }
  >({
    mutationFn: ({ cardId, assignedAt }) =>
      put<AssignedAtOverrideResult>(`/api/cards/${encodeURIComponent(cardId)}/assigned-at`, {
        assignedAt,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: kpiKeys.root });
    },
  });
}
