import { GitFork, Loader2, Play, X } from 'lucide-react';
import { Link } from 'react-router';
import type { QueuedCardStart } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useCancelQueuedStart, useQueuedStartNow, useStartQueue } from '@/lib/workflowApi';

/**
 * Stacked card starts from a bulk start: each waits for its parent card's branch to be pushed, then starts from it.
 * Start one by hand (from the parent's branch as it is now), retry a failed one, or drop it.
 */
export function StartQueue({ className }: { className?: string }) {
  const q = useStartQueue();
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className={cn('grid grid-cols-1 gap-1', className)}>
      <p className="px-1 text-xs text-muted-foreground">Waiting to start</p>
      {items.map((it) => (
        <QueueItem key={it.id} it={it} />
      ))}
    </div>
  );
}

function QueueItem({ it }: { it: QueuedCardStart }) {
  const startNow = useQueuedStartNow();
  const cancel = useCancelQueuedStart();
  const busy = startNow.isPending || cancel.isPending || it.status === 'starting';
  const error = startNow.error ?? cancel.error;
  return (
    <div className="grid gap-1 rounded-lg border px-3 py-2 text-xs">
      <div className="flex min-w-0 items-start gap-2">
        <GitFork className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="grid min-w-0 flex-1">
          <span className="truncate font-medium" title={it.cardTitle}>
            {it.cardTitle}
          </span>
          <span className="truncate text-muted-foreground" title={it.parentBranch ?? undefined}>
            after &quot;{it.parentTitle}&quot;
          </span>
        </div>
        {it.status !== 'starting' && (
          <button
            type="button"
            aria-label={`Remove ${it.cardTitle} from the queue`}
            title={it.status === 'started' ? 'Dismiss' : 'Do not start it'}
            disabled={busy}
            onClick={() => cancel.mutate(it.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {it.status === 'queued' && (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-muted-foreground">Waits for its branch to be pushed.</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={busy}
            title="Start now from the parent's branch as it is"
            onClick={() => startNow.mutate({ id: it.id })}
          >
            <Play className="size-3" /> Start now
          </Button>
        </div>
      )}
      {it.status === 'starting' && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden /> Starting…
        </span>
      )}
      {it.status === 'started' && it.sessionId && (
        <Link
          to={`/cockpit?session=${encodeURIComponent(it.sessionId)}${it.startedWorkspaceId ? `&ws=${encodeURIComponent(it.startedWorkspaceId)}` : ''}`}
          className="text-primary-ink underline underline-offset-4"
        >
          Started: open →
        </Link>
      )}
      {it.status === 'failed' && (
        <>
          <p role="alert" className="text-destructive">
            {it.error ?? 'It could not start.'}
          </p>
          <div className="flex flex-wrap gap-1">
            {it.errorCode === 'branch_exists' ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  onClick={() => startNow.mutate({ id: it.id, existing: 'reuse' })}
                >
                  Use the existing branch
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  onClick={() => startNow.mutate({ id: it.id, existing: 'replace' })}
                >
                  Reset it to the parent
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={busy}
                onClick={() => startNow.mutate({ id: it.id })}
              >
                Try again
              </Button>
            )}
          </div>
        </>
      )}
      {error && <p className="text-destructive">{describeError(error)}</p>}
    </div>
  );
}
