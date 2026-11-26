import {
  ArrowUp,
  Check,
  CircleSlash,
  Copy,
  GitBranch,
  Laptop,
  Loader2,
  Server,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { BranchDeleteResult, BranchRow } from '@relay/shared';
import { isReservedBranch } from '@relay/shared';
import { DirtyTreePanel } from '@/cockpit/DirtyTreePanel';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, describeError } from '@/lib/api';
import { useDeleteBranch } from '@/lib/branchesApi';
import { cn } from '@/lib/utils';
import '@/components/runBranch/runBranch.css';
import './branches.css';

/** Why origin cannot be picked, or null when it can. */
function remoteBlock(row: BranchRow, gitlabOk: boolean, repo: string): ReactNode {
  if (isReservedBranch(row.name)) return 'Reserved branch: never deleted from Relay.';
  if (!row.remote) return 'Not on origin.';
  if (!gitlabOk) return 'GitLab cannot be reached right now.';
  if (row.protected) return 'Protected on GitLab.';
  if (row.mr) {
    return (
      <>
        <Link to={`/mrs/${encodeURIComponent(repo)}/${row.mr.iid}`} className="underline">
          !{row.mr.iid}
        </Link>{' '}
        is still open from it: merge or close it first.
      </>
    );
  }
  return null;
}

