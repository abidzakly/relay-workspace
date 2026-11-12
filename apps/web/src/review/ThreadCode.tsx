import { useMemo } from 'react';
import { FileCode2 } from 'lucide-react';
import type { ThreadCode as ThreadCodeData, ThreadCodeLine } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useHighlight } from './highlight';
import { intraline, segments, type Range, type Token } from './intraline';
import { pairChanges, type DiffLine } from './parseDiff';
import './review.css';

/**
 * The code a reviewer selected for a diff thread (MR Detail), drawn with the Code Reviewer's diff styles:
 * same gutters, +/− tints, syntax colors and word-level highlights.
 */

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

function lineLabel(c: ThreadCodeData, n: number): string {
  const first = c.lines[0];
  const last = c.lines[n - 1];
  const no = (l: ThreadCodeLine | undefined) => (l ? (l.kind === 'del' ? l.oldNo : l.newNo) : null);
  const a = no(first);
  const b = no(last) ?? c.newLine ?? c.oldLine;
  if (n > 1 && a !== null && b !== null && a !== b) return `lines ${a}–${b}`;
  return b !== null ? `line ${b}` : '';
}

export function ThreadCode({ code }: { code: ThreadCodeData }) {
  const lines: DiffLine[] = useMemo(
    () => code.lines.map((l) => ({ ...l, noNewline: false })),
    [code.lines],
  );
  const { oldText, newText, oldLines, newLines } = useMemo(() => {
    const o = lines.filter((l) => l.kind !== 'add');
    const n = lines.filter((l) => l.kind !== 'del');
    return {
      oldText: o.map((l) => l.text).join('\n'),
      newText: n.map((l) => l.text).join('\n'),
      oldLines: o,
      newLines: n,
    };
  }, [lines]);
  const hl = useHighlight(code.path, oldText, newText, lines.length > 0);
  const tokens = useMemo(() => {
    const m = new Map<DiffLine, Token[]>();
    oldLines.forEach((l, i) => {
      const t = hl.old?.[i];
      if (t && l.kind === 'del') m.set(l, t);
    });
    newLines.forEach((l, i) => {
      const t = hl.new?.[i];
      if (t) m.set(l, t);
    });
    return m;
  }, [oldLines, newLines, hl]);
  const words = useMemo(() => {
    const m = new Map<DiffLine, readonly Range[]>();
    for (const [a, b] of pairChanges(lines)) {
      if (a.kind !== 'del' || m.has(a)) continue;
      const r = intraline(a.text, b.text);
      m.set(a, r.old);
      m.set(b, r.new);
    }
    return m;
  }, [lines]);

  const label = lineLabel(code, lines.length);
  return (
    <div className="rv-root min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-mono text-xs font-semibold" title={code.path}>
          {code.path}
        </span>
        {label && <span className="shrink-0 text-xs text-muted-foreground">· {label}</span>}
      </div>
      {lines.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          This line is no longer in the current diff (outdated).
        </p>
      ) : (
        <div className="rv-code-block rv-wrap">
          <div className="rv-code-inner">
            {lines.map((l, i) => (
              <div key={i} className={cn('rv-row rv-inline', `rv-${l.kind}`)}>
                <span className={cn('rv-gutter', `rv-gutter-${l.kind}`)}>{l.oldNo ?? ''}</span>
                <span className={cn('rv-gutter', `rv-gutter-${l.kind}`)}>{l.newNo ?? ''}</span>
                <span className="rv-sign" aria-hidden>
                  {SIGN[l.kind]}
                </span>
                <span className="rv-code">
                  <span className="sr-only">
                    {l.kind === 'add' ? 'added: ' : l.kind === 'del' ? 'removed: ' : ''}
                  </span>
                  {segments(tokens.get(l) ?? [{ content: l.text }], words.get(l) ?? []).map(
                    (s, k) => (
                      <span
                        key={k}
                        style={s.style}
                        className={cn(s.mark && (l.kind === 'add' ? 'rv-word-add' : 'rv-word-del'))}
                      >
                        {s.content}
                      </span>
                    ),
                  )}
                  {l.text.length === 0 && '​'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
