import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useHighlight } from '../highlight';
import { parseDiff, sides, type DiffLine } from '../parseDiff';

/**
 * One hunk (or a whole file's diff) for the Review Deck: reuses the Code Reviewer's `parseDiff` + shiki `useHighlight`.
 * With `onLine`, the gutter is tappable (mark lines for an issue); `selected` holds the marked line numbers
 * (new side, old side for deletions).
 */
export function lineNo(l: DiffLine): number {
  return (l.kind === 'del' ? l.oldNo : l.newNo) ?? 0;
}

export function HunkView({
  path,
  text,
  selected,
  onLine,
  className,
}: {
  path: string;
  text: string;
  selected?: ReadonlySet<number>;
  onLine?: (l: DiffLine) => void;
  className?: string;
}) {
  const hunks = useMemo(() => parseDiff(text), [text]);
  const s = useMemo(() => sides(hunks), [hunks]);
  const hl = useHighlight(path, s.oldText, s.newText, true);
  const tokens = useMemo(() => {
    const m = new Map<DiffLine, { content: string; style?: Record<string, string> }[]>();
    s.oldLines.forEach((l, i) => {
      const t = hl.old?.[i];
      if (t && l.kind === 'del') m.set(l, t);
    });
    s.newLines.forEach((l, i) => {
      const t = hl.new?.[i];
      if (t) m.set(l, t);
    });
    return m;
  }, [s, hl]);

  return (
    <div
      className={cn(
        'overflow-x-auto rounded-control border bg-muted/30 font-mono text-xs leading-relaxed',
        className,
      )}
    >
      {hunks.map((h, hi) => (
        <div key={hi} className="md:min-w-max">
          <div className="sticky left-0 bg-primary/5 px-3 py-1 text-2xs text-muted-foreground">
            @@ {h.oldStart},{h.oldCount} → {h.newStart},{h.newCount} {h.section}
          </div>
          {h.lines.map((l, li) => {
            const no = lineNo(l);
            const marked = selected?.has(no) && l.kind !== 'del';
            return (
              <div
                key={li}
                className={cn(
                  'flex',
                  l.kind === 'add' && 'bg-success/12',
                  l.kind === 'del' && 'bg-destructive/12',
                  marked && 'ring-1 ring-warning ring-inset',
                )}
              >
                <button
                  type="button"
                  tabIndex={onLine ? 0 : -1}
                  disabled={!onLine}
                  onClick={() => onLine?.(l)}
                  aria-label={onLine ? `Mark line ${no}` : undefined}
                  className={cn(
                    'w-11 shrink-0 select-none px-1 text-right text-muted-foreground/70 tabular-nums',
                    onLine && 'cursor-pointer hover:bg-warning/20',
                    marked && 'bg-warning/30 text-foreground',
                  )}
                >
                  {no || ''}
                </button>
                <span className="w-4 shrink-0 select-none text-center text-muted-foreground">
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                </span>
                {/* Phones wrap long lines: a sideways scroll would fight the card's swipe. */}
                <span className="code-tokens min-w-0 pr-4 whitespace-pre-wrap [overflow-wrap:anywhere] md:whitespace-pre md:[overflow-wrap:normal]">
                  {tokens.get(l)?.map((t, ti) => (
                    <span key={ti} style={t.style}>
                      {t.content}
                    </span>
                  )) ?? l.text}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
