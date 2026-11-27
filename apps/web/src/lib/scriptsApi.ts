import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScriptsDirPick, ScriptsMissing, ScriptsStatus } from '@relay/shared';
import { ApiError, get, post, put } from './api';

export const scriptsKeys = { status: ['scripts'] as const };

export function useScripts(enabled = true) {
  return useQuery({
    queryKey: scriptsKeys.status,
    queryFn: ({ signal }) => get<ScriptsStatus>('/api/scripts', { signal }),
    enabled,
  });
}

export function useSaveScripts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string | null>) =>
      put<ScriptsStatus>('/api/scripts', { values }),
    onSuccess: (s) => qc.setQueryData(scriptsKeys.status, s),
  });
}

/** "Choose folder…" for the scripts: the computer's dialog, or `path` where it has none. */
export function useChooseScriptsDir() {
  const qc = useQueryClient();
  return useMutation<ScriptsDirPick, Error, string | undefined>({
    mutationFn: (path) => post('/api/scripts/dir', path === undefined ? {} : { path }),
    onSuccess: (r) => {
      if (r.status === 'picked') void qc.invalidateQueries({ queryKey: scriptsKeys.status });
    },
  });
}

/** The values a refused start asked for (409 `script_config_missing`), or null for any other error. */
export function missingScriptValues(error: unknown): ScriptsMissing | null {
  if (!(error instanceof ApiError) || error.code !== 'script_config_missing') return null;
  const d = error.details as Partial<ScriptsMissing> | undefined;
  if (!d || !Array.isArray(d.required)) return null;
  return {
    repoId: typeof d.repoId === 'string' ? d.repoId : '',
    required: d.required.filter((k): k is string => typeof k === 'string'),
    optional: Array.isArray(d.optional)
      ? d.optional.filter((k): k is string => typeof k === 'string')
      : [],
  };
}
