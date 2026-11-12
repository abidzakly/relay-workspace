import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CockpitSession,
  FlutterDevice,
  FlutterRunMode,
  RunTargets,
  SessionStart,
} from '@relay/shared';
import { get, post } from './api';

/** Cockpit sessions. SSE `cockpit.changed {what:'sessions'}` refreshes the list. */
export interface TurnInfo {
  checkpoint: number | null;
  files: number | null;
  headline: string | null;
  at: number;
  reviewed?: boolean;
}
export type SessionView = CockpitSession & { turn: TurnInfo | null };

export const sessionKeys = {
  list: ['cockpit', 'sessions'] as const,
  devices: (ws: string) => ['cockpit', 'devices', ws] as const,
  runTargets: (ws: string) => ['cockpit', 'run-targets', ws] as const,
};

const RUN_PREFS = (ws: string) => `cockpit:run:${ws}`;
const RUN_MODES = new Set<string>(['debug', 'profile', 'release']);

/** Last flavor and mode for this workspace. A missing or broken value is debug with no flavor. */
export function readRunPrefs(ws: string): { flavor: string; mode: FlutterRunMode } {
  try {
    const raw = localStorage.getItem(RUN_PREFS(ws));
    if (!raw) return { flavor: '', mode: 'debug' };
    const p = JSON.parse(raw) as { flavor?: unknown; mode?: unknown };
    return {
      flavor: typeof p.flavor === 'string' ? p.flavor : '',
      mode:
        typeof p.mode === 'string' && RUN_MODES.has(p.mode) ? (p.mode as FlutterRunMode) : 'debug',
    };
  } catch {
    return { flavor: '', mode: 'debug' };
  }
}

export function saveRunPrefs(ws: string, flavor: string, mode: FlutterRunMode): void {
  try {
    localStorage.setItem(RUN_PREFS(ws), JSON.stringify({ flavor, mode }));
  } catch {
    /* private mode: the choice still applies to this run */
  }
}

/** The flavor to send. One entrypoint wins. Several use `saved` only when it is one of them. */
export function pickedFlavor(flavors: readonly string[], saved: string): string {
  if (flavors.length === 1) return flavors[0]!;
  return flavors.includes(saved) ? saved : '';
}

const e = encodeURIComponent;

export function useSessions() {
  return useQuery({
    queryKey: sessionKeys.list,
    queryFn: async () => (await get<{ items: SessionView[] }>('/api/cockpit/sessions')).items,
    refetchInterval: 10_000,
  });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation<
    CockpitSession,
    Error,
    Partial<SessionStart> & Pick<SessionStart, 'workspaceId' | 'kind'>
  >({
    mutationFn: (b) => post('/api/cockpit/sessions', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: sessionKeys.list }),
  });
}

export const sendInput = (id: string, data: string) =>
  post<{ ok: boolean }>(`/api/cockpit/sessions/${e(id)}/input`, { data });
export const sendPrompt = (id: string, data: string) =>
  post<{ checkpoint: number | null }>(`/api/cockpit/sessions/${e(id)}/prompt`, { data });
export const resizeSession = (id: string, cols: number, rows: number) =>
  post<{ ok: boolean }>(`/api/cockpit/sessions/${e(id)}/resize`, { cols, rows });

export function useKillSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => post(`/api/cockpit/sessions/${e(id)}/kill`, {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: sessionKeys.list }),
  });
}

export function useRunTargets(ws: string | null) {
  return useQuery({
    queryKey: sessionKeys.runTargets(ws ?? ''),
    queryFn: () => get<RunTargets>(`/api/cockpit/ws/${e(ws!)}/run-targets`),
    enabled: !!ws,
    staleTime: 30_000,
  });
}

export function useDevices(ws: string | null) {
  return useQuery({
    queryKey: sessionKeys.devices(ws ?? ''),
    queryFn: async () =>
      (await get<{ items: FlutterDevice[] }>(`/api/cockpit/ws/${e(ws!)}/devices`)).items,
    enabled: !!ws,
    staleTime: 15_000,
  });
}

export const launchEmulator = (ws: string, emu: string) =>
  post<{ ok: boolean }>(`/api/cockpit/ws/${e(ws)}/emulators/${e(emu)}/launch`, {});
