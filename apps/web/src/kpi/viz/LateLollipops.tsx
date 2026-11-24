import { motion } from 'motion/react';
import type { KpiLateCard } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { safeHref } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';

const MAX = 10;

/**
 * Late cards as lollipops: the longer the stem, the later the card. Longest first, so the worst one is read first.
 * The full numbered list sits in the fold below.
 */
export function LateLollipops({ cards }: { cards: readonly KpiLateCard[] }) {
  const reduced = useReducedMotion();
  if (cards.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-block size-2 rounded-full bg-success" aria-hidden />
        No late cards.
      </p>
    );
  }
  const sorted = [...cards].sort((a, b) => b.lateByMs - a.lateByMs).slice(0, MAX);
  const most = Math.max(1, sorted[0]!.lateByMs);
  return (
    <ol className="grid gap-2" aria-label="Late cards, latest first">
      {sorted.map((c, i) => {
        const f = c.lateByMs / most;
        return (
          <li
            key={c.cardId}
            className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-center gap-3 text-sm max-sm:grid-cols-1 max-sm:gap-1"
          >
            <span className="flex min-w-0 items-center gap-2">
              {c.url ? (
                <a
                  href={safeHref(c.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-medium hover:underline"
                  title={c.title}
                >
                  {c.title}
                </a>
              ) : (
                <span className="truncate font-medium" title={c.title}>
                  {c.title}
                </span>
              )}
              {c.type && (
                <Badge variant="outline" className="shrink-0">
                  {c.type}
                </Badge>
              )}
            </span>
            <span className="flex items-center gap-2">
              <span className="relative flex h-3 flex-1 items-center">
                <motion.span
                  className="relative flex h-0.5 items-center rounded-full bg-destructive/60"
                  style={{ width: `${Math.max(3, f * 100)}%`, originX: 0 }}
                  initial={reduced ? false : { scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.6, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                >
                  <span className="absolute -right-1.5 size-3 rounded-full border-2 border-background bg-destructive" />
                </motion.span>
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-xs text-destructive tabular-nums">
                +{c.lateByLabel}
              </span>
              <span className="hidden w-24 shrink-0 text-xs text-muted-foreground md:inline">
                {c.stoppedAt === null ? 'no MR' : 'MR opened late'}
              </span>
            </span>
          </li>
        );
      })}
      {cards.length > MAX && (
        <li className="text-xs text-muted-foreground">
          and {cards.length - MAX} more in the list below
        </li>
      )}
    </ol>
  );
}
