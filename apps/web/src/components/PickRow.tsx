import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One choice in a list you pick from: a socket on the left that takes the plug when picked, an optional tile (the
 * thing's own icon, emoji or avatar), its name, a line of facts, and tags on the right. Every row sits on its own
 * paper, so an unpicked list still reads as a set of choices, not loose text.
 */
export function PickRow({
  selected,
  onSelect,
  title,
  meta,
  leading,
  trailing,
  size = 'md',
  pickedLabel = 'Picked',
  className,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  meta?: ReactNode;
  /** The tile left of the name: an emoji, an icon or an avatar. */
  leading?: ReactNode;
  /** Tags right of the name, shown picked or not. */
  trailing?: ReactNode;
  size?: 'md' | 'sm';
  /** Said next to the check when picked; empty for none. */
  pickedLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn('pick', size === 'sm' && 'pick-sm', className)}
      data-selected={selected}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="pick-mark" aria-hidden />
      {leading !== undefined ? (
        <span className="pick-tile" aria-hidden>
          {leading}
        </span>
      ) : null}
      <span className="pick-body">
        <span className="pick-title">{title}</span>
        {meta ? <span className="pick-meta">{meta}</span> : null}
      </span>
      {trailing || selected ? (
        <span className="pick-trail">
          {trailing}
          {selected ? (
            <span className="pick-picked">
              <Check className="size-3.5" strokeWidth={2.25} aria-hidden />
              {pickedLabel}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** A small tag inside a PickRow. `em` marks the one fact worth noticing. */
export function PickTag({ children, em }: { children: ReactNode; em?: boolean }) {
  return <span className={cn('pick-tag', em && 'pick-tag-em')}>{children}</span>;
}

/** Initials for a person tile when there is no avatar. */
export function initials(name: string): string {
  const parts = name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (
    (parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}
