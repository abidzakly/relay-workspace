import {
  Check,
  CircleSlash,
  GitBranch,
  Laptop,
  Loader2,
  RotateCcw,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type {
  BranchBulkDeleteResult,
  BranchBulkItem,
  BranchListResult,
  BranchRow,
} from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/api';
import { useDeleteManyBranches } from '@/lib/branchesApi';
import { cn } from '@/lib/utils';
import '@/components/runBranch/runBranch.css';
import './branches.css';

interface Opts {
  local: boolean;
  remote: boolean;
  removeWorktree: boolean;
  switchBase: boolean;
}

interface Line {
  row: BranchRow;
  /** Where it will go; empty = skipped. */
  where: ('mac' | 'origin')[];
  /** Why a place is left out (or the whole branch). */
  notes: string[];
  needsPhrase: boolean;
}

/** What the server will do with each branch, from the rows already on screen (the server checks again). */
function planOf(rows: BranchRow[], o: Opts, hasWorkspace: boolean, gitlabOk: boolean): Line[] {
  return rows.map((row) => {
    const where: Line['where'] = [];
    const notes: string[] = [];
    let needsPhrase = false;
    if (o.local && row.local) {
      if (!hasWorkspace) notes.push('no workspace on this Mac');
      else if (row.holder && !row.holder.managed)
        notes.push(`hand-made worktree ${row.holder.name}`);
      else if (row.holder && !o.removeWorktree) notes.push(`held by worktree ${row.holder.name}`);
      else if (row.current && !o.switchBase) notes.push('checked out in the workspace');
      else where.push('mac');
    }
    if (o.remote && row.remote) {
      if (!gitlabOk) notes.push('GitLab unreachable');
      else if (row.protected) notes.push('protected');
      else if (row.mr) notes.push(`open MR !${row.mr.iid}`);
      else {
        where.push('origin');
        if (row.mine !== true) needsPhrase = true;
      }
    }
    if (where.length === 0 && notes.length === 0) {
      notes.push(
        o.local && !o.remote
          ? 'not on this Mac'
          : !o.local && o.remote
            ? 'not on origin'
            : 'nothing to delete',
      );
    }
    return { row, where, notes, needsPhrase };
  });
}

function Toggle({
  checked,
  onChange,
  danger,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="db-target" data-on={checked} data-danger={danger}>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="db-check" aria-hidden>
        {checked && <Check className="size-3" />}
      </span>
      <span className="grid min-w-0 gap-0.5">{children}</span>
    </label>
  );
}

const STATE_ICON = {
  done: <Check aria-hidden className="size-3.5 shrink-0 text-success" />,
  skipped: <CircleSlash aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  failed: <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-destructive" />,
};

function resultText(i: BranchBulkItem): string {
  if (i.state !== 'done' || !i.result) return i.message ?? i.state;
  const parts: string[] = [];
  const { local, remote } = i.result;
  if (local.state === 'deleted') parts.push('deleted on this Mac');
  if (remote.state === 'deleted') parts.push('deleted on origin');
  if (remote.state === 'simulated') parts.push('origin: simulated (dry-run)');
  return parts.join(' · ') || 'nothing changed';
}

/**
 * Deletes the selected branches. Shows, per branch, where it will go and what keeps it — before anything runs — then
 * the outcome per branch, with a retry for those that need force (unmerged commits, a dirty worktree).
 */
export function BulkDeleteDialog({
  repo,
  list,
  names,
  onClose,
}: {
  repo: string;
  list: BranchListResult;
  names: string[];
  /** `done`: something was deleted, the selection can go. */
  onClose: (done: boolean) => void;
}) {
  const del = useDeleteManyBranches();
  const [o, setO] = useState<Opts>({
    local: true,
    remote: false,
    removeWorktree: false,
    switchBase: false,
  });
  const [phrase, setPhrase] = useState('');
  const [result, setResult] = useState<BranchBulkDeleteResult | null>(null);
  const rows = useMemo(
    () => names.map((n) => list.rows.find((r) => r.name === n)).filter((r): r is BranchRow => !!r),
    [names, list.rows],
  );
  const plan = planOf(rows, o, !!list.workspaceId, list.sources.remote.ok);
  const going = plan.filter((l) => l.where.length > 0);
  const phraseNeeded = going.some((l) => l.needsPhrase);
  const want = `delete ${going.length} branches`;
  const phraseOk = !phraseNeeded || phrase.trim() === want;
  const anyHeld = rows.some((r) => r.holder?.managed);
  const anyCurrent = rows.some((r) => r.current);
  const busy = del.isPending;
  const forceable = result?.items.filter((i) => i.forceable) ?? [];

  const run = (branches: string[], force: boolean) => {
    // Branches the plan left out are reported too, so the outcome covers the whole selection.
    const leftOut: BranchBulkItem[] = plan
      .filter((l) => l.where.length === 0)
      .map((l) => ({
        branch: l.row.name,
        state: 'skipped',
        code: 'not_planned',
        message: l.notes.join(', '),
        forceable: false,
        result: null,
      }));
    del.mutate(
      {
        repo,
        branches,
        local: o.local,
        remote: o.remote,
        force,
        removeWorktree: o.removeWorktree,
        ...(o.switchBase ? { switchTo: list.baseBranch } : {}),
        // The server counts the branches it is sent.
        ...(phraseNeeded ? { confirmPhrase: `delete ${branches.length} branches` } : {}),
      },
      {
        onSuccess: (r) =>
          setResult((prev) =>
            prev
              ? { items: prev.items.map((i) => r.items.find((x) => x.branch === i.branch) ?? i) }
              : { items: [...r.items, ...leftOut] },
          ),
      },
    );
  };
  const deletedAny = !!result?.items.some((i) => i.state === 'done');

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose(deletedAny)}>
      <DialogContent className="rb-dialog max-w-2xl gap-0 p-0 sm:p-0" data-tone="danger">
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
              <p className="type-micro rb-eyebrow">Delete branches</p>
              <DialogTitle className="text-xl sm:text-2xl">
                {result ? 'Done' : `${rows.length} branch${rows.length > 1 ? 'es' : ''}`}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {result
                  ? `${result.items.filter((i) => i.state === 'done').length} deleted, ${
                      result.items.filter((i) => i.state === 'skipped').length
                    } skipped, ${result.items.filter((i) => i.state === 'failed').length} failed.`
                  : 'One after another. Each gets the same checks as a single delete.'}
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 sm:px-8 sm:py-6">
          {!result && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle checked={o.local} onChange={(v) => setO({ ...o, local: v })}>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Laptop aria-hidden className="size-4" /> On this Mac
                </span>
                <span className="text-xs text-muted-foreground">Local branches only.</span>
              </Toggle>
              <Toggle
                checked={o.remote}
                danger
                onChange={(v) => {
                  setO({ ...o, remote: v });
                  setPhrase('');
                }}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Server aria-hidden className="size-4" /> On origin (GitLab)
                </span>
                <span className="text-xs text-muted-foreground">
                  For everyone. Not undoable from Relay.
                </span>
              </Toggle>
              {o.local && anyHeld && (
                <Toggle
                  checked={o.removeWorktree}
                  onChange={(v) => setO({ ...o, removeWorktree: v })}
                >
                  <span className="text-sm font-medium">Remove Relay worktrees that hold them</span>
                  <span className="text-xs text-muted-foreground">
                    Never one with a running session.
                  </span>
                </Toggle>
              )}
              {o.local && anyCurrent && (
                <Toggle checked={o.switchBase} onChange={(v) => setO({ ...o, switchBase: v })}>
                  <span className="text-sm font-medium">
                    Switch the workspace to <span className="font-mono">{list.baseBranch}</span>{' '}
                    first
                  </span>
                  <span className="text-xs text-muted-foreground">
                    For the branch checked out there.
                  </span>
                </Toggle>
              )}
            </div>
          )}

          <ul className="bd-list" aria-label={result ? 'Outcome per branch' : 'What will happen'}>
            {result
              ? result.items.map((i) => (
                  <li key={i.branch} className="bd-line" data-state={i.state}>
                    {STATE_ICON[i.state]}
                    <span className="bd-name" title={i.branch}>
                      {i.branch}
                    </span>
                    <span className={cn('bd-note', i.state === 'failed' && 'text-destructive')}>
                      {resultText(i)}
                    </span>
                  </li>
                ))
              : plan.map((l) => (
                  <li
                    key={l.row.name}
                    className="bd-line"
                    data-state={l.where.length ? 'go' : 'skip'}
                  >
                    {l.where.length ? (
                      <Trash2 aria-hidden className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <CircleSlash
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="bd-name" title={l.row.name}>
                      <GitBranch aria-hidden className="mr-1 inline size-3 opacity-60" />
                      {l.row.name}
                    </span>
                    <span className="bd-note">
                      {[
                        l.where.includes('mac') ? 'this Mac' : null,
                        l.where.includes('origin') ? 'origin' : null,
                        l.notes.length ? `skip: ${l.notes.join(', ')}` : null,
                        l.needsPhrase ? 'not yours' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
          </ul>

          {!result && phraseNeeded && (
            <label className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">
                Some of these are not yours on origin. Type{' '}
                <span className="font-mono text-foreground">{want}</span> to go on.
              </span>
              <Input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder={want}
                aria-label="Type the confirmation phrase"
                autoComplete="off"
                spellCheck={false}
                className={cn('font-mono', phrase && !phraseOk && 'border-destructive')}
              />
            </label>
          )}
          {result && forceable.length > 0 && (
            <p className="db-unmerged" role="alert">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                {forceable.length} need force: unmerged commits or uncommitted worktree changes are
                lost if you go on.
              </span>
            </p>
          )}
          {del.error && <p className="text-sm text-destructive">{describeError(del.error)}</p>}
        </div>

        <DialogFooter className="rb-footer">
          {result ? (
            <>
              {forceable.length > 0 && (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    run(
                      forceable.map((i) => i.branch),
                      true,
                    )
                  }
                >
                  {busy ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  Retry {forceable.length} with force
                </Button>
              )}
              <Button onClick={() => onClose(deletedAny)} disabled={busy} autoFocus>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onClose(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || going.length === 0 || !phraseOk}
                onClick={() =>
                  run(
                    going.map((l) => l.row.name),
                    false,
                  )
                }
              >
                {busy ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Delete {going.length}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
