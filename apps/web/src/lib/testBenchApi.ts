import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcCheck,
  AcState,
  CursorTestModel,
  DeviceControl,
  DeviceList,
  Finding,
  FindingInput,
  FindingPatch,
  OpenBench,
  TestBenchState,
  TestRun,
  TestRunEngine,
} from '@relay/shared';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '@relay/shared';
import { del, get, patch, post, put } from './api';

/** Test Bench + device bridge. SSE `testbench.changed` refreshes `testBenchKeys.branch`. */
export const testBenchKeys = {
  branch: (repo: string, branch: string) => ['test-bench', repo, branch] as const,
  devices: ['devices'] as const,
  /** Opened, unfinished benches (sidebar "Continue testing"). Its own root so a repo id never collides. */
  open: ['test-bench-open'] as const,
};
const e = encodeURIComponent;

export function useTestBench(repo: string, branch: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: testBenchKeys.branch(repo, branch),
    queryFn: async () => {
      const st = await get<TestBenchState>(`/api/test-bench?repo=${e(repo)}&branch=${e(branch)}`);
      // Reading the bench lists it under "Continue testing".
      void qc.invalidateQueries({ queryKey: testBenchKeys.open });
      return st;
    },
    staleTime: 30_000,
  });
}

export function useOpenBenches() {
  return useQuery({
    queryKey: testBenchKeys.open,
    queryFn: () => get<OpenBench[]>('/api/test-bench/open'),
    staleTime: 60_000,
  });
}

export function useDismissBench() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repo: string; branch: string }) =>
      post<{ ok: true }>('/api/test-bench/open/dismiss', v),
    onSettled: () => qc.invalidateQueries({ queryKey: testBenchKeys.open }),
  });
}

/** Re-reads the card body from Notion now (not only when Notion says it changed). */
export async function refreshBody(repo: string, branch: string): Promise<TestBenchState> {
  return get<TestBenchState>(`/api/test-bench?repo=${e(repo)}&branch=${e(branch)}&refresh=1`);
}

function useBenchMutation<TVars, TOut>(
  repo: string,
  branch: string,
  fn: (v: TVars) => Promise<TOut>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: testBenchKeys.branch(repo, branch) }),
  });
}

/** Optimistic tick: the box moves at once, rolls back if the server refuses. */
export function useSetCheck(repo: string, branch: string) {
  const qc = useQueryClient();
  const key = testBenchKeys.branch(repo, branch);
  return useMutation({
    mutationFn: (v: { target: string; state: AcState; note?: string }) =>
      put<AcCheck>('/api/test-bench/check', {
        repo,
        branch,
        target: v.target,
        state: v.state,
        note: v.note ?? '',
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TestBenchState>(key);
      if (prev?.card) {
        const others = prev.checks.filter((c) => c.target !== v.target);
        const tick: AcCheck = {
          cardId: prev.card.id,
          target: v.target,
          state: v.state,
          by: 'human',
          runId: null,
          verifiedSha: prev.headSha,
          note: v.note ?? '',
          evidencePath: null,
          updatedAt: Date.now(),
        };
        qc.setQueryData<TestBenchState>(key, { ...prev, checks: [...others, tick] });
      }
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useAddFinding(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (finding: FindingInput) =>
    post<Finding>('/api/test-bench/findings', { repo, branch, finding }),
  );
}
export function useUpdateFinding(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (v: { id: string; patch: FindingPatch }) =>
    patch<Finding>(`/api/test-bench/findings/${e(v.id)}`, v.patch),
  );
}
export function useDeleteFinding(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (id: string) =>
    del<{ ok: true }>(`/api/test-bench/findings/${e(id)}`),
  );
}
export function useSetFigma(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (url: string | null) =>
    put<{ ok: true }>('/api/test-bench/figma', { repo, branch, url }),
  );
}
export function useSetFrame(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (v: { acKey: string; nodeId: string | null }) =>
    put<{ ok: true }>('/api/test-bench/frame', { repo, branch, ...v }),
  );
}
export function useFinish(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (v: { verdict: 'ready' | 'not_ready'; summary: string }) =>
    post<TestRun>('/api/test-bench/finish', { repo, branch, ...v }),
  );
}

/** Sends open findings (or the given ones) to the repo's agent; they move to "fixing". */
export function useFixWithAi(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (findingIds?: string[]) =>
    post<{ workspaceId: string; sessionId: string; findings: number; returnTo: string }>(
      '/api/test-bench/fix',
      {
        repo,
        branch,
        ...(findingIds?.length ? { findingIds } : {}),
      },
    ),
  );
}

// ── AI device test (D3)

export function useStartAiRun(repo: string, branch: string) {
  return useBenchMutation(
    repo,
    branch,
    (v: { serial: string; engine: TestRunEngine; cursorModel: CursorTestModel }) =>
      post<TestRun>('/api/test-bench/ai-run', { repo, branch, ...v }),
  );
}
export function useResumeAiRun(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (runId: string) =>
    post<TestRun>(`/api/test-bench/ai-run/${e(runId)}/resume`),
  );
}
export function useStopAiRun(repo: string, branch: string) {
  return useBenchMutation(repo, branch, (runId: string) =>
    post<TestRun>(`/api/test-bench/ai-run/${e(runId)}/stop`),
  );
}
export function useAiRunSession(runId: string | null) {
  return useQuery({
    queryKey: ['test-bench', 'ai-session', runId],
    queryFn: () =>
      get<{
        sessionId: string | null;
        workspaceId: string | null;
        flutterSessionId: string | null;
      }>(`/api/test-bench/ai-run/${e(runId!)}/session`),
    enabled: !!runId,
    staleTime: 60_000,
  });
}
export const evidenceUrl = (path: string) =>
  `/api/test-bench/evidence/${path.split('/').map(e).join('/')}`;

// ── devices

export function useDeviceList() {
  return useQuery({
    queryKey: testBenchKeys.devices,
    queryFn: () => get<DeviceList>('/api/devices'),
    refetchInterval: 5_000,
  });
}

/** Fire-and-forget input; the caller batches per animation frame. */
export async function sendControl(serial: string, events: DeviceControl[]): Promise<void> {
  await post<{ ok: true }>(`/api/devices/${e(serial)}/control`, { events });
}

/** The raw mirror response (binary frames, see `MirrorFrameKind`). Not JSON, so not through `api()`. */
export async function openMirror(
  serial: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`/api/devices/${e(serial)}/mirror`, {
    signal,
    headers: { accept: 'application/octet-stream', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  if (!res.ok || !res.body) {
    let message = `The mirror could not start (${res.status}).`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.body;
}

export const screenshotUrl = (serial: string) =>
  `/api/devices/${e(serial)}/screenshot?t=${Date.now()}`;
