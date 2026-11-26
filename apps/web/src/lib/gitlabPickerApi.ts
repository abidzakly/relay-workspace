import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  BranchList,
  GitlabFlutterHints,
  GitlabMe,
  GitlabMember,
  GitlabPickerBody,
  GitlabProjectOption,
} from '@relay/shared';
import { get, post } from './api';

/**
 * GitLab reads for the Add repository wizard (`/api/gitlab/pick/*`). `who` says which token reads: a pasted project
 * token, a saved repo's own token, or (neither) the sign-in / personal token. The token stays in memory only.
 */
export interface PickWho {
  token?: string | undefined;
  repoId?: string | undefined;
}

const body = (who: PickWho, extra: Omit<GitlabPickerBody, 'token' | 'repoId'> = {}) => ({
  ...(who.token ? { token: who.token } : {}),
  ...(who.repoId ? { repoId: who.repoId } : {}),
  ...extra,
});
/** The cache key tells credentials apart without holding the token itself. */
const whoKey = (who: PickWho) =>
  who.token
    ? `t:${who.token.length}:${who.token.slice(-4)}`
    : who.repoId
      ? `r:${who.repoId}`
      : 'me';

export const pickKeys = {
  all: ['gitlab-pick'] as const,
  me: (w: string) => ['gitlab-pick', 'me', w] as const,
  projects: (w: string, s: string) => ['gitlab-pick', 'projects', w, s] as const,
  branches: (w: string, p: number, s: string) => ['gitlab-pick', 'branches', w, p, s] as const,
  members: (w: string, p: number, s: string) => ['gitlab-pick', 'members', w, p, s] as const,
  flutter: (w: string, p: number, ref: string) => ['gitlab-pick', 'flutter', w, p, ref] as const,
};

export function usePickMe(who: PickWho, enabled: boolean) {
  return useQuery({
    queryKey: pickKeys.me(whoKey(who)),
    queryFn: () => post<GitlabMe>('/api/gitlab/pick/me', body(who)),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function usePickProjects(who: PickWho, search: string, enabled: boolean) {
  return useQuery({
    queryKey: pickKeys.projects(whoKey(who), search),
    queryFn: () =>
      post<GitlabProjectOption[]>('/api/gitlab/pick/projects', body(who, search ? { search } : {})),
    enabled,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export function usePickBranches(who: PickWho, projectId: number | undefined, search: string) {
  return useQuery({
    queryKey: pickKeys.branches(whoKey(who), projectId ?? 0, search),
    queryFn: () =>
      post<BranchList>(
        '/api/gitlab/pick/branches',
        body(who, { projectId, ...(search ? { search } : {}) }),
      ),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev, q) => (q?.queryKey[3] === (projectId ?? 0) ? prev : undefined),
  });
}

export function usePickMembers(who: PickWho, projectId: number | undefined, search: string) {
  return useQuery({
    queryKey: pickKeys.members(whoKey(who), projectId ?? 0, search),
    queryFn: () =>
      post<GitlabMember[]>(
        '/api/gitlab/pick/members',
        body(who, { projectId, ...(search ? { search } : {}) }),
      ),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev, q) => (q?.queryKey[3] === (projectId ?? 0) ? prev : undefined),
  });
}

/** `ref`: the base branch, so the flavors match what gets built. */
export function usePickFlutter(who: PickWho, projectId: number | undefined, ref: string) {
  return useQuery({
    queryKey: pickKeys.flutter(whoKey(who), projectId ?? 0, ref),
    queryFn: () =>
      post<GitlabFlutterHints>(
        '/api/gitlab/pick/flutter',
        body(who, { projectId, ...(ref ? { search: ref } : {}) }),
      ),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Is there a GitLab at this address (no token is sent). */
export function useCheckGitlabHost() {
  return useMutation({
    mutationFn: (host: string) =>
      post<{ ok: boolean; host: string; version: string | null; message: string }>(
        '/api/gitlab/pick/host',
        { host },
      ),
  });
}

export interface TunnelOption {
  publicUrl: string;
  addr: string;
  /** Forwards to Relay's webhook port. */
  webhook: boolean;
}

/** Public URLs of an ngrok agent running on this machine; empty when there is none. */
export function useTunnels(enabled: boolean) {
  return useQuery({
    queryKey: ['gitlab-pick', 'tunnels'],
    queryFn: ({ signal }) => get<TunnelOption[]>('/api/gitlab/pick/tunnels', { signal }),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}
