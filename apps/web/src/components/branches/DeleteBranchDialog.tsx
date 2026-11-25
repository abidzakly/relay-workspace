import {
  ArrowUp,
  Check,
  CircleSlash,
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

function localBlock(row: BranchRow, hasWorkspace: boolean): string | null {
  if (!hasWorkspace) return 'No workspace on this Mac holds this repo.';
  if (!row.local) return 'Not on this Mac.';
  if (row.current) return 'Checked out right now: switch the workspace to another branch first.';
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
  gitlabOk,
  onClose,
}: {
  repo: string;
  row: BranchRow;
  hasWorkspace: boolean;
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

  const doLocal = local && lBlock === null;
  const doRemote = remote && rBlock === null;
  const needName = doRemote && row.mine !== true;
  const nameOk = !needName || typed.trim() === row.name;
  const unmerged =
    del.error instanceof ApiError && del.error.code === 'branch_unmerged'
      ? Number((del.error.details as { unique?: number } | undefined)?.unique ?? 0)
      : 0;
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
        ...(needName ? { confirmName: typed.trim() } : {}),
      },
      { onSuccess: setResult },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="rb-dialog max-w-xl gap-0 p-0 sm:p-0" data-tone="danger">
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
          <div className="grid gap-3 p-5 sm:px-8 sm:py-6">
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
          <div className="grid gap-4 p-5 sm:px-8 sm:py-6">
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
              <label className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {row.mine === false
                    ? `The last commit is by ${row.author ?? 'someone else'}.`
                    : 'Relay cannot tell whose branch this is.'}{' '}
                  Type <span className="font-mono text-foreground">{row.name}</span> to delete it on
                  origin.
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
            {del.error && unmerged === 0 && (
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
              {unmerged > 0 ? (
                <Button variant="destructive" onClick={() => submit(true)} disabled={busy}>
                  {busy ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Delete anyway
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
