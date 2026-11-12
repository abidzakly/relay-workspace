import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffFile as DiffFileData, ReviewDiscussion } from '@relay/shared';
import {
  ChevronRight,
  Circle,
  CircleCheck,
  FileWarning,
  MessageSquare,
  MessageSquarePlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { lineKey, type FileThreads, type LineKey } from './anchor';
import { useHighlight } from './highlight';
import { intraline, segments, type Range, type Token } from './intraline';
import { pairChanges, sides, splitRows, type DiffLine, type Hunk } from './parseDiff';

export type DiffMode = 'inline' | 'split';

/** What a file needs from the session to draw comments. */
export interface CommentSlots {
  /** null = comments cannot be added here (branch compare, no diff refs). */
  canComment: boolean;
  /** Renders the threads (and an open composer) under a line. */
  renderThreads: (file: DiffFileData, key: LineKey, threads: ReviewDiscussion[]) => ReactNode;
  /** Renders the composer for a new comment under `line`. */
  renderComposer: (file: DiffFileData, line: DiffLine, close: () => void) => ReactNode;
}

const FILE_KIND = {
  added: { label: 'Added', cls: 'text-success' },
  deleted: { label: 'Deleted', cls: 'text-destructive' },
  renamed: { label: 'Renamed', cls: 'text-primary-ink' },
  modified: { label: 'Modified', cls: 'text-muted-foreground' },
} as const;

/** Over this many diff lines a file starts folded (still one click away). */
const FOLD_LINES = 1200;

function splitPath(p: string): { dir: string; name: string } {
  const cut = p.lastIndexOf('/');
  return { dir: cut > 0 ? p.slice(0, cut + 1) : '', name: p.slice(cut + 1) };
}

/** +/− proportion bar, GitHub-style but quieter: five pills. */
export function ChangeBar({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const greens = total === 0 ? 0 : Math.round((add / total) * 5);
  return (
    <span className="inline-flex gap-px" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-2 w-1.5 rounded-xs',
            total === 0 ? 'bg-muted' : i < greens ? 'bg-success/80' : 'bg-destructive/70',
          )}
        />
      ))}
    </span>
  );
}

function Code({
  tokens,
  text,
  ranges,
  kind,
}: {
  tokens: Token[] | undefined;
  text: string;
  ranges: readonly Range[];
  kind: DiffLine['kind'];
}) {
  const segs = segments(tokens ?? [{ content: text }], ranges);
  return (
    <>
      {segs.map((s, i) => (
        <span
          key={i}
          style={s.style}
          className={cn(s.mark && (kind === 'add' ? 'rv-word-add' : 'rv-word-del'))}
        >
          {s.content}
        </span>
      ))}
      {text.length === 0 && '​'}
    </>
  );
}

const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

interface LineProps {
  line: DiffLine;
  tokens: Token[] | undefined;
  ranges: readonly Range[];
  onComment: (() => void) | null;
}

function Gutter({
  n,
  kind,
  onComment,
}: {
  n: number | null;
  kind: DiffLine['kind'];
  onComment: (() => void) | null;
}) {
  return (
    <span className={cn('rv-gutter', `rv-gutter-${kind}`)}>
      {onComment && (
        <button
          type="button"
          className="rv-add-comment"
          onClick={onComment}
          aria-label={`Comment on line ${n ?? ''}`}
          title="Comment on this line"
        >
          <MessageSquarePlus className="size-3.5" aria-hidden />
        </button>
      )}
      {n ?? ''}
    </span>
  );
}

function InlineLine({ line, tokens, ranges, onComment }: LineProps) {
  return (
    <div className={cn('rv-row rv-inline group/line', `rv-${line.kind}`)} data-line={lineKey(line)}>
      <Gutter n={line.oldNo} kind={line.kind} onComment={line.kind === 'del' ? onComment : null} />
      <Gutter n={line.newNo} kind={line.kind} onComment={line.kind !== 'del' ? onComment : null} />
      <span className="rv-sign" aria-hidden>
        {SIGN[line.kind]}
      </span>
      <span className="rv-code">
        <span className="sr-only">
          {line.kind === 'add' ? 'added: ' : line.kind === 'del' ? 'removed: ' : ''}
        </span>
        <Code tokens={tokens} text={line.text} ranges={ranges} kind={line.kind} />
        {line.noNewline && (
          <span className="rv-eol" title="No newline at end of file">
            ⏎̸
          </span>
        )}
      </span>
    </div>
  );
}

