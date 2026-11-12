import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router';
import type { DiffFile, ReviewDiscussion } from '@relay/shared';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Columns2,
  FolderTree,
  MessageSquare,
  Rows3,
  Search,
  WrapText,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNarrow, useReducedMotion } from '@/workspace/useMedia';
import { groupThreads, positionFor, type FileThreads } from './anchor';
import { buildTree, sortForTree, type DirNode } from './fileTree';
import { ChangeBar, DiffFileView, type CommentSlots, type DiffMode } from './DiffFile';
import { parseDiff, type Hunk } from './parseDiff';
import { NewComment, ThreadCard } from './Threads';
import './review.css';

/**
 * The shared review surface (MR sessions and branch compares): sticky toolbar, file rail, and the file cards.
 * The URL holds the diff mode (`?view=split`); viewed/collapsed state is per browser (localStorage), keyed by the
 * reviewed version so a new push starts fresh.
 */

const MODE_KEY = 'rv:mode';
const WRAP_KEY = 'rv:wrap';

function readLs(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLs(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode: a convenience only */
  }
}

/** Height of the sticky toolbar (+ a file header): what sits above the reading line. */
function readingLine(): number {
  const root = document.querySelector('.rv-root');
  const v = root ? getComputedStyle(root).getPropertyValue('--rv-top').trim() : '';
  const n = Number.parseFloat(v);
  const px = Number.isFinite(n) ? (v.endsWith('rem') ? n * 16 : n) : 80;
  return px + 8;
}

/**
 * Scrolls to the next / previous element matching `selector` below / above the reading line. False when there is
 * none in the page (yet): the caller then opens the next file that has one.
 */
function jumpTo(selector: string, dir: 1 | -1, smooth = true): boolean {
  const els = [...document.querySelectorAll<HTMLElement>(selector)];
  const offset = readingLine();
  const tops = els.map((el) => el.getBoundingClientRect().top - offset);
  const target =
    dir === 1 ? els[tops.findIndex((t) => t > 2)] : els[tops.findLastIndex((t) => t < -2)];
  target?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  return Boolean(target);
}

/** Two frames: React has committed, the browser has laid the new rows out. */
const settle = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** The first diff row at or below the reading line: what a layout switch keeps in place. */
function visibleRow(): { file: string; line: string | null; top: number } | null {
  const offset = readingLine();
  for (const el of document.querySelectorAll<HTMLElement>('.rv-file')) {
    const box = el.getBoundingClientRect();
    if (box.bottom <= offset) continue;
    const file = el.getAttribute('data-file');
    if (!file) return null;
    for (const row of el.querySelectorAll<HTMLElement>('[data-line]')) {
      const top = row.getBoundingClientRect().top;
      if (top >= offset - 1) return { file, line: row.getAttribute('data-line'), top };
    }
    return { file, line: null, top: box.top };
  }
  return null;
}

/** Unresolved threads only: resolved ones are done, the reviewer jumps to what is still open. */
const OPEN_THREAD = '.rv-thread:not(.rv-thread-resolved)';

export const fileAnchor = (path: string) => `file-${path.replace(/[^A-Za-z0-9_-]/g, '_')}`;

