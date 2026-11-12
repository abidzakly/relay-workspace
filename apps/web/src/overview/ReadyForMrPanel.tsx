import { GitPullRequestCreate, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ReadyForMr } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { mrCreatePath, useReadyForMr, useRefreshReady } from '@/lib/mrCreateApi';
import { Panel } from './Panel';

/** Stacks first-seen order; inside a stack the parent (#1) at the bottom, like the MR lists. */
export function groupReady(items: readonly ReadyForMr[]): ReadyForMr[][] {
  const groups = new Map<string, ReadyForMr[]>();
  for (const it of items) {
    const id = it.stack && it.stack.size > 1 ? it.stack.groupId : `${it.repoId}:${it.branch}`;
    const g = groups.get(id);
    if (g) g.push(it);
    else groups.set(id, [it]);
  }
  return [...groups.values()].map((g) =>
    g.sort((a, b) => (b.stack?.position ?? 1) - (a.stack?.position ?? 1)),
  );
}

function waitLabel(it: ReadyForMr): string | null {
  const st = it.stack;
  if (!st) return null;
  if (st.parentIid !== null) return `stacked on !${st.parentIid}`;
  if (st.parentBranch && !st.parentHasMr) return `parent ${st.parentBranch} has no MR yet`;
  return null;
}

function Row({ it, inStack }: { it: ReadyForMr; inStack: boolean }) {
  const wait = waitLabel(it);
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-t border-hairline py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {inStack && it.stack && (
          <Badge variant={it.stack.position === 1 ? 'success' : 'outline'}>
            #{it.stack.position}
          </Badge>
        )}
        <span className="truncate">{it.repoName}</span>
        <span className="ml-auto shrink-0">
          <TimeAgo at={it.pushedAt} />
        </span>
      </div>
      <span className="font-mono text-sm [overflow-wrap:anywhere]">{it.branch}</span>
      <span className="truncate text-xs text-muted-foreground" title={it.card.title}>
        {it.card.title}
        {it.card.status ? ` [${it.card.status}]` : ''}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {it.commitCount !== null && (
          <Badge variant="outline">
            {it.commitCount} commit{it.commitCount === 1 ? '' : 's'}
          </Badge>
        )}
        {wait && <Badge variant="warning">{wait}</Badge>}
        <Button asChild size="sm" className="ml-auto">
          <Link to={mrCreatePath(it.repoId, it.branch)}>
            <GitPullRequestCreate className="size-4" /> Create MR
          </Link>
        </Button>
      </div>
    </li>
  );
}

/** "Ready for MR": pushed branches = a card's Branch formula, no MR yet. */
export function ReadyForMrPanel({
  className,
  hideWhenEmpty,
}: {
  className?: string;
  hideWhenEmpty?: boolean;
}) {
  const q = useReadyForMr();
  const refresh = useRefreshReady();
  const groups = useMemo(() => groupReady(q.data?.items ?? []), [q.data]);
  if (hideWhenEmpty && (q.data?.items.length ?? 0) === 0) return null;
  return (
    <Panel
      n={3}
      title="Ready for an MR"
      context="Branch pushed, no MR yet"
      className={className}
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          aria-label="Re-check branches in GitLab"
        >
          <RefreshCw className={refresh.isPending ? 'size-4 motion-safe:animate-spin' : 'size-4'} />
        </Button>
      }
    >
      {q.error && <p className="text-sm text-destructive">{describeError(q.error)}</p>}
      {q.data && q.data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">No branch is waiting for an MR.</p>
      )}
      <ul className="grid">
        {groups.map((g) =>
          g.length === 1 ? (
            <Row key={`${g[0]!.repoId}:${g[0]!.branch}`} it={g[0]!} inStack={false} />
          ) : (
            <li key={g[0]!.stack!.groupId} className="border-l-2 border-foreground pl-3">
              <p className="pb-2 type-micro text-muted-foreground">
                Stack · create the parent MR first (at the bottom)
              </p>
              <ol className="grid gap-2">
                {g.map((it) => (
                  <Row key={it.branch} it={it} inStack />
                ))}
              </ol>
            </li>
          ),
        )}
      </ul>
    </Panel>
  );
}
