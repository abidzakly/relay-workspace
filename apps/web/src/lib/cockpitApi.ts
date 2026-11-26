import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  builtinCursorModels,
  CLAUDE_MODELS,
  type AgentModelCatalog,
  type AiEngineStatus,
  type CommitMessageResult,
  type ConnectionTestResult,
  type DiffFile,
  type FolderPickResult,
  type Workspace,
  type WorkspaceCreate,
  type WsFile,
  type WsStatusView,
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

/**
 * The models the Settings pickers offer, limited to what the local Claude and Cursor logins may use. Until the server
 * answers (and when it cannot read the CLIs) the full built-in catalog shows.
 */
export function useAgentModels() {
  return useQuery({
    queryKey: [...cockpitKeys.ai, 'models'] as const,
    queryFn: () => get<AgentModelCatalog>('/api/ai/models'),
    staleTime: 10 * 60_000,
    placeholderData: (): AgentModelCatalog => ({
      claude: [...CLAUDE_MODELS],
      cursor: builtinCursorModels(),
      source: 'builtin',
      accounts: { claude: null, cursor: null },
    }),
  });
}

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

/** Opens the computer's folder dialog (on the host); resolves when the person picks or cancels. */
export function usePickFolder() {
  return useMutation<FolderPickResult, Error, void>({
    mutationFn: () => post('/api/cockpit/pick-folder'),
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

/** `useWsStatus` for several workspaces at once (same cache entries), in the order of `ids`. */
export function useWsStatuses(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: cockpitKeys.status(id),
      queryFn: () => get<WsStatusView>(`/api/cockpit/ws/${e(id)}/status`),
      refetchInterval: 15_000,
    })),
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

export interface WsCommitResult {
  sha: string;
  subject: string;
  amended: boolean;
}

/** Keeps a workspace's uncommitted changes: a new commit with `message`, or amended into the branch's last commit. */
export function useWsCommit() {
  const qc = useQueryClient();
  return useMutation<
    WsCommitResult,
    Error,
    { workspaceId: string; message?: string; amend: boolean }
  >({
    mutationFn: ({ workspaceId, ...b }) => post(`/api/cockpit/ws/${e(workspaceId)}/commit`, b),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: cockpitKeys.status(v.workspaceId) });
      void qc.invalidateQueries({ queryKey: cockpitKeys.tree(v.workspaceId) });
    },
  });
}

/** "Smart commit": an AI-written message for the workspace's uncommitted changes. */
export function useCommitMessage() {
  return useMutation<CommitMessageResult, Error, { workspaceId: string }>({
    mutationFn: ({ workspaceId }) => post(`/api/cockpit/ws/${e(workspaceId)}/commit-message`, {}),
  });
}

/** Puts a workspace on `branch` (fast-forwarded to origin). The server refuses a dirty tree with `ws_dirty`. */
export function useWsCheckout() {
  const qc = useQueryClient();
  return useMutation<
    { branch: string; synced: boolean },
    Error,
    { workspaceId: string; branch: string }
  >({
    mutationFn: ({ workspaceId, branch }) =>
      post(`/api/cockpit/ws/${e(workspaceId)}/checkout`, { branch }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: cockpitKeys.status(v.workspaceId) });
      void qc.invalidateQueries({ queryKey: cockpitKeys.tree(v.workspaceId) });
    },
  });
}

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
