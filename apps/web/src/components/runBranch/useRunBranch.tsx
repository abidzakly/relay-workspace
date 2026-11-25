import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { RunBranchResult } from '@relay/shared';
import { ApiError } from '@/lib/api';
import {
  describeRunBranchError,
  staleIssue,
  usePrepareRunBranch,
  type RunBranchIssue,
} from '@/lib/runBranchApi';
import { RunBranchAlert } from './RunBranchAlert';

type Then = ((r: RunBranchResult) => void) | null;

interface Open {
  issue: RunBranchIssue;
  /** Set for a stale-copy warning: what "Use local copy" continues with. */
  result: RunBranchResult | null;
  /** The workspace a refusal named (dirty tree). */
  workspaceId: string | null;
}

function workspaceOf(e: unknown): string | null {
  if (!(e instanceof ApiError) || typeof e.details !== 'object' || e.details === null) return null;
  const id = (e.details as Record<string, unknown>).workspaceId;
  return typeof id === 'string' ? id : null;
}

/**
 * Puts the workspace on `branch` before something runs there. `ensure(then)` checks the branch out (fetching it when it
 * is not local) and calls `then` once it is ready. Any failure opens the alert dialog (`alert`), whose Retry runs the
 * same `then` again; a stale local copy (origin unreachable) asks before `then` runs.
 */
export function useRunBranch(repo: string, branch: string) {
  const prep = usePrepareRunBranch();
  const [open, setOpen] = useState<Open | null>(null);
  const then = useRef<Then>(null);

  const attempt = useCallback(
    (next: Then) => {
      then.current = next;
      prep.mutate(
        { repo, branch },
        {
          onSuccess: (r) => {
            if (r.fetchFailed) {
              setOpen({
                issue: staleIssue(r.fetchFailed, branch),
                result: r,
                workspaceId: r.workspaceId,
              });
              return;
            }
            setOpen(null);
            next?.(r);
          },
          onError: (e) =>
            setOpen({
              issue: describeRunBranchError(e, branch),
              result: null,
              workspaceId: workspaceOf(e),
            }),
        },
      );
    },
    // `prep.mutate` is stable across renders.
    [repo, branch],
  );

  const ensure = useCallback(
    (next?: (r: RunBranchResult) => void) => attempt(next ?? null),
    [attempt],
  );

  const alert: ReactNode = open ? (
    <RunBranchAlert
      repo={repo}
      branch={branch}
      issue={open.issue}
      workspaceId={open.workspaceId}
      busy={prep.isPending}
      onRetry={() => attempt(then.current)}
      onUseLocal={
        open.result
          ? () => {
              const r = open.result!;
              setOpen(null);
              then.current?.(r);
            }
          : null
      }
      onClose={() => setOpen(null)}
    />
  ) : null;

  return { ensure, preparing: prep.isPending, alert };
}