function useViewed(storageKey: string) {
  const key = `rv:viewed:${storageKey}`;
  const [viewed, setViewed] = useState<Set<string>>(() => {
    try {
      const v = JSON.parse(readLs(key) ?? '[]') as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback(
    (path: string) =>
      setViewed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        writeLs(key, JSON.stringify([...next]));
        return next;
      }),
    [key],
  );
  return [viewed, toggle] as const;
}

/** Runs a state change inside a View Transition when the browser has one and motion is welcome. */
function useTransitionRunner() {
  const reduced = useReducedMotion();
  return useCallback(
    (fn: () => void) => {
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      if (reduced || !doc.startViewTransition) fn();
      else doc.startViewTransition(() => flushSync(fn));
    },
    [reduced],
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="rv-segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('rv-segment', value === o.value && 'rv-segment-on')}
        >
          {o.icon}
          <span className="hidden lg:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

interface RailProps {
  files: DiffFile[];
  threads: Map<string, FileThreads>;
  viewed: Set<string>;
  active: string | null;
  onPick: (path: string) => void;
}

const KIND_DOT = {
  added: 'bg-success',
  deleted: 'bg-destructive',
  renamed: 'bg-primary',
  modified: 'bg-warning',
} as const;

function FileRow({
  f,
  depth,
  t,
  viewed,
  active,
  onPick,
}: {
  f: DiffFile;
  depth: number;
  t: FileThreads | undefined;
  viewed: boolean;
  active: boolean;
  onPick: (path: string) => void;
}) {
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  return (
    <li className="grid">
      <button
        type="button"
        onClick={() => onPick(f.path)}
        title={f.oldPath && f.kind === 'renamed' ? `${f.oldPath} → ${f.path}` : f.path}
        aria-current={active ? 'true' : undefined}
        className={cn('rv-rail-item', active && 'rv-rail-item-on', viewed && 'opacity-55')}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            f.binary ? 'bg-muted-foreground' : KIND_DOT[f.kind],
          )}
          aria-hidden
        />
        <span className="sr-only">
          {f.kind}
          {f.binary ? ', binary' : ''}:{' '}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            f.kind === 'deleted' && 'line-through decoration-muted-foreground/50',
          )}
        >
          {name}
        </span>
        {t && t.unresolved > 0 && (
          <span className="rv-chip shrink-0" title={`${t.unresolved} unresolved`}>
            <span className="sr-only">, unresolved comments: </span>
            {t.unresolved}
          </span>
        )}
        {viewed ? (
          <CircleCheck className="size-3.5 shrink-0 text-success" aria-label="viewed" />
        ) : (
          <span className="shrink-0 font-mono text-micro text-muted-foreground tabular-nums">
            {f.binary ? 'bin' : `+${f.additions} −${f.deletions}`}
          </span>
        )}
      </button>
    </li>
  );
}

function DirRows({
  node,
  depth,
  closed,
  onToggleDir,
  rail,
}: {
  node: DirNode;
  depth: number;
  closed: Set<string>;
  onToggleDir: (path: string) => void;
  rail: RailProps;
}) {
  return (
    <>
      {node.dirs.map((d) => {
        const open = !closed.has(d.path);
        return (
          <li key={d.path} className="grid">
            <button
              type="button"
              className="rv-rail-dir"
              aria-expanded={open}
              onClick={() => onToggleDir(d.path)}
              title={d.path}
              style={{ paddingLeft: `${0.25 + depth * 0.75}rem` }}
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
                aria-hidden
              />
              <span className="min-w-0 truncate">{d.name}/</span>
            </button>
            {open && (
              <ul className="grid gap-px">
                <DirRows
                  node={d}
                  depth={depth + 1}
                  closed={closed}
                  onToggleDir={onToggleDir}
                  rail={rail}
                />
              </ul>
            )}
          </li>
        );
      })}
      {node.files.map((f) => (
        <FileRow
          key={f.path}
          f={f}
          depth={depth}
          t={rail.threads.get(f.path)}
          viewed={rail.viewed.has(f.path)}
          active={rail.active === f.path}
          onPick={rail.onPick}
        />
      ))}
    </>
  );
}

/** The changed files as a folder tree; folders fold, a filter narrows by path (all folders open while filtering). */
function FileRail(rail: RailProps) {
  const { files } = rail;
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const query = q.trim().toLowerCase();
  const tree = useMemo(
    () => buildTree(query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files),
    [files, query],
  );
  const empty = tree.dirs.length === 0 && tree.files.length === 0;
  const toggleDir = (path: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <nav aria-label="Changed files" className="grid min-h-0 gap-2">
      <label className="relative block">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
          className="h-8 w-full rounded-lg border bg-background/60 pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <ul className="grid gap-px overflow-y-auto overscroll-contain pr-1">
        <DirRows
          node={tree}
          depth={0}
          closed={query ? new Set() : closed}
          onToggleDir={toggleDir}
          rail={rail}
        />
        {empty && <li className="px-2 py-3 text-xs text-muted-foreground">No file matches.</li>}
      </ul>
    </nav>
  );
}