function CopyCommand({ command }: { command: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="db-cmd">
      <code>{command}</code>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          void navigator.clipboard?.writeText(command).then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1400);
          });
        }}
        aria-label="Copy the command"
      >
        {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

function localBlock(row: BranchRow, hasWorkspace: boolean): ReactNode {
  if (isReservedBranch(row.name)) return 'Reserved branch: never deleted from Relay.';
  if (!hasWorkspace) return 'No workspace on this Mac holds this repo.';
  if (!row.local) return 'Not on this Mac.';
  if (row.holder && !row.holder.managed) {
    return (
      <>
        Checked out in a worktree Relay did not make. Remove it on the Mac first:
        <CopyCommand command={`git worktree remove "${row.holder.path}"`} />
      </>
    );
  }
  return null;
}

function Target({
  icon: Icon,
  title,
  note,
  checked,
  blocked,
  danger,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  note: ReactNode;
  checked: boolean;
  blocked: ReactNode;
  danger?: boolean;
  onChange: (v: boolean) => void;
}) {
  const disabled = blocked !== null;
  return (
    <label
      className={cn('db-target', disabled && 'db-target-off')}
      data-on={checked && !disabled}
      data-danger={danger}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="db-check" aria-hidden>
        {checked && !disabled && <Check className="size-3" />}
      </span>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{disabled ? blocked : note}</span>
      </span>
    </label>
  );
}

const PART_LABEL: Record<string, string> = {
  deleted: 'Deleted',
  simulated: 'Simulated (dry-run): nothing deleted on GitLab',
  skipped: 'Left as is',
};

/**
 * Deletes a branch on this Mac, on origin, or both. Origin is refused for protected branches and open MRs, and asks
 * for the typed name when the branch is not the user's. A local branch with commits no other branch has asks again.
 */
export function DeleteBranchDialog({
  repo,
  row,
  hasWorkspace,
  workspaceId,
  base,
  gitlabOk,
  onClose,
}: {
  repo: string;
  row: BranchRow;
  hasWorkspace: boolean;
  /** The repo workspace on the Mac (to clear its tree before switching off the branch). */
  workspaceId: string | null;
  base: string;
  gitlabOk: boolean;
  onClose: () => void;
}) {
  const del = useDeleteBranch();
  const lBlock = localBlock(row, hasWorkspace);
  const rBlock = remoteBlock(row, gitlabOk, repo);
  const [local, setLocal] = useState(lBlock === null);
  const [remote, setRemote] = useState(false);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<BranchDeleteResult | null>(null);
  // The branch is held (checked out here, or in a Relay worktree): free it first. Required to delete locally.
  const [freeIt, setFreeIt] = useState(true);

  const held = row.current || !!row.holder?.managed;
  const doLocal = local && lBlock === null && (!held || freeIt);
  const doRemote = remote && rBlock === null;
  // Someone else's branch (or one Relay cannot place) needs its name typed, on the Mac as on origin.
  const needName = (doLocal || doRemote) && row.mine !== true;
  const nameOk = !needName || typed.trim() === row.name;
  const unmerged =
    del.error instanceof ApiError && del.error.code === 'branch_unmerged'
      ? Number((del.error.details as { unique?: number } | undefined)?.unique ?? 0)
      : 0;
  const code = del.error instanceof ApiError ? del.error.code : null;
  const dirtyWorktree =
    code === 'worktree_dirty'
      ? Number(
          (del.error as ApiError).details &&
            ((del.error as ApiError).details as { count?: number }).count,
        )
      : null;
  const wsDirty = code === 'ws_dirty';
  const ahead = row.track?.ahead ?? 0;
  const busy = del.isPending;

  const submit = (force: boolean) =>
    del.mutate(
      {
        repo,
        branch: row.name,
        local: doLocal,
        remote: doRemote,
        force,
        removeWorktree: doLocal && !!row.holder?.managed,
        ...(doLocal && row.current ? { switchTo: base } : {}),
        ...(needName ? { confirmName: typed.trim() } : {}),
      },
      { onSuccess: setResult },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        // Hero and footer stay put; the body scrolls on a short window, so Delete is always reachable.
        className="rb-dialog max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:p-0"
        data-tone="danger"
      >
        <div className="rb-hero">
          <div className="rb-hero-glow" aria-hidden />
          <div className="rb-hero-grid" aria-hidden />
          <div className="relative flex items-start gap-4">
            <span className="rb-beacon" aria-hidden>
              <span className="rb-beacon-core">
                {busy ? (
                  <Loader2 className="size-6 motion-safe:animate-spin" />
                ) : (
                  <Trash2 className="size-6" />
                )}
              </span>
            </span>
            <div className="grid min-w-0 gap-2 pt-0.5">
              <p className="type-micro rb-eyebrow">Delete branch</p>
              <DialogTitle className="text-xl sm:text-2xl">
                {result ? 'Done' : 'Where should it go?'}
              </DialogTitle>
              <span className="rb-chip" title={row.name}>
                <GitBranch aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{row.name}</span>
              </span>
            </div>
          </div>
        </div>

        {result ? (
          <div className="grid min-h-0 content-start gap-3 overflow-y-auto overscroll-contain p-5 sm:px-8 sm:py-6">
            <DialogDescription className="sr-only">What was deleted</DialogDescription>
            {(['local', 'remote'] as const).map((k) => {
              const part = result[k];
              return (
                <p key={k} className="flex items-start gap-2 text-sm">
                  {part.state === 'failed' ? (
                    <TriangleAlert
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-destructive"
                    />
                  ) : part.state === 'skipped' ? (
                    <CircleSlash
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  )}
                  <span>
                    <span className="font-medium">{k === 'local' ? 'This Mac' : 'Origin'}:</span>{' '}
                    {part.state === 'failed' ? part.message : PART_LABEL[part.state]}
                  </span>
                </p>
              );
            })}
            {result.local.state === 'deleted' && result.sha && (
              <p className="text-xs text-muted-foreground">
                Changed your mind? On the Mac:{' '}
                <code className="font-mono">
                  git branch {row.name} {result.sha.slice(0, 12)}
                </code>
              </p>
            )}
          </div>
        ) : (
          <div className="grid min-h-0 content-start gap-4 overflow-y-auto overscroll-contain p-5 sm:px-8 sm:py-6">
            <DialogDescription className="text-sm text-foreground/85">
              Last commit{row.subject ? <> “{row.subject}”</> : null}
              {row.author ? <> by {row.author}</> : null}, <TimeAgo at={row.committedAt} />.
            </DialogDescription>

            <div className="grid gap-2">
              <Target
                icon={Laptop}
                title="On this Mac"
                note={
                  ahead > 0 ? (
                    <span className="text-warning">
                      <ArrowUp aria-hidden className="inline size-3" /> {ahead} commit
                      {ahead > 1 ? 's' : ''} not pushed: they go with it.
                    </span>
                  ) : row.remote ? (
                    'The local branch only. Origin keeps its copy.'
                  ) : (
                    'This is the only copy: it is not on origin.'
                  )
                }
                checked={local}
                blocked={lBlock}
                onChange={setLocal}
              />
              {local && lBlock === null && held && (
                <label className="db-sub" data-on={freeIt}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={freeIt}
                    onChange={(e) => setFreeIt(e.target.checked)}
                  />
                  <span className="db-check" aria-hidden>
                    {freeIt && <Check className="size-3" />}
                  </span>
                  <span className="grid min-w-0 gap-0.5 text-xs">
                    {row.current ? (
                      <>
                        <span className="text-sm font-medium">
                          Switch the workspace to <span className="font-mono">{base}</span> first
                        </span>
                        <span className="text-muted-foreground">
                          It is checked out right now. Uncommitted changes stop the switch: you can
                          keep or set them aside.
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-medium">
                          Also remove its worktree{' '}
                          <span className="font-mono">{row.holder!.name}</span>
                        </span>
                        <span className="truncate text-muted-foreground" title={row.holder!.path}>
                          {row.holder!.path}
                        </span>
                      </>
                    )}
                  </span>
                </label>
              )}
              <Target
                icon={Server}
                title="On origin (GitLab)"
                note="Deletes it for everyone. This can’t be undone from Relay."
                checked={remote}
                blocked={rBlock}
                danger
                onChange={(v) => {
                  setRemote(v);
                  setTyped('');
                }}
              />
            </div>

            {needName && (
              <label className="db-unmerged flex-col gap-2" role="alert">
                <span className="flex gap-2">
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {row.mine === false ? (
                      <>
                        <b>This isn&rsquo;t your branch.</b> Its last commit is by{' '}
                        {row.author ?? 'someone else'}
                        {row.authorEmail ? ` (${row.authorEmail})` : ''}.
                      </>
                    ) : (
                      <b>Relay cannot tell whose branch this is.</b>
                    )}{' '}
                    Type <span className="font-mono">{row.name}</span> to delete it
                    {doRemote ? ' on origin too, for everyone' : ' on this Mac'}.
                  </span>
                </span>
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={row.name}
                  aria-label="Type the branch name to confirm"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn('font-mono', typed && !nameOk && 'border-destructive')}
                />
              </label>
            )}

            {unmerged > 0 && (
              <p className="db-unmerged" role="alert">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>
                  {unmerged} commit{unmerged > 1 ? 's are' : ' is'} on no other branch, local or
                  remote. Deleting loses {unmerged > 1 ? 'them' : 'it'} for good.
                </span>
              </p>
            )}
            {dirtyWorktree !== null && (
              <p className="db-unmerged" role="alert">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>
                  {dirtyWorktree > 0
                    ? `${dirtyWorktree} uncommitted change${dirtyWorktree > 1 ? 's' : ''} in ${row.holder?.name ?? 'the worktree'} will be lost with it.`
                    : `Relay could not read ${row.holder?.name ?? 'the worktree'}: whatever is uncommitted there is lost with it.`}
                </span>
              </p>
            )}
            {wsDirty && workspaceId && (
              <DirtyTreePanel
                key={workspaceId}
                purpose="checkout"
                target={base}
                workspaceId={workspaceId}
                disabled={busy}
                onCleared={() => submit(false)}
              />
            )}
            {del.error && unmerged === 0 && dirtyWorktree === null && !wsDirty && (
              <p className="text-sm text-destructive">{describeError(del.error)}</p>
            )}
          </div>
        )}

        <DialogFooter className="rb-footer">
          {result ? (
            <Button onClick={onClose} autoFocus>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              {unmerged > 0 || dirtyWorktree !== null ? (
                <Button variant="destructive" onClick={() => submit(true)} disabled={busy}>
                  {busy ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {dirtyWorktree !== null ? 'Remove and delete anyway' : 'Delete anyway'}
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  onClick={() => submit(false)}
                  disabled={busy || (!doLocal && !doRemote) || !nameOk}
                >
                  {busy ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {doLocal && doRemote
                    ? 'Delete in both'
                    : doRemote
                      ? 'Delete on origin'
                      : 'Delete on this Mac'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
