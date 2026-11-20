import { useMemo, useState, type CSSProperties } from 'react';
import type { DiffFile } from '@relay/shared';
import {
  Archive,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  Sparkles,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { Textarea } from '@/components/ui/textarea';
import {
  useCleanTree,
  useCommitMessage,
  useWsCommit,
  useWsWorkingDiff,
  type CleanTreeMode,
} from '@/lib/cockpitApi';
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

export type DirtyTreeOutcome = CleanTreeMode | 'commit' | 'amend';

/**
 * Shown when the workspace has uncommitted changes: lists the changed files, shows the diff of the one picked, and
 * clears the tree.
 *  - `start` (Start dialog, Make more changes, on `ws_dirty`): stash or discard, then the action runs again.
 *  - `mr` (Create MR): keep the changes as a new commit (message typed or written by AI) or amended into the branch's
 *    last commit, or revert them (stash / discard).
 *  - `checkout` (Test bench, switching to `target`): same choices as `mr`, made on the branch checked out now; amend
 *    only when `lastCommit` is given. Then the checkout runs again.
 */
export function DirtyTreePanel({
  workspaceId,
  disabled,
  onCleared,
  purpose = 'start',
  lastCommit = null,
  target,
}: {
  workspaceId: string;
  disabled: boolean;
  /** The tree is clean now: run the action again (or refresh). */
  onCleared: (mode: DirtyTreeOutcome) => void;
  purpose?: 'start' | 'mr' | 'checkout';
  /** `mr`: the branch's newest own commit, what "amend" changes. null = none, so no amend. */
  lastCommit?: { sha: string; subject: string } | null;
  /** `checkout`: the branch the workspace switches to once the tree is clean. */
  target?: string;
}) {
  const diff = useWsWorkingDiff(workspaceId);
  const clean = useCleanTree();
  const commit = useWsCommit();
  const aiMessage = useCommitMessage();
  const [keep, setKeep] = useState<'commit' | 'amend' | null>(null);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const files = useMemo(() => diff.data?.files ?? [], [diff.data?.files]);
  const picked = files.find((f) => f.path === selected) ?? null;
  const hunks = useMemo<Hunk[]>(() => (picked?.diff ? parseDiff(picked.diff) : []), [picked?.diff]);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const pending = disabled || clean.isPending || commit.isPending;
  const forMr = purpose === 'mr';
  const forCheckout = purpose === 'checkout';
  const canKeep = forMr || forCheckout;
  const verb = forMr ? '' : forCheckout ? ' & check out' : ' & start';

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

  const writeWithAi = () =>
    aiMessage.mutate({ workspaceId }, { onSuccess: (r) => setMessage(r.message) });

  const doCommit = (amend: boolean) => {
    if (
      amend &&
      !window.confirm(
        `Amend ${files.length} ${files.length === 1 ? 'file' : 'files'} into "${lastCommit?.subject ?? 'the last commit'}"? Its message stays the same.`,
      )
    )
      return;
    commit.mutate(
      { workspaceId, amend, ...(amend ? {} : { message: message.trim() }) },
      {
        onSuccess: () => {
          setKeep(null);
          setMessage('');
          onCleared(amend ? 'amend' : 'commit');
        },
      },
    );
  };

  return (
    <section className="grid min-w-0 gap-2 rounded-xl border border-destructive/40 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">The workspace has uncommitted changes</h3>
          {forMr ? (
            <p className="text-xs text-muted-foreground">
              The MR is made from commits only. Keep these changes as a commit, or revert them.
            </p>
          ) : forCheckout ? (
            <p className="text-xs text-muted-foreground wrap-anywhere">
              Switching to <span className="font-mono">{target}</span> needs a clean tree. Commit
              the changes on the current branch, or stash or discard them.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              A card starts on a clean tree. Stash the changes to keep them in{' '}
              <span className="font-mono">git stash</span>, or discard them.
            </p>
          )}
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

      {canKeep && (
        <div className="grid gap-2">
          <p className="type-micro text-muted-foreground">Keep the changes</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={keep === 'commit' ? 'default' : 'outline'}
              className="flex-1"
              disabled={pending || diff.isPending || files.length === 0}
              aria-pressed={keep === 'commit'}
              onClick={() => setKeep(keep === 'commit' ? null : 'commit')}
            >
              <GitCommitHorizontal className="size-4" />
              New commit
            </Button>
            {(forMr || lastCommit) && (
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={pending || diff.isPending || files.length === 0 || !lastCommit}
                title={
                  lastCommit
                    ? `Fold the changes into "${lastCommit.subject}"`
                    : 'The branch has no commit of its own to amend'
                }
                onClick={() => doCommit(true)}
              >
                {commit.isPending && commit.variables?.amend ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <SquarePen className="size-4" />
                )}
                Amend last commit
              </Button>
            )}
          </div>
          {lastCommit && (
            <p className="text-2xs text-muted-foreground wrap-anywhere">
              Last commit: <span className="font-mono">{lastCommit.sha.slice(0, 8)}</span>{' '}
              {lastCommit.subject}
            </p>
          )}
          {keep === 'commit' && (
            <div className="grid gap-2 rounded-lg border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={`commit-msg-${workspaceId}`} className="text-xs font-medium">
                  Commit message
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  disabled={pending || aiMessage.isPending}
                  onClick={writeWithAi}
                >
                  {aiMessage.isPending ? (
                    <Loader2 className="size-3.5 motion-safe:animate-spin" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                  Write with AI
                </Button>
              </div>
              <Textarea
                id={`commit-msg-${workspaceId}`}
                value={message}
                onChange={(ev) => setMessage(ev.target.value)}
                rows={4}
                maxLength={10_000}
                disabled={pending || aiMessage.isPending}
                placeholder="feat(scope): what changed and why"
                className="font-mono text-xs"
              />
              {aiMessage.error && (
                <p className="text-xs text-destructive">{describeError(aiMessage.error)}</p>
              )}
              <Button
                type="button"
                disabled={pending || !message.trim()}
                onClick={() => doCommit(false)}
              >
                {commit.isPending && !commit.variables?.amend ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <GitCommitHorizontal className="size-4" />
                )}
                Commit {files.length} {files.length === 1 ? 'file' : 'files'}
              </Button>
            </div>
          )}
          <p className="type-micro text-muted-foreground">Or revert them</p>
        </div>
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
          Stash{verb}
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
          Discard{verb}
        </Button>
      </div>
      {clean.error && <p className="text-xs text-destructive">{describeError(clean.error)}</p>}
      {commit.error && <p className="text-xs text-destructive">{describeError(commit.error)}</p>}
    </section>
  );
}
