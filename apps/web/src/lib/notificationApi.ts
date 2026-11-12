import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  NotificationCategory,
  NotificationFilter,
  NotificationLifecycle,
  NotificationList,
  NotificationPriority,
  NotificationSummary,
  NotificationUnread,
} from '@relay/shared';
import { get, post } from './api';
import { useFallbackPollMs } from './sseState';

/** What the page asks for. Empty arrays = no restriction. */
export interface NotificationQuery {
  filter: NotificationFilter;
  lifecycle: NotificationLifecycle[];
  priority: NotificationPriority[];
  category: NotificationCategory[];
  repoId?: string | undefined;
}

export const notificationKeys = {
  /** Prefix of everything here (SSE invalidation, `lib/sse.ts`). */
  root: ['notifications'] as const,
  list: (q: NotificationQuery) => ['notifications', 'list', q] as const,
  summary: (repoId: string | undefined) => ['notifications', 'summary', repoId ?? null] as const,
  unread: ['notifications', 'unread'] as const,
};

/** Server titles can open with an emoji (`⏰ SLA at 86%`). Rows already carry a lucide icon, so it is dropped for display. */
export function notificationTitle(title: string): string {
  return title.replace(/^(?:\p{Extended_Pictographic}️?\s*)+/u, '');
}

/** Newest first. Each row's status and actions are worked out by the server at read time. */
export function useNotifications(query: NotificationQuery) {
  const pollMs = useFallbackPollMs();
  return useInfiniteQuery({
    queryKey: notificationKeys.list(query),
    queryFn: ({ pageParam, signal }) => {
      const qs = new URLSearchParams({ filter: query.filter });
      if (query.lifecycle.length > 0) qs.set('lifecycle', query.lifecycle.join(','));
      if (query.priority.length > 0) qs.set('priority', query.priority.join(','));
      if (query.category.length > 0) qs.set('category', query.category.join(','));
      if (query.repoId) qs.set('repoId', query.repoId);
      if (pageParam !== null) qs.set('cursor', String(pageParam));
      return get<NotificationList>(`/api/notifications?${qs.toString()}`, { signal });
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: pollMs,
  });
}

/** Counts for the lifecycle tabs. */
export function useNotificationSummary(repoId?: string) {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: notificationKeys.summary(repoId),
    queryFn: ({ signal }) => {
      const qs = repoId ? `?${new URLSearchParams({ repoId }).toString()}` : '';
      return get<NotificationSummary>(`/api/notifications/summary${qs}`, { signal });
    },
    refetchInterval: pollMs,
  });
}

export function useDismissHandledNotifications() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (repoId?: string) =>
      post<{ ok: true; marked: number }>(
        '/api/notifications/dismiss-handled',
        repoId ? { repoId } : {},
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: notificationKeys.root }),
  });
}

export function useUnreadNotifications() {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: ({ signal }) => get<NotificationUnread>('/api/notifications/unread-count', { signal }),
    refetchInterval: pollMs,
  });
}

export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => post<{ ok: true }>(`/api/notifications/${id}/read`),
    onSuccess: () => client.invalidateQueries({ queryKey: notificationKeys.root }),
  });
}

export function useMarkAllNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ ok: true; marked: number }>('/api/notifications/read-all'),
    onSuccess: () => client.invalidateQueries({ queryKey: notificationKeys.root }),
  });
}
