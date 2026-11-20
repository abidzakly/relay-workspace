import { FileDiff, Layers } from 'lucide-react';
import { Link } from 'react-router';
import type { DeckSource } from '@relay/shared';
import { deckPath } from '@/lib/deckApi';
import { cn } from '@/lib/utils';
import './review.css';

/** A source both views can show: an MR or a branch compare (a local diff has the deck only). */
export type SwitchableSource = Extract<DeckSource, { kind: 'mr' | 'compare' }>;

export const isSwitchable = (s: DeckSource | null): s is SwitchableSource =>
  s !== null && (s.kind === 'mr' || s.kind === 'compare') && !s.repoId.startsWith('~');

/** The full-diff route for a source. `?classic=1` keeps phones on it instead of bouncing back to the deck. */
export function classicPath(s: SwitchableSource): string {
  const e = encodeURIComponent;
  if (s.kind === 'mr') return `/review/${e(s.repoId)}/mr/${s.iid}?classic=1`;
  return `/review/${e(s.repoId)}/compare?classic=1&from=${e(s.from)}&to=${e(s.to)}`;
}

/**
 * Diff | Deck: one review, two ways to read it. Switching replaces the history entry (it is the same review), and
 * carries `origin` along so the back arrow of either view returns where the review was opened from.
 */
export function ReviewModeSwitch({
  source,
  current,
  origin,
}: {
  source: SwitchableSource;
  current: 'diff' | 'deck';
  origin: string | null;
}) {
  const state = origin ? { reviewFrom: origin } : undefined;
  const modes = [
    { key: 'diff', label: 'Diff', icon: FileDiff, to: classicPath(source), title: 'Full diff' },
    { key: 'deck', label: 'Deck', icon: Layers, to: deckPath(source), title: 'Review deck' },
  ] as const;
  return (
    <div role="group" aria-label="Review mode" className="rv-segmented shrink-0">
      {modes.map((m) => {
        const on = m.key === current;
        const Icon = m.icon;
        return (
          <Link
            key={m.key}
            to={m.to}
            replace
            state={state}
            aria-current={on ? 'page' : undefined}
            title={m.title}
            onClick={(e) => on && e.preventDefault()}
            className={cn('rv-segment', on && 'rv-segment-on')}
          >
            <Icon className="size-4" aria-hidden />
            <span className="hidden sm:inline">{m.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
