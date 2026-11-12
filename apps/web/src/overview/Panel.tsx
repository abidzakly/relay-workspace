import { useId, type ReactNode } from 'react';
import { Badge } from '@/components/Badge';
import { cn } from '@/lib/utils';
import { TONE, type Tone } from './tone';

/**
 * One Overview block. A solid card in Classic; the Living Workspace restyles `.ov-panel` in
 * `worldOverview.css` (opaque enough for stable contrast). The heading names the block, `context` says what its numbers
 * mean (scope, month, "now"), so two filters never look like they disagree.
 */
export function Panel({
  n,
  title,
  context,
  actions,
  tone,
  className,
  bodyClassName,
  children,
}: {
  /** The block's number on the page: `(01) Release`. */
  n?: number;
  title: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
  tone?: Tone;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'ov-panel flex min-w-0 flex-col border-t border-foreground/80 text-card-foreground',
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 pt-3">
        <div className="min-w-0">
          <h2 id={id} className="flex items-center gap-2 type-micro">
            {n !== undefined && <span>({String(n).padStart(2, '0')})</span>}
            {tone && <ToneDot tone={tone} />}
            {title}
          </h2>
          {context && <p className="mt-1 text-xs text-muted-foreground">{context}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={cn('flex min-w-0 flex-col gap-3 py-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** A state's mark: a small cut stone in the state's colour, as on the crystals. */
export function ToneDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rotate-45', TONE[tone].dot, className)}
    />
  );
}

/** The state as words: colour is never the only signal. */
export function ToneBadge({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <Badge variant={TONE[tone].badge}>
      <ToneDot tone={tone} />
      {label ?? TONE[tone].label}
    </Badge>
  );
}

/** A count in mono, with the state's mark when there is anything to count. */
export function CountBadge({ count, tone }: { count: number; tone: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-xs tabular-nums',
        count === 0 && 'text-muted-foreground',
      )}
    >
      {count > 0 && <ToneDot tone={tone} className="size-1.5" />}
      {String(count).padStart(2, '0')}
    </span>
  );
}
