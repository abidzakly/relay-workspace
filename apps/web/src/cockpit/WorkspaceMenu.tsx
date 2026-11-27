import { ChevronDown, GitFork, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Workspace } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { RepoMark } from '@/components/RepoMark';
import { cn } from '@/lib/utils';
import { AttentionPanel } from './AttentionPanel';

/**
 * The workspace switch in the sheet header: the current workspace as a pill, the full list (repos, each followed by
 * its card worktrees) in a panel under it. A worktree with no live session can be removed from here.
 */
export function WorkspaceMenu({
  workspaces,
  current,
  waitingIn,
  liveIn,
  cardTitleIn,
  onPick,
  onRemove,
  removing,
}: {
  workspaces: readonly Workspace[];
  current: Workspace | null;
  waitingIn: (id: string) => number;
  liveIn: (id: string) => boolean;
  cardTitleIn: (id: string) => string | null;
  onPick: (id: string) => void;
  onRemove: (w: Workspace) => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const waitingElsewhere = workspaces.reduce(
    (n, w) => (w.id === current?.id ? n : n + waitingIn(w.id)),
    0,
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const nameOf = (w: Workspace) => (w.kind === 'worktree' && cardTitleIn(w.id)) || w.name;

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={
          current
            ? t('cockpit.workspace.current', { name: nameOf(current) })
            : t('cockpit.workspace.menu')
        }
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-full border bg-background/60 px-3 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {current?.kind === 'worktree' ? (
          <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          current && <RepoMark color={current.color} />
        )}
        <span className="min-w-0 truncate">
          {current ? nameOf(current) : t('cockpit.workspace.menu')}
        </span>
        {waitingElsewhere > 0 && (
          <span className="shrink-0 rounded-full bg-emphasis px-1.5 text-micro font-semibold text-background">
            {waitingElsewhere}
          </span>
        )}
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute top-full left-0 z-30 mt-2 grid max-h-[min(32rem,70dvh)] w-[min(20rem,calc(100vw-2rem))] grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-surface border bg-popover shadow-float"
        >
          <div className="overflow-y-auto p-1.5">
            <p className="px-2.5 pt-1.5 pb-1 type-micro text-muted-foreground">
              {t('cockpit.workspace.menu')}
            </p>
            <ul className="grid gap-0.5">
              {workspaces.map((w) => (
                <li
                  key={w.id}
                  className={cn('flex min-w-0 items-center', w.kind === 'worktree' && 'pl-4')}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onPick(w.id);
                      setOpen(false);
                    }}
                    aria-current={w.id === current?.id ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm',
                      w.id === current?.id ? 'bg-accent font-medium' : 'hover:bg-accent/60',
                    )}
                  >
                    {w.kind === 'worktree' ? (
                      <GitFork className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <RepoMark color={w.color} size="md" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={w.name}>
                      {w.kind === 'worktree' && (
                        <span className="sr-only">{t('cockpit.workspace.worktree')}: </span>
                      )}
                      {nameOf(w)}
                    </span>
                    {waitingIn(w.id) > 0 && (
                      <span
                        className="shrink-0 rounded-full bg-emphasis px-1.5 text-micro font-semibold text-background"
                        title={t('cockpit.workspace.waiting', { count: waitingIn(w.id) })}
                      >
                        {waitingIn(w.id)}
                      </span>
                    )}
                  </button>
                  {w.kind === 'worktree' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('cockpit.workspace.removeWorktree', { name: w.name })}
                      title={
                        liveIn(w.id)
                          ? t('cockpit.workspace.stopFirst')
                          : t('cockpit.workspace.removeHint')
                      }
                      disabled={liveIn(w.id) || removing}
                      onClick={() => onRemove(w)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="px-1 pt-2">
              <AttentionPanel compact />
            </div>
          </div>
          <Link
            to="/settings#workspaces"
            className="flex items-center gap-2 border-t px-4 py-2.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden /> {t('cockpit.workspace.add')}
          </Link>
        </div>
      )}
    </div>
  );
}