export interface ReviewWorkspaceProps {
  /** Left of the toolbar: back link. */
  back: ReactNode;
  /** Title block of the toolbar. */
  title: ReactNode;
  /** Extra toolbar buttons (Open in GitLab…). */
  actions?: ReactNode;
  /** Above the files: summary cards (commits, general comments, errors). */
  intro?: ReactNode;
  files: DiffFile[];
  truncated: boolean;
  discussions: ReviewDiscussion[];
  /** MR sessions only; branch compares are read-only. `headSha` = the version on screen. */
  mr: { repo: string; iid: number; canComment: boolean; headSha: string | null } | null;
  storageKey: string;
}

export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  // One order everywhere: the rail's tree, the cards, and j/k.
  const files = useMemo(() => sortForTree(props.files), [props.files]);
  const p = { ...props, files };
  const [params, setParams] = useSearchParams();
  const narrow = useNarrow();
  const runTransition = useTransitionRunner();
  const urlMode = params.get('view');
  const mode: DiffMode = narrow
    ? 'inline'
    : urlMode === 'split' || urlMode === 'inline'
      ? urlMode
      : readLs(MODE_KEY) === 'split'
        ? 'split'
        : 'inline';
  const [wrap, setWrapState] = useState(() => readLs(WRAP_KEY) !== 'off');
  const [viewed, toggleViewed] = useViewed(p.storageKey);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  /** Files navigation is heading into: mounted and unfolded at once. */
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const activeRef = useRef(active);
  activeRef.current = active;
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);

  // Sticky file headers sit right under the toolbar, whatever its height (it wraps on narrow screens).
  useEffect(() => {
    const bar = toolbarRef.current;
    const root = rootRef.current;
    if (!bar || !root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() =>
      root.style.setProperty('--rv-top', `${bar.offsetHeight}px`),
    );
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  const setMode = useCallback(
    (m: DiffMode) => {
      writeLs(MODE_KEY, m);
      // Keep the row being read where it is: the two layouts have different row heights.
      const anchor = visibleRow();
      runTransition(() =>
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set('view', m);
            return next;
          },
          { replace: true },
        ),
      );
      if (!anchor) return;
      void settle().then(() => {
        const section = document.querySelector<HTMLElement>(
          `.rv-file[data-file="${CSS.escape(anchor.file)}"]`,
        );
        const row =
          (anchor.line &&
            section?.querySelector<HTMLElement>(`[data-line="${CSS.escape(anchor.line)}"]`)) ||
          section;
        if (row) window.scrollBy({ top: row.getBoundingClientRect().top - anchor.top });
      });
    },
    [runTransition, setParams],
  );
  const setWrap = (w: boolean) => {
    writeLs(WRAP_KEY, w ? 'on' : 'off');
    setWrapState(w);
  };

  const parsed = useMemo(
    () =>
      p.files.map((file) => ({ file, hunks: file.diff ? parseDiff(file.diff) : ([] as Hunk[]) })),
    [p.files],
  );
  const headSha = p.mr?.headSha ?? null;
  const grouped = useMemo(
    () => groupThreads(p.discussions, parsed, headSha),
    [p.discussions, parsed, headSha],
  );

  const totals = useMemo(
    () =>
      p.files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), {
        add: 0,
        del: 0,
      }),
    [p.files],
  );

  const toggleCollapsed = useCallback(
    (path: string) =>
      runTransition(() =>
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        }),
      ),
    [runTransition],
  );
  const markViewed = useCallback(
    (path: string) => {
      const willBeViewed = !viewed.has(path);
      toggleViewed(path);
      // Marking viewed folds the file (and unfolds it when un-marked), like a checklist.
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (willBeViewed) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [toggleViewed, viewed],
  );

  // Viewed files start folded.
  useEffect(() => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const v of viewed) if (p.files.some((f) => f.path === v)) next.add(v);
      return next;
    });
    // Only on first load of a file set (`viewed` is read, not watched).
  }, [p.files]);

  const scrollToFile = useCallback((path: string) => {
    setRailOpen(false);
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    requestAnimationFrame(() =>
      document
        .getElementById(fileAnchor(path))
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
    setActive(path);
  }, []);

  // The file at the top of the viewport is "active" (rail highlight, e / v keys).
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const path = top?.target.getAttribute('data-file');
        if (path) setActive(path);
      },
      { rootMargin: '-72px 0px -65% 0px' },
    );
    document.querySelectorAll('.rv-file').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [parsed]);

  /**
   * Next / previous hunk or open thread, across the whole review: when none is left in the page, the next file that
   * has one is unfolded, mounted and unfolded from any large-diff fold, then searched. Folded, viewed and
   * not-yet-rendered files are no longer skipped.
   */
  const navigate = useCallback(
    async (selector: string, dir: 1 | -1, has: (path: string) => boolean) => {
      if (jumpTo(selector, dir)) return;
      const order = p.files.map((f) => f.path);
      const from = order.indexOf(activeRef.current ?? '');
      let i = from < 0 ? (dir === 1 ? 0 : order.length - 1) : from;
      for (; i >= 0 && i < order.length; i += dir) {
        const path = order[i]!;
        if (!has(path)) continue;
        setCollapsed((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        setRevealed((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
        await settle();
        if (i !== from) {
          // Land at the file first, so "next" means the first thing in it (or the last, going back).
          const section = document.getElementById(fileAnchor(path));
          if (dir === 1) section?.scrollIntoView({ block: 'start' });
          else section?.scrollIntoView({ block: 'end' });
          await settle();
          const inFile = [...(section?.querySelectorAll<HTMLElement>(selector) ?? [])];
          const target = dir === 1 ? inFile[0] : inFile[inFile.length - 1];
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setActive(path);
            return;
          }
        } else if (jumpTo(selector, dir)) return;
      }
    },
    [p.files],
  );
  const hasHunks = useCallback(
    (path: string) =>
      parsed.some(
        (x) =>
          x.file.path === path &&
          x.hunks.length > 0 &&
          !x.file.binary &&
          !x.file.tooLarge &&
          !x.file.collapsed,
      ),
    [parsed],
  );
  const hasOpenThreads = useCallback(
    (path: string) => (grouped.byFile.get(path)?.unresolved ?? 0) > 0,
    [grouped],
  );
  const nextHunk = useCallback(
    (dir: 1 | -1) => void navigate('[data-hunk]', dir, hasHunks),
    [navigate, hasHunks],
  );
  const nextThread = useCallback(
    (dir: 1 | -1) => void navigate(OPEN_THREAD, dir, hasOpenThreads),
    [navigate, hasOpenThreads],
  );

  const stepFile = useCallback(
    (dir: 1 | -1) => {
      const idx = p.files.findIndex((f) => f.path === active);
      const next = p.files[Math.max(0, Math.min(p.files.length - 1, idx + dir))];
      if (next) scrollToFile(next.path);
    },
    [p.files, active, scrollToFile],
  );

  // Review keys. Quiet while typing or when a dialog is open (same rule as the global shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      // Holding a key steps through files; it must not toggle a layout or a file back and forth.
      if (e.repeat && e.key !== 'j' && e.key !== 'k') return;
      const t = e.target;
      if (
        t instanceof Element &&
        t.closest('input, textarea, select, [contenteditable], [role="textbox"]')
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      switch (e.key) {
        case 'j':
          stepFile(1);
          break;
        case 'k':
          stepFile(-1);
          break;
        case 'n':
          nextHunk(1);
          break;
        case 'p':
          nextHunk(-1);
          break;
        case ']':
          nextThread(1);
          break;
        case '[':
          nextThread(-1);
          break;
        case 's':
          if (!narrow) setMode(mode === 'split' ? 'inline' : 'split');
          break;
        case 'e':
          if (active) toggleCollapsed(active);
          break;
        case 'v':
          if (active) markViewed(active);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, mode, narrow, setMode, toggleCollapsed, markViewed, stepFile, nextHunk, nextThread]);

  const mr = p.mr;
  const slots: CommentSlots = useMemo(
    () => ({
      canComment: Boolean(mr?.canComment),
      renderThreads: (_file, _key, threads) => (
        <div className="grid gap-2">
          {threads.map((d) =>
            mr ? <ThreadCard key={d.id} repo={mr.repo} iid={mr.iid} d={d} interactive /> : null,
          )}
        </div>
      ),
      renderComposer: (file, line, close) =>
        mr ? (
          <NewComment
            repo={mr.repo}
            iid={mr.iid}
            position={positionFor(file, line)}
            headSha={mr.headSha}
            onClose={close}
          />
        ) : null,
    }),
    [mr],
  );

  const viewedCount = p.files.filter((f) => viewed.has(f.path)).length;
  const activeIndex = p.files.findIndex((f) => f.path === active);
  const openThreads = p.discussions.filter((d) => d.resolvable && !d.resolved).length;
  const progress = p.files.length === 0 ? 0 : viewedCount / p.files.length;

  const rail = (
    <FileRail
      files={p.files}
      threads={grouped.byFile}
      viewed={viewed}
      active={active}
      onPick={scrollToFile}
    />
  );

  return (
    <div
      ref={rootRef}
      className="rv-root mx-auto flex w-full max-w-[1800px] min-w-0 flex-col gap-4"
    >
      <header ref={toolbarRef} className="rv-toolbar">
        <div className="flex min-w-0 items-center gap-2">
          {p.back}
          <div className="min-w-0 flex-1">{p.title}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="rv-icon-btn lg:hidden"
              onClick={() => setRailOpen(true)}
              aria-label="Changed files"
              title="Changed files"
            >
              <FolderTree className="size-4" aria-hidden />
            </button>
            {!narrow && (
              <Segmented
                label="Diff layout"
                value={mode}
                onChange={setMode}
                options={[
                  {
                    value: 'inline',
                    label: 'Inline',
                    icon: <Rows3 className="size-4" aria-hidden />,
                  },
                  {
                    value: 'split',
                    label: 'Split',
                    icon: <Columns2 className="size-4" aria-hidden />,
                  },
                ]}
              />
            )}
            <button
              type="button"
              className={cn('rv-icon-btn', wrap && 'rv-icon-btn-on')}
              aria-pressed={wrap}
              onClick={() => setWrap(!wrap)}
              title="Wrap long lines"
              aria-label="Wrap long lines"
            >
              <WrapText className="size-4" aria-hidden />
            </button>
            {p.actions}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {p.files.length}
            {p.truncated ? '+' : ''} file{p.files.length === 1 ? '' : 's'}
          </span>
          <span className="flex items-center gap-1.5 font-mono tabular-nums">
            <span className="text-success">+{totals.add.toLocaleString()}</span>
            <span className="text-destructive">−{totals.del.toLocaleString()}</span>
            <ChangeBar add={totals.add} del={totals.del} />
          </span>
          {p.files.length > 0 && (
            <span
              className="flex items-center gap-2"
              aria-label={`${viewedCount} of ${p.files.length} files viewed`}
            >
              <span className="rv-progress" aria-hidden>
                <span style={{ transform: `scaleX(${progress})` }} />
              </span>
              <span className="tabular-nums">
                {viewedCount}/{p.files.length} viewed
              </span>
            </span>
          )}
          <span className="ml-auto hidden xl:inline">
            <kbd className="rv-kbd">j</kbd>/<kbd className="rv-kbd">k</kbd> files ·{' '}
            <kbd className="rv-kbd">n</kbd>/<kbd className="rv-kbd">p</kbd> changes ·{' '}
            <kbd className="rv-kbd">[</kbd>/<kbd className="rv-kbd">]</kbd> comments ·{' '}
            <kbd className="rv-kbd">e</kbd> fold · <kbd className="rv-kbd">v</kbd> viewed
            {!narrow && (
              <>
                {' '}
                · <kbd className="rv-kbd">s</kbd> layout
              </>
            )}
          </span>
        </div>
      </header>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="rv-rail hidden lg:grid">{rail}</aside>
        <div className="grid min-w-0 content-start gap-4">
          {p.intro}
          {grouped.general.length > 0 && mr && (
            <details className="rv-card group">
              <summary className="cursor-pointer list-none text-sm font-medium">
                <MessageSquare aria-hidden className="mr-1 inline size-4" />
                {grouped.general.length} general comment{grouped.general.length === 1 ? '' : 's'}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  not on a line of this diff
                </span>
              </summary>
              <div className="mt-3 grid gap-2">
                {grouped.general.map((d) => (
                  <ThreadCard key={d.id} repo={mr.repo} iid={mr.iid} d={d} interactive />
                ))}
              </div>
            </details>
          )}
          {parsed.map(({ file, hunks }) => (
            <DiffFileView
              key={file.path}
              anchorId={fileAnchor(file.path)}
              file={file}
              hunks={hunks}
              mode={mode}
              wrap={wrap}
              collapsed={collapsed.has(file.path)}
              viewed={viewed.has(file.path)}
              onToggle={toggleCollapsed}
              onViewed={markViewed}
              threads={grouped.byFile.get(file.path)}
              slots={slots}
              reveal={revealed.has(file.path)}
            />
          ))}
          {p.truncated && (
            <p className="rv-card text-sm text-muted-foreground">
              More files changed than can be shown here. Open the rest in GitLab.
            </p>
          )}
          {p.files.length > 0 && viewedCount === p.files.length && (
            <div className="rv-done" role="status">
              <CircleCheck className="size-5" aria-hidden />
              Every file viewed. Nice review.
            </div>
          )}
        </div>
      </div>

      {p.files.length > 0 && (
        <nav aria-label="Review navigation" className="rv-navbar">
          <div className="rv-navbar-group" role="group" aria-label="Files">
            <button
              type="button"
              className="rv-icon-btn"
              onClick={() => stepFile(-1)}
              aria-label="Previous file (k)"
              title="Previous file (k)"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="min-w-0 truncate font-mono text-xs tabular-nums" aria-live="polite">
              {activeIndex >= 0 ? activeIndex + 1 : 1}/{p.files.length}
            </span>
            <button
              type="button"
              className="rv-icon-btn"
              onClick={() => stepFile(1)}
              aria-label="Next file (j)"
              title="Next file (j)"
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
          <div className="rv-navbar-group" role="group" aria-label="Changes">
            <button
              type="button"
              className="rv-icon-btn"
              onClick={() => nextHunk(-1)}
              aria-label="Previous change (p)"
              title="Previous change (p)"
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              className="rv-icon-btn"
              onClick={() => nextHunk(1)}
              aria-label="Next change (n)"
              title="Next change (n)"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </div>
          {openThreads > 0 && (
            <button
              type="button"
              className="rv-navbar-chip"
              onClick={() => nextThread(1)}
              aria-label={`Next open comment (]). ${openThreads} open`}
              title="Next open comment (])"
            >
              <MessageSquare className="size-3.5" aria-hidden />
              <span className="tabular-nums">{openThreads}</span>
            </button>
          )}
          {active && (
            <button
              type="button"
              className={cn('rv-navbar-chip', viewed.has(active) && 'text-success')}
              onClick={() => markViewed(active)}
              aria-pressed={viewed.has(active)}
              title="Mark the current file viewed (v)"
            >
              <CircleCheck className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">
                {viewed.has(active) ? 'Viewed' : 'Mark viewed'}
              </span>
              <span className="tabular-nums sm:hidden">
                {viewedCount}/{p.files.length}
              </span>
            </button>
          )}
        </nav>
      )}

      <DialogPrimitive.Root open={railOpen} onOpenChange={setRailOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-x-0 bottom-0 z-50 grid max-h-[80dvh] grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-t-2xl border-t bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-float outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom"
          >
            <div className="flex items-center justify-between">
              <DialogPrimitive.Title className="text-sm font-semibold">
                Changed files
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="rv-icon-btn" aria-label="Close">
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
            {rail}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
