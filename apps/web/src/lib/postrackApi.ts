import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PostrackStatus, PostrackTree, PostrackWorkspace } from '@relay/shared';
import { ApiError, del, get, post, put } from './api';

export const postrackKeys = {
  status: ['postrack', 'status'] as const,
  workspaces: ['postrack', 'workspaces'] as const,
  tree: (id: string) => ['postrack', 'tree', id] as const,
};

/** The sign-in popup's page tells the opener through this channel (COOP cuts `window.opener`). */
export const POSTRACK_CHANNEL = 'relay-postrack';

export function usePostrackStatus(enabled = true) {
  return useQuery({
    queryKey: postrackKeys.status,
    queryFn: ({ signal }) => get<PostrackStatus>('/api/postrack', { signal }),
    enabled,
    staleTime: 30_000,
  });
}

export function usePostrackWorkspaces(enabled: boolean) {
  return useQuery({
    queryKey: postrackKeys.workspaces,
    queryFn: ({ signal }) =>
      get<{ items: PostrackWorkspace[] }>('/api/postrack/workspaces', { signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function usePostrackTree(workspaceId: string | null) {
  return useQuery({
    queryKey: postrackKeys.tree(workspaceId ?? ''),
    queryFn: ({ signal }) =>
      get<PostrackTree>(`/api/postrack/workspaces/${encodeURIComponent(workspaceId ?? '')}/tree`, {
        signal,
      }),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

function useRefreshPostrack() {
  const qc = useQueryClient();
  return useCallback(
    (s?: PostrackStatus) => {
      if (s) qc.setQueryData(postrackKeys.status, s);
      void qc.invalidateQueries({ queryKey: ['postrack'] });
    },
    [qc],
  );
}

/** API-key mode: checked with Postrack before it is saved (422 `token_check_failed` when refused). */
export function useSavePostrackKey() {
  const refresh = useRefreshPostrack();
  return useMutation({
    mutationFn: (b: { url: string; apiKey: string | null | undefined }) =>
      put<PostrackStatus>('/api/postrack', b),
    onSuccess: (s) => refresh(s),
  });
}

export function useDisconnectPostrack() {
  const refresh = useRefreshPostrack();
  return useMutation({
    mutationFn: () => del<PostrackStatus>('/api/postrack'),
    onSuccess: (s) => refresh(s),
  });
}

/**
 * OAuth sign-in in a popup. The popup is opened inside the click (a popup opened after an await is blocked) and sent
 * to Postrack once Relay has the sign-in URL. Done when the callback page reports back, or the status turns connected.
 */
export function useConnectPostrackOAuth() {
  const refresh = useRefreshPostrack();
  const [state, setState] = useState<'idle' | 'starting' | 'waiting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const connect = useCallback(
    (url: string, onConnected?: () => void) => {
      stop.current?.();
      setError(null);
      setState('starting');
      const popup = window.open('', 'relay-postrack-signin', 'popup,width=520,height=720');
      const finish = (err: string | null) => {
        stop.current?.();
        stop.current = null;
        setState('idle');
        setError(err);
        refresh();
        if (!err) onConnected?.();
      };
      void (async () => {
        let res: { authorizationUrl: string | null };
        try {
          res = await post('/api/postrack/oauth/start', { url, origin: window.location.origin });
        } catch (e) {
          popup?.close();
          finish(e instanceof ApiError ? e.message : (e as Error).message);
          return;
        }
        if (!res.authorizationUrl) {
          popup?.close();
          finish(null);
          return;
        }
        if (popup) popup.location.href = res.authorizationUrl;
        else window.open(res.authorizationUrl, '_blank', 'noopener');
        setState('waiting');

        let channel: BroadcastChannel | null = null;
        try {
          channel = new BroadcastChannel(POSTRACK_CHANNEL);
          channel.onmessage = (m: MessageEvent<{ type?: string; error?: string | null }>) => {
            if (m.data?.type === 'postrack-signin') finish(m.data.error ?? null);
          };
        } catch {
          /* old browser: the status poll below still finishes it */
        }
        // Fallback: the callback page may not reach us (another browser profile); watch the status instead.
        const poll = setInterval(() => {
          void get<PostrackStatus>('/api/postrack')
            .then((s) => {
              if (s.connected && s.authMode === 'oauth') finish(null);
            })
            .catch(() => undefined);
        }, 3_000);
        const give = setTimeout(
          () => finish('The sign-in took too long. Start Connect again.'),
          10 * 60_000,
        );
        stop.current = () => {
          channel?.close();
          clearInterval(poll);
          clearTimeout(give);
        };
      })();
    },
    [refresh],
  );

  const cancel = useCallback(() => {
    stop.current?.();
    stop.current = null;
    setState('idle');
  }, []);

  return { connect, cancel, state, error };
}

/** A start refused because Postrack is not connected (409 `postrack_not_connected`). */
export function postrackNotConnected(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'postrack_not_connected';
}
