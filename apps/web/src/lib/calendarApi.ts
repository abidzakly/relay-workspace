import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  CalendarConfigUpdate,
  CalendarStatus,
  MeetingList,
  MeetingPriorityBody,
} from '@relay/shared';
import { get, post, put } from './api';

/** Google Calendar. The server pushes `calendar.changed` over SSE, so these rarely refetch on their own. */
export const calendarKeys = {
  root: ['calendar'] as const,
  status: ['calendar', 'status'] as const,
  meetings: ['calendar', 'meetings'] as const,
};

export function useCalendarStatus() {
  return useQuery({
    queryKey: calendarKeys.status,
    queryFn: ({ signal }) => get<CalendarStatus>('/api/calendar/status', { signal }),
  });
}

export function useMeetings(enabled = true) {
  return useQuery({
    queryKey: calendarKeys.meetings,
    queryFn: ({ signal }) => get<MeetingList>('/api/calendar/meetings', { signal }),
    enabled,
    // A safety net for a dropped event stream: the alert must never miss a start.
    refetchInterval: 120_000,
  });
}

export function useSaveCalendarConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CalendarConfigUpdate) => put<CalendarStatus>('/api/calendar/config', body),
    onSuccess: (s) => qc.setQueryData(calendarKeys.status, s),
    onSettled: () => qc.invalidateQueries({ queryKey: calendarKeys.meetings }),
  });
}

/** Opens Google's consent page in a new tab; the server's callback page closes the loop. */
export function useConnectCalendar() {
  return useMutation({
    mutationFn: () => post<{ url: string }>('/api/calendar/connect', {}),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener');
    },
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<CalendarStatus>('/api/calendar/disconnect', {}),
    onSuccess: (s) => qc.setQueryData(calendarKeys.status, s),
    onSettled: () => qc.invalidateQueries({ queryKey: calendarKeys.root }),
  });
}

export function useRefreshMeetings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<MeetingList>('/api/calendar/refresh', {}),
    onSuccess: (list) => qc.setQueryData(calendarKeys.meetings, list),
    onSettled: () => qc.invalidateQueries({ queryKey: calendarKeys.status }),
  });
}

/** Optimistic: the alert leaves at once, the server keeps the choice for other tabs and reloads. */
export function useDismissMeeting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; dismissed?: boolean }) =>
      post<MeetingList>('/api/calendar/meetings/dismiss', {
        id: a.id,
        dismissed: a.dismissed ?? true,
      }),
    onMutate: (a) => {
      qc.setQueryData<MeetingList>(calendarKeys.meetings, (old) =>
        old
          ? {
              ...old,
              meetings: old.meetings.map((m) =>
                m.id === a.id ? { ...m, dismissed: a.dismissed ?? true } : m,
              ),
            }
          : old,
      );
    },
    onSuccess: (list) => qc.setQueryData(calendarKeys.meetings, list),
  });
}

/**
 * Marks a meeting Key / Normal / Quiet (or, with `level: null`, back to automatic). Optimistic for a set level: the
 * meeting (and with `series`, every occurrence) changes at once; the server's answer carries the real reasons.
 */
export function useSetMeetingPriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MeetingPriorityBody) =>
      post<MeetingList>('/api/calendar/meetings/priority', body),
    onMutate: (b) => {
      if (b.level === null) return;
      const level = b.level;
      qc.setQueryData<MeetingList>(calendarKeys.meetings, (old) =>
        old
          ? {
              ...old,
              meetings: old.meetings.map((m) =>
                m.id === b.id ||
                (b.scope === 'series' &&
                  b.seriesId &&
                  m.seriesId === b.seriesId &&
                  m.calendarId === b.calendarId)
                  ? {
                      ...m,
                      priority: level,
                      prioritySource: b.scope,
                      priorityReason:
                        b.scope === 'series'
                          ? 'Marked by you (every occurrence)'
                          : 'Marked by you (this meeting)',
                    }
                  : m,
              ),
            }
          : old,
      );
    },
    onSuccess: (list) => qc.setQueryData(calendarKeys.meetings, list),
  });
}

/** A clock that ticks every `ms`, corrected by the server's clock (`skew` = server − browser). */
export function useNow(ms: number, skew = 0): number {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    setNow(Date.now() + skew);
    const id = window.setInterval(() => setNow(Date.now() + skew), ms);
    return () => window.clearInterval(id);
  }, [ms, skew]);
  return now;
}
