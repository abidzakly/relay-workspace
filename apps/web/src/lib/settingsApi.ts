import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GlobalConfigStoredSchema,
  RepoConfigStoredSchema,
  type ConnectionTestResult,
  type GlobalConfigPublic,
  type RepoConfigPublic,
} from '@relay/shared';
import { ApiError, del, get, patch, post, put, type ApiIssue } from './api';

export const keys = {
  settings: ['settings'] as const,
  repos: ['repos'] as const,
};

interface SettingsResponse {
  settings: GlobalConfigPublic;
}
interface ReposResponse {
  repos: RepoConfigPublic[];
}
interface RepoResponse {
  repo: RepoConfigPublic;
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await get<SettingsResponse>('/api/settings')).settings,
  });
}

export function useRepos() {
  return useQuery({
    queryKey: keys.repos,
    queryFn: async () => (await get<ReposResponse>('/api/repos')).repos,
  });
}

export type DriveKeyStatus =
  { ok: true; keyPath: string } | { ok: false; keyPath: string; message: string; hint: string };

/** Whether the Drive service-account key file is on this machine (a file, so never part of a config import). */
export function useDriveKey() {
  return useQuery({
    // Under `settings`, so anything that refreshes the settings re-checks the key too.
    queryKey: [...keys.settings, 'drive-key'] as const,
    queryFn: () => get<DriveKeyStatus>('/api/settings/drive-key'),
  });
}

/** Every GitLab username that is "me": `gitlab.myUsername` plus the bot users behind the repo tokens. */
export function useMyUsernames() {
  return useQuery({
    queryKey: [...keys.repos, 'me'],
    queryFn: async () => (await get<{ usernames: string[] }>('/api/me')).usernames,
    staleTime: 5 * 60_000,
  });
}

/** Client-side validation with the SAME Zod schemas the server uses; failures look like server 400s. */
function validationError(issues: { path: PropertyKey[]; message: string }[]): ApiError {
  const mapped: ApiIssue[] = issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  return new ApiError(400, 'validation', 'Some values are invalid', mapped);
}

/**
 * PUT /api/settings is a FULL REPLACE of the non-secret settings, so every save
 * re-reads the current server state, applies one section's change on top, and sends the whole object.
 * Sections the UI has no editor for yet (sla, notifications) therefore round-trip unchanged.
 *
 * `notionToken`: undefined = keep, SECRET_MASK = keep, string = replace, null = clear.
 */
export function useSaveGlobal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      patch: (current: GlobalConfigPublic) => GlobalConfigPublic;
      notionToken?: string | null;
    }): Promise<GlobalConfigPublic> => {
      const current = (await get<SettingsResponse>('/api/settings')).settings;
      const next = args.patch(current);
      const { tokenSet: _tokenSet, ...notion } = next.notion;
      const body = {
        ...next,
        notion: {
          ...notion,
          ...(args.notionToken !== undefined ? { token: args.notionToken } : {}),
        },
      };
      const parsed = GlobalConfigStoredSchema.safeParse(body);
      if (!parsed.success) throw validationError(parsed.error.issues);
      return (await put<SettingsResponse>('/api/settings', body)).settings;
    },
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings);
      // The key path may have changed.
      void qc.invalidateQueries({ queryKey: [...keys.settings, 'drive-key'] });
    },
  });
}

/** Body for POST/PUT /api/repos (secrets handled by the caller). Validated client-side first. */
export function validateRepoBody(body: unknown): ApiError | null {
  const parsed = RepoConfigStoredSchema.safeParse(body);
  return parsed.success ? null : validationError(parsed.error.issues);
}

export function useSaveRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { mode: 'create' | 'edit'; id: string; body: unknown }) => {
      const invalid = validateRepoBody(args.body);
      if (invalid) throw invalid;
      const res =
        args.mode === 'create'
          ? await post<RepoResponse>('/api/repos', args.body)
          : await put<RepoResponse>(`/api/repos/${encodeURIComponent(args.id)}`, args.body);
      return res.repo;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.repos }),
  });
}

/** Puts a repo's cards on the Board, or takes them off. */
export function useSetRepoEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) =>
      patch<RepoResponse>(`/api/repos/${encodeURIComponent(args.id)}/enabled`, {
        enabled: args.enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.repos }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del<void>(`/api/repos/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.repos }),
  });
}

/** Connection tests are read-only and run against the SAVED config on the server. */
export function useTestRepo() {
  return useMutation({
    mutationFn: (id: string) =>
      post<ConnectionTestResult>(`/api/repos/${encodeURIComponent(id)}/test`),
  });
}
export function useTestNotion() {
  return useMutation({
    mutationFn: () => post<ConnectionTestResult>('/api/settings/test-notion'),
  });
}
export function useTestDrive() {
  return useMutation({
    mutationFn: (folderId?: string) =>
      post<ConnectionTestResult>('/api/settings/test-drive', folderId ? { folderId } : undefined),
  });
}
