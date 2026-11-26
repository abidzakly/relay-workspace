import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type {
  GitlabProjectOption,
  GoogleFeature,
  NotionDataSourceOption,
  NotionMe,
  NotionPerson,
  NotionSchemaView,
  OAuthProvider,
  OAuthStatus,
} from '@relay/shared';
import { get, post } from './api';

/** "Connect" sign-ins (Google, GitLab, Notion). */
export const oauthKeys = {
  status: ['oauth', 'status'] as const,
  notionSources: ['oauth', 'notion', 'data-sources'] as const,
  notionSchema: (id: string) => ['oauth', 'notion', 'schema', id] as const,
  notionMe: ['oauth', 'notion', 'me'] as const,
  notionPeople: (id: string, prop: string) => ['oauth', 'notion', 'people', id, prop] as const,
  gitlabProjects: (search: string) => ['oauth', 'gitlab', 'projects', search] as const,
};

/** How long the card keeps checking for the sign-in to land after the provider's tab opened. */
const WAIT_MS = 5 * 60_000;

export function useOAuthStatus(waiting = false) {
  return useQuery({
    queryKey: oauthKeys.status,
    queryFn: ({ signal }) => get<OAuthStatus>('/api/oauth/status', { signal }),
    // While a sign-in tab is open, look every 2 s, so the card says "Connected" as soon as it is.
    refetchInterval: waiting ? 2_000 : false,
  });
}

/**
 * Opens the provider's sign-in page in a new tab, then watches for the sign-in to land. When it does, every query is
 * refetched: the calendar, Reviews, the board and the settings all change with it.
 */
export function useConnect(provider: OAuthProvider, isDone: (s: OAuthStatus) => boolean) {
  const qc = useQueryClient();
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const status = useOAuthStatus(waitingSince !== null);
  const done = status.data ? isDone(status.data) : false;
  const doneRef = useRef(done);

  useEffect(() => {
    if (waitingSince === null) {
      doneRef.current = done;
      return;
    }
    if (done && !doneRef.current) {
      setWaitingSince(null);
      void qc.invalidateQueries();
    } else if (Date.now() - waitingSince > WAIT_MS) {
      setWaitingSince(null);
    }
    doneRef.current = done;
  }, [done, waitingSince, status.dataUpdatedAt, qc]);

  const start = useMutation({
    mutationFn: (feature?: GoogleFeature) =>
      post<{ url: string }>(`/api/oauth/${provider}/connect`, feature ? { feature } : {}),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener');
      setWaitingSince(Date.now());
    },
  });

  const disconnect = useMutation({
    mutationFn: () => post<OAuthStatus>(`/api/oauth/${provider}/disconnect`, {}),
    onSuccess: (s) => {
      qc.setQueryData(oauthKeys.status, s);
      void qc.invalidateQueries();
    },
  });

  return { status, start, disconnect, waiting: waitingSince !== null };
}

export function useNotionDataSources(enabled: boolean) {
  return useQuery({
    queryKey: oauthKeys.notionSources,
    queryFn: ({ signal }) =>
      get<NotionDataSourceOption[]>('/api/oauth/notion/data-sources', { signal }),
    enabled,
    staleTime: 60_000,
  });
}

/** A data source's columns and a few cards, for the setup wizard. */
export function useNotionSchema(id: string | undefined) {
  return useQuery({
    queryKey: oauthKeys.notionSchema(id ?? ''),
    queryFn: ({ signal }) =>
      get<NotionSchemaView>(`/api/oauth/notion/schema/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: !!id,
    staleTime: 60_000,
    retry: false,
  });
}

/** The people tagged in a board's people column (newest cards first), to pick "which one is you". */
export function useNotionPeople(id: string | undefined, prop: string | undefined) {
  return useQuery({
    queryKey: oauthKeys.notionPeople(id ?? '', prop ?? ''),
    queryFn: ({ signal }) =>
      get<NotionPerson[]>(
        `/api/oauth/notion/people/${encodeURIComponent(id ?? '')}?prop=${encodeURIComponent(prop ?? '')}`,
        { signal },
      ),
    enabled: !!id && !!prop,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The Notion user behind the sign-in, to fill in "My names". */
export function useNotionMe(enabled: boolean) {
  return useQuery({
    queryKey: oauthKeys.notionMe,
    queryFn: ({ signal }) => get<NotionMe>('/api/oauth/notion/me', { signal }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useGitlabProjects(search: string, enabled: boolean) {
  return useQuery({
    queryKey: oauthKeys.gitlabProjects(search),
    queryFn: ({ signal }) =>
      get<GitlabProjectOption[]>(
        `/api/oauth/gitlab/projects${search ? `?search=${encodeURIComponent(search)}` : ''}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
  });
}