function SplitHalf({
  line,
  tokens,
  ranges,
  onComment,
  side,
}: Partial<LineProps> & { side: 'old' | 'new' }) {
  if (!line)
    return (
      <>
        <span className="rv-gutter rv-empty" />
        <span className="rv-code rv-empty" />
      </>
    );
  const kind = line.kind;
  return (
    <>
      <Gutter
        n={side === 'old' ? line.oldNo : line.newNo}
        kind={kind}
        onComment={onComment ?? null}
      />
      <span className={cn('rv-code', `rv-${kind}`)}>
        {/* Never colour alone: the sign is drawn, and spoken. */}
        <span className={cn('rv-split-sign', `rv-split-sign-${kind}`)} aria-hidden>
          {SIGN[kind]}
        </span>
        <span className="sr-only">
          {kind === 'add' ? 'added: ' : kind === 'del' ? 'removed: ' : ''}
        </span>
        <Code tokens={tokens} text={line.text} ranges={ranges ?? []} kind={kind} />
        {line.noNewline && (
          <span className="rv-eol" title="No newline at end of file">
            ⏎̸
          </span>
        )}
      </span>
    </>
  );
}

function HunkHeader({ h, first }: { h: Hunk; first: boolean }) {
  const hidden = h.hiddenBefore;
  return (
    <div className="rv-hunk" data-hunk>
      <span className="rv-hunk-dots" aria-hidden>
        ⋯
      </span>
      <span className="truncate">
        {hidden > 0
          ? `${hidden} unchanged line${hidden === 1 ? '' : 's'}${first ? ' above' : ''}`
          : `Lines ${h.newStart}–${h.newStart + Math.max(h.newCount - 1, 0)}`}
        {h.section && <span className="rv-hunk-section"> · {h.section}</span>}
      </span>
    </div>
  );
}

function Placeholder({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
      {icon ?? <FileWarning className="size-4 shrink-0" aria-hidden />}
      <span>{children}</span>
    </div>
  );
}

/**
 * Mounts its body only once it is near the viewport (and keeps it): big changesets stay smooth. `force` mounts it at
 * once (keyboard navigation jumping to a hunk far below).
 */
function useNearViewport<T extends Element>(force: boolean): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (force && !near) setNear(true);
  }, [force, near]);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '1200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

interface FileProps {
  file: DiffFileData;
  hunks: Hunk[];
  mode: DiffMode;
  wrap: boolean;
  collapsed: boolean;
  viewed: boolean;
  onToggle: (path: string) => void;
  onViewed: (path: string) => void;
  threads: FileThreads | undefined;
  slots: CommentSlots;
  /** `id` attribute for navigation. */
  anchorId: string;
  /** Navigation is heading here: mount and unfold the body now. */
  reveal?: boolean;
}

/** Rows rendered per chunk of a long file; the next chunk mounts as the reader nears it. */
export const CHUNK_ROWS = 300;

/**
 * Splits hunks (by their line counts) into chunks of about `rows` lines; a hunk is never cut. Returns each chunk's
 * [from, to) hunk range.
 */
export function chunkHunks(sizes: readonly number[], rows = CHUNK_ROWS): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  let n = 0;
  sizes.forEach((size, i) => {
    if (n > 0 && n + size > rows) {
      out.push([from, i]);
      from = i;
      n = 0;
    }
    n += size;
  });
  if (from < sizes.length) out.push([from, sizes.length]);
  return out;
}

/**
 * A long file renders chunk by chunk: the first at once, each next one when the placeholder below comes within a
 * screen of the viewport (windowed rendering), so a 5 000-line file does not cost 5 000 rows up front.
 */
function Chunked({
  chunks,
  lines,
  render,
  all,
}: {
  /** Render every chunk now (navigation is heading into this file). */
  all: boolean;
  chunks: [number, number][];
  /** Lines per chunk, for the placeholder's height. */
  lines: number[];
  render: (from: number, to: number) => ReactNode;
}) {
  const [shownState, setShown] = useState(1);
  const shown = all ? chunks.length : shownState;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= chunks.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(chunks.length);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(chunks.length, n + 1));
      },
      { rootMargin: '1000px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, chunks.length]);
  const rest = lines.slice(shown).reduce((a, b) => a + b, 0);
  return (
    <>
      {chunks.slice(0, shown).map(([from, to]) => render(from, to))}
      {shown < chunks.length && (
        <div ref={sentinel} className="rv-chunk-rest" style={{ height: rest * 21 }} aria-hidden />
      )}
    </>
  );
}

