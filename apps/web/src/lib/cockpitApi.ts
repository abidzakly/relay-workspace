import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiEngineStatus,
  ConnectionTestResult,
  DiffFile,
  Workspace,
  WorkspaceCreate,
  WsFile,
  WsStatusView,
} from '@relay/shared';
import { del, get, post, put } from './api';

/** Cockpit workspaces + files. SSE `cockpit.changed` refreshes. */
export const cockpitKeys = {
  workspaces: ['cockpit', 'workspaces'] as const,
  status: (id: string) => ['cockpit', 'workspaces', id, 'status'] as const,
  tree: (id: string) => ['cockpit', 'workspaces', id, 'tree'] as const,
  file: (id: string, path: string) => ['cockpit', 'workspaces', id, 'file', path] as const,
  ai: ['cockpit', 'ai'] as const,
};
const e = encodeURIComponent;

export function useAiStatus() {
  return useQuery({
    queryKey: cockpitKeys.ai,
    queryFn: () => get<AiEngineStatus>('/api/ai/status'),
    staleTime: 60_000,
  });
}

/** Real round trip to each AI engine (Claude, Cursor, API key), bypassing the server's health caches. */
export function useTestAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<ConnectionTestResult>('/api/ai/test'),
    onSettled: () => qc.invalidateQueries({ queryKey: cockpitKeys.ai }),
  });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: cockpitKeys.workspaces,
    queryFn: async () => (await get<{ items: Workspace[] }>('/api/cockpit/workspaces')).items,
    staleTime: 60_000,
  });
}

export function useAddWorkspace() {
  const qc = useQueryClient();
  return useMutation<
    Workspace,
    Error,
    Partial<WorkspaceCreate> & { name: string; absPath: string }
  >({
    mutationFn: (b) => post('/api/cockpit/workspaces', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: cockpitKeys.workspaces }),
  });
}

export function useRemoveWorkspace() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => del(`/api/cockpit/workspaces/${e(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: cockpitKeys.workspaces }),
  });
}

export function useWsStatus(id: string | null) {
  return useQuery({
    queryKey: cockpitKeys.status(id ?? ''),
    queryFn: () => get<WsStatusView>(`/api/cockpit/ws/${e(id!)}/status`),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

export function useWsTree(id: string | null) {
  return useQuery({
    queryKey: cockpitKeys.tree(id ?? ''),
    queryFn: () => get<{ paths: string[]; truncated: boolean }>(`/api/cockpit/ws/${e(id!)}/tree`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useWsFile(id: string | null, path: string | null) {
  return useQuery({
    queryKey: cockpitKeys.file(id ?? '', path ?? ''),
    queryFn: () => get<WsFile>(`/api/cockpit/ws/${e(id!)}/file?path=${e(path!)}`),
    enabled: !!id && !!path,
    staleTime: 0,
    retry: false,
  });
}

export function useSaveWsFile(id: string) {
  const qc = useQueryClient();
  return useMutation<
    { hash: string },
    Error,
    { path: string; content: string; expectedHash: string | null }
  >({
    mutationFn: (b) => put(`/api/cockpit/ws/${e(id)}/file`, b),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: cockpitKeys.file(id, v.path) });
      void qc.invalidateQueries({ queryKey: cockpitKeys.status(id) });
    },
  });
}

export const wsDiff = (id: string, mode: string, base?: string) =>
  get<{ files: DiffFile[]; label: string }>(
    `/api/cockpit/ws/${e(id)}/diff?mode=${e(mode)}${base ? `&base=${e(base)}` : ''}`,
  );

/** Uncommitted changes (working tree vs HEAD, untracked included), e.g. before a card start. */
export function useWsWorkingDiff(id: string | null) {
  return useQuery({
    queryKey: [...cockpitKeys.status(id ?? ''), 'working-diff'] as const,
    queryFn: () => wsDiff(id!, 'working'),
    enabled: !!id,
    staleTime: 0,
    retry: false,
  });
}

export type CleanTreeMode = 'stash' | 'discard';

/** Stashes (untracked included) or discards a workspace's uncommitted changes. */
export function useCleanTree() {
  const qc = useQueryClient();
  return useMutation<
    { mode: CleanTreeMode; stash: string | null },
    Error,
    { workspaceId: string; mode: CleanTreeMode }
  >({
    mutationFn: ({ workspaceId, mode }) =>
      post(`/api/cockpit/ws/${e(workspaceId)}/clean-tree`, { mode }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: cockpitKeys.status(v.workspaceId) });
      void qc.invalidateQueries({ queryKey: cockpitKeys.tree(v.workspaceId) });
    },
  });
}
