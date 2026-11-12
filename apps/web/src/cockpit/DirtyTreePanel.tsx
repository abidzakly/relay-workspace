import { useMemo, useState, type CSSProperties } from 'react';
import type { DiffFile } from '@relay/shared';
import { Archive, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { useCleanTree, useWsWorkingDiff, type CleanTreeMode } from '@/lib/cockpitApi';
import { cn } from '@/lib/utils';
import { DiffFileView, type CommentSlots } from '@/review/DiffFile';
import { parseDiff, type Hunk } from '@/review/parseDiff';
import '@/review/review.css';

const NO_COMMENTS: CommentSlots = {
  canComment: false,
  renderThreads: () => null,
  renderComposer: () => null,
};

/** The diff scrolls in its own box, so its file header sticks to the top of that box. */
const DIFF_BOX_STYLE = { '--rv-top': '0px' } as CSSProperties;

const KIND: Record<DiffFile['kind'], { mark: string; cls: string; label: string }> = {
  added: { mark: 'A', cls: 'text-success', label: 'Added' },
  deleted: { mark: 'D', cls: 'text-destructive', label: 'Deleted' },
  renamed: { mark: 'R', cls: 'text-primary-ink', label: 'Renamed' },
  modified: { mark: 'M', cls: 'text-muted-foreground', label: 'Modified' },
};

const noop = () => undefined;

/**
 * Shown in the Start dialog when the workspace has uncommitted changes (`ws_dirty`): lists the changed files, shows the
 * diff of the one picked, and offers to stash or discard them before the card starts.
 */
export function DirtyTreePanel({
  workspaceId,
  disabled,
  onCleared,
}: {
  workspaceId: string;
  disabled: boolean;
  /** The tree is clean now: start the card again. */
  onCleared: (mode: CleanTreeMode) => void;
}) {
  const diff = useWsWorkingDiff(workspaceId);
  const clean = useCleanTree();
  const [selected, setSelected] = useState<string | null>(null);
  const files = useMemo(() => diff.data?.files ?? [], [diff.data?.files]);
  const picked = files.find((f) => f.path === selected) ?? null;
  const hunks = useMemo<Hunk[]>(() => (picked?.diff ? parseDiff(picked.diff) : []), [picked?.diff]);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const pending = disabled || clean.isPending;

  const run = (mode: CleanTreeMode) => {
    if (
      mode === 'discard' &&
      !window.confirm(
        `Discard all uncommitted changes in ${files.length} ${files.length === 1 ? 'file' : 'files'}? Edited files go back to HEAD and new files are deleted. This cannot be undone.`,
      )
    )
      return;
    clean.mutate({ workspaceId, mode }, { onSuccess: () => onCleared(mode) });
  };

  return (
    <section className="grid min-w-0 gap-2 rounded-xl border border-destructive/40 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">The workspace has uncommitted changes</h3>
          <p className="text-xs text-muted-foreground">
            A card starts on a clean tree. Stash the changes to keep them in{' '}
            <span className="font-mono">git stash</span>, or discard them.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2"
          disabled={diff.isFetching}
          onClick={() => void diff.refetch()}
          aria-label="Reload the changes"
          title="Reload the changes"
        >
          <RefreshCw className={cn('size-3.5', diff.isFetching && 'motion-safe:animate-spin')} />
        </Button>
      </div>

      {diff.isPending ? (
        <Loader2 className="size-4 motion-safe:animate-spin" aria-label="Loading the changes" />
      ) : diff.error ? (
        <p className="text-xs text-destructive">{describeError(diff.error)}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            {files.length} {files.length === 1 ? 'file' : 'files'} ·{' '}
            <span className="text-success">+{additions}</span>{' '}
            <span className="text-destructive">−{deletions}</span>
          </p>
          <ul className="grid max-h-44 gap-0.5 overflow-y-auto" aria-label="Changed files">
            {files.map((f) => {
              const k = KIND[f.kind];
              const on = f.path === selected;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelected(on ? null : f.path)}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left',
                      on ? 'bg-primary/10' : 'hover:bg-accent/50',
                    )}
                  >
                    <span
                      className={cn('w-3 shrink-0 font-mono text-xs font-semibold', k.cls)}
                      title={k.label}
                    >
                      {k.mark}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs [direction:rtl] text-left"
                      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                    >
                      <bdi>{f.path}</bdi>
                    </span>
                    <span className="shrink-0 font-mono text-2xs tabular-nums">
                      <span className="text-success">+{f.additions}</span>{' '}
                      <span className="text-destructive">−{f.deletions}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {picked ? (
            <div
              className="max-h-[45vh] min-w-0 overflow-auto rounded-lg border"
              style={DIFF_BOX_STYLE}
            >
              {picked.binary || picked.tooLarge ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {picked.binary ? 'Binary file: no diff to show.' : 'Too large to show here.'}
                </p>
              ) : (
                <DiffFileView
                  anchorId={`dirty-tree-${encodeURIComponent(picked.path)}`}
                  file={picked}
                  hunks={hunks}
                  mode="inline"
                  wrap
                  collapsed={false}
                  viewed={false}
                  onToggle={() => setSelected(null)}
                  onViewed={noop}
                  threads={undefined}
                  slots={NO_COMMENTS}
                  reveal
                />
              )}
            </div>
          ) : (
            files.length > 0 && (
              <p className="text-2xs text-muted-foreground">Pick a file to see what changed.</p>
            )
          )}
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={pending || diff.isPending}
          onClick={() => run('stash')}
        >
          {clean.isPending && clean.variables?.mode === 'stash' ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Archive className="size-4" />
          )}
          Stash & start
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1 text-destructive"
          disabled={pending || diff.isPending}
          onClick={() => run('discard')}
        >
          {clean.isPending && clean.variables?.mode === 'discard' ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
          Discard & start
        </Button>
      </div>
      {clean.error && <p className="text-xs text-destructive">{describeError(clean.error)}</p>}
    </section>
  );
}