function DiffFileImpl(p: FileProps) {
  const { file, hunks, mode } = p;
  const [ref, near] = useNearViewport<HTMLDivElement>(Boolean(p.reveal));
  const [composer, setComposer] = useState<DiffLine | null>(null);
  const [unfoldState, setUnfold] = useState(false);
  const unfold = unfoldState || Boolean(p.reveal);
  const lineCount = useMemo(() => hunks.reduce((n, h) => n + h.lines.length, 0), [hunks]);
  const chunks = useMemo(() => chunkHunks(hunks.map((h) => h.lines.length)), [hunks]);
  const chunkLines = useMemo(
    () =>
      chunks.map(([from, to]) => hunks.slice(from, to).reduce((n, h) => n + h.lines.length + 1, 0)),
    [chunks, hunks],
  );
  const folded = lineCount > FOLD_LINES && !unfold;
  const showBody = !p.collapsed && near;

  const s = useMemo(() => sides(hunks), [hunks]);
  const hl = useHighlight(file.path, s.oldText, s.newText, showBody && !folded);
  const tokenOf = useMemo(() => {
    const m = new Map<DiffLine, { old?: Token[]; new?: Token[] }>();
    s.oldLines.forEach((l, i) => {
      const t = hl.old?.[i];
      if (t) m.set(l, { ...m.get(l), old: t });
    });
    s.newLines.forEach((l, i) => {
      const t = hl.new?.[i];
      if (t) m.set(l, { ...m.get(l), new: t });
    });
    return m;
  }, [s, hl]);
  const tok = (l: DiffLine) => (l.kind === 'del' ? tokenOf.get(l)?.old : tokenOf.get(l)?.new);

  const words = useMemo(() => {
    const m = new Map<DiffLine, readonly Range[]>();
    if (!showBody || folded) return m;
    for (const h of hunks) {
      for (const [a, b] of pairChanges(h.lines)) {
        if (a.kind !== 'del' || m.has(a)) continue;
        const r = intraline(a.text, b.text);
        m.set(a, r.old);
        m.set(b, r.new);
      }
    }
    return m;
  }, [hunks, showBody, folded]);

  const { dir, name } = splitPath(file.path);
  const kind = FILE_KIND[file.kind];
  const threadsAt = (l: DiffLine) => p.threads?.byLine.get(lineKey(l));
  const commentFor = (l: DiffLine) => (p.slots.canComment ? () => setComposer(l) : null);

  const extras = (l: DiffLine): ReactNode => {
    const t = threadsAt(l);
    const open = composer === l;
    if (!t && !open) return null;
    return (
      <div className="rv-thread-slot">
        {t && p.slots.renderThreads(file, lineKey(l), t)}
        {open && p.slots.renderComposer(file, l, () => setComposer(null))}
      </div>
    );
  };

  let body: ReactNode;
  if (file.binary) body = <Placeholder>Binary file: no text diff to show.</Placeholder>;
  else if (file.tooLarge)
    body = <Placeholder>This diff is too large to display here. Open it in GitLab.</Placeholder>;
  else if (file.collapsed)
    body = (
      <Placeholder>GitLab collapsed this diff because it is large. Open it in GitLab.</Placeholder>
    );
  else if (hunks.length === 0)
    body = (
      <Placeholder>
        {file.kind === 'renamed'
          ? 'Renamed without changes.'
          : 'No content changes (mode or empty file).'}
      </Placeholder>
    );
  else if (folded)
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-5 text-sm text-muted-foreground">
        <span>Large diff: {lineCount.toLocaleString()} lines. Folded to keep the review fast.</span>
        <button type="button" className="rv-pill" onClick={() => setUnfold(true)}>
          Show diff
        </button>
      </div>
    );
  else if (!near) body = <div style={{ height: Math.min(lineCount, 400) * 21 }} />;
  else
    body = (
      <div className={cn('rv-code-block', p.wrap || mode === 'split' ? 'rv-wrap' : 'rv-nowrap')}>
        <div className="rv-code-inner">
          <Chunked
            key={`${file.path}|${mode}`}
            chunks={chunks}
            lines={chunkLines}
            all={Boolean(p.reveal)}
            render={(from, to) =>
              hunks.slice(from, to).map((h, i) => {
                const hi = from + i;
                return (
                  <div key={hi} className="rv-hunk-group">
                    <HunkHeader h={h} first={hi === 0} />
                    {mode === 'inline'
                      ? h.lines.map((l, li) => (
                          <div key={li}>
                            <InlineLine
                              line={l}
                              tokens={tok(l)}
                              ranges={words.get(l) ?? []}
                              onComment={commentFor(l)}
                            />
                            {extras(l)}
                          </div>
                        ))
                      : splitRows(h.lines).map((r, ri) => {
                          const ctx = r.left && r.left === r.right;
                          const below = [r.left, ctx ? null : r.right].filter(
                            (x): x is DiffLine => !!x,
                          );
                          return (
                            <div key={ri}>
                              <div
                                className="rv-row rv-split group/line"
                                data-line={
                                  r.right ? lineKey(r.right) : r.left ? lineKey(r.left) : undefined
                                }
                              >
                                <SplitHalf
                                  side="old"
                                  {...(r.left
                                    ? {
                                        line: r.left,
                                        tokens: tok(r.left),
                                        ranges: words.get(r.left) ?? [],
                                      }
                                    : {})}
                                  onComment={r.left && !ctx ? commentFor(r.left) : null}
                                />
                                <SplitHalf
                                  side="new"
                                  {...(r.right
                                    ? {
                                        line: r.right,
                                        tokens: tok(r.right),
                                        ranges: words.get(r.right) ?? [],
                                      }
                                    : {})}
                                  onComment={r.right ? commentFor(r.right) : null}
                                />
                              </div>
                              {below.map((l) => (
                                <div key={lineKey(l)}>{extras(l)}</div>
                              ))}
                            </div>
                          );
                        })}
                  </div>
                );
              })
            }
          />
        </div>
      </div>
    );

  return (
    <section
      id={p.anchorId}
      ref={ref}
      className="rv-file"
      data-file={file.path}
      aria-label={file.path}
    >
      <header className="rv-file-header">
        <button
          type="button"
          onClick={() => p.onToggle(file.path)}
          className="rv-file-toggle"
          aria-expanded={!p.collapsed}
          aria-label={`${p.collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
        >
          <ChevronRight
            className={cn('size-4 transition-transform duration-200', !p.collapsed && 'rotate-90')}
            aria-hidden
          />
        </button>
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
          <span className="flex min-w-0 items-baseline gap-1 font-mono text-sm">
            <span className="min-w-0 shrink-[999] truncate text-muted-foreground" title={file.path}>
              {file.oldPath && file.kind === 'renamed' ? (
                <>
                  <span className="line-through decoration-muted-foreground/40">
                    {file.oldPath}
                  </span>
                  {' → '}
                </>
              ) : (
                dir
              )}
            </span>
            <span className="min-w-0 truncate font-semibold text-foreground" title={file.path}>
              {name}
            </span>
          </span>
        </div>
        <span className={cn('hidden shrink-0 text-xs font-medium sm:inline', kind.cls)}>
          {kind.label}
        </span>
        {(p.threads?.count ?? 0) > 0 && (
          <span className="rv-chip" title={`${p.threads!.count} comment thread(s)`}>
            <MessageSquare aria-hidden className="mr-1 inline size-3" />
            {p.threads!.count}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span>
          <span className="text-destructive">−{file.deletions}</span>
          <span className="hidden sm:inline-flex">
            <ChangeBar add={file.additions} del={file.deletions} />
          </span>
        </span>
        <button
          type="button"
          onClick={() => p.onViewed(file.path)}
          className={cn('rv-viewed', p.viewed && 'rv-viewed-on')}
          aria-pressed={p.viewed}
          title="Mark as viewed (v)"
        >
          {p.viewed ? (
            <CircleCheck className="size-4" aria-hidden />
          ) : (
            <Circle className="size-4" aria-hidden />
          )}
          <span className="hidden md:inline">Viewed</span>
        </button>
      </header>
      <div className={cn('rv-collapse', p.collapsed && 'rv-collapsed')}>
        <div className="min-h-0 overflow-hidden">
          {p.threads && p.threads.outdated.length > 0 && !p.collapsed && (
            <div className="rv-thread-slot border-b">
              <p className="mb-2 text-xs text-muted-foreground">
                On lines that are not in this diff any more (outdated or outside the changes):
              </p>
              {p.slots.renderThreads(file, 'n0', p.threads.outdated)}
            </div>
          )}
          {!p.collapsed && body}
        </div>
      </div>
    </section>
  );
}

export const DiffFileView = memo(DiffFileImpl);
