import { Check, ExternalLink, GitBranch, Link2, Link2Off, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StateCard } from '@relay/shared';
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
import { rankCardsForBranch, useLinkCard, useUnlinkCard } from '@/lib/branchesApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { cn } from '@/lib/utils';
import '@/components/branches/branches.css';
import '@/review/review.css';

const SHOWN = 40;

/**
 * Links a branch to an existing Notion card. A branch pushed from outside Relay has no card whose Branch formula names
 * it, and a formula cannot be written; Relay remembers the link instead, for Create MR, Test Bench and Review.
 */
export function CardLinkDialog({
  repo,
  branch,
  currentCardId,
  linked,
  onClose,
}: {
  repo: string;
  branch: string;
  /** The card the branch has now (formula or link), preselected. */
  currentCardId?: string | null;
  /** The current card is a Relay link (so it can be removed). */
  linked?: boolean;
  onClose: () => void;
}) {
  const state = useStateSnapshot();
  const link = useLinkCard();
  const unlink = useUnlinkCard();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(currentCardId ?? null);
  const busy = link.isPending || unlink.isPending;

  const ranked = useMemo(
    () => rankCardsForBranch(state.data?.cards ?? [], repo, branch),
    [state.data?.cards, repo, branch],
  );
  const q = query.trim().toLowerCase();
  const shown = (
    q
      ? ranked.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            (c.branchName ?? '').toLowerCase().includes(q) ||
            c.assignees.some((a) => a.toLowerCase().includes(q)),
        )
      : ranked
  ).slice(0, SHOWN);
  const pickedCard = ranked.find((c) => c.id === picked) ?? null;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="cl-dialog max-w-xl gap-0 p-0 sm:p-0">
        <div className="cl-head">
          <p className="type-micro text-muted-foreground">Link a card</p>
          <DialogTitle className="text-xl sm:text-2xl">Which card is this branch?</DialogTitle>
          <span className="br-chip w-fit" title={branch}>
            <GitBranch aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
          <DialogDescription className="text-sm">
            No card names this branch in its Branch formula. Pick the card it belongs to: Relay
            remembers the link for Create MR, Test Bench and Review. Notion is not changed.
          </DialogDescription>
          <label className="relative mt-1 block">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, assignee or branch"
              aria-label="Search cards"
              className="pl-9"
            />
          </label>
        </div>

        <ul className="cl-list" role="listbox" aria-label="Cards">
          {state.isPending && (
            <li className="cl-empty">
              <Loader2 className="size-4 motion-safe:animate-spin" /> Reading cards…
            </li>
          )}
          {!state.isPending && shown.length === 0 && (
            <li className="cl-empty">No card matches “{query}”.</li>
          )}
          {shown.map((c, i) => (
            <CardOption
              key={c.id}
              card={c}
              branch={branch}
              selected={c.id === picked}
              index={i}
              onPick={() => setPicked(c.id)}
            />
          ))}
        </ul>

        <div className="grid gap-3 border-t border-hairline px-5 pt-3 pb-5 sm:px-8">
          {pickedCard?.branchName?.trim() && pickedCard.branchName.trim() !== branch && (
            <p className="text-xs text-warning">
              This card's Branch formula says{' '}
              <span className="font-mono">{pickedCard.branchName}</span>. The link only adds this
              branch; that one keeps working too.
            </p>
          )}
          {(link.error || unlink.error) && (
            <p className="text-xs text-destructive">{describeError(link.error ?? unlink.error)}</p>
          )}
          <DialogFooter className="items-center">
            {linked && (
              <Button
                variant="ghost"
                className="sm:mr-auto"
                disabled={busy}
                onClick={() => unlink.mutate({ repo, branch }, { onSuccess: onClose })}
              >
                <Link2Off className="size-4" /> Remove link
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={!picked || busy || (picked === currentCardId && linked)}
              onClick={() =>
                picked && link.mutate({ repo, branch, cardId: picked }, { onSuccess: onClose })
              }
            >
              {link.isPending ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <Link2 className="size-4" />
              )}
              Link card
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CardOption({
  card,
  branch,
  selected,
  index,
  onPick,
}: {
  card: StateCard;
  branch: string;
  selected: boolean;
  index: number;
  onPick: () => void;
}) {
  const own = card.branchName?.trim();
  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={cn('cl-option', selected && 'cl-option-on')}
      style={{ ['--i' as string]: Math.min(index, 12) }}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <span className="cl-radio" aria-hidden>
        {selected && <Check className="size-3" />}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="line-clamp-2 text-sm font-medium wrap-anywhere">{card.title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {card.status && <span className="cl-status">{card.status}</span>}
          {card.assignees.length > 0 && (
            <span className="truncate">{card.assignees.join(', ')}</span>
          )}
          {card.mine && <span className="text-emphasis">mine</span>}
          {own && (
            <span className={cn('truncate font-mono', own === branch && 'text-success')}>
              ⎇ {own}
            </span>
          )}
        </span>
      </span>
      {card.url && (
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="rv-icon-btn shrink-0"
          aria-label="Open in Notion"
          title="Open in Notion"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
    </li>
  );
}
