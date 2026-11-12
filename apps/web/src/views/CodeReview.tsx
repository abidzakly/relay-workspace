import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { InboxMr } from '@relay/shared';
import type { GitMerge } from 'lucide-react';
import {
  ArrowRight,
  ArrowUpDown,
  GitBranch,
  GitPullRequest,
  History,
  MoveRight,
  Search,
} from 'lucide-react';
import { MrStateBadge } from '@/components/Badge';
import { ActionBadge, PipelineBadge, useUserLabel } from '@/components/MrBits';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { useMrInbox } from '@/lib/mrApi';
import { reviewLink, reviewState, useBranches, withBack } from '@/lib/reviewApi';
import { cn } from '@/lib/utils';
import { recentReviews } from '@/review/recent';
import '@/review/review.css';
import { PageTitle } from '@/components/PageTitle';

/**
 * Code Review home: pick a merge request or two branches. The MR Inbox and MR
 * Detail jump straight into a session instead; this page is the place to browse.
 */

type Source = 'mr' | 'branches';

function Tabs({ value, onChange }: { value: Source; onChange: (v: Source) => void }) {
  const opts: { v: Source; label: string; icon: typeof GitMerge }[] = [
    { v: 'mr', label: 'Merge request', icon: GitPullRequest },
    { v: 'branches', label: 'Branches', icon: GitBranch },
  ];
  return (
    <div
      role="tablist"
      aria-label="What to review"
      className="rv-segmented rv-segmented-lg w-full sm:w-auto"
    >
      {opts.map(({ v, label, icon: Icon }) => (
        <button
          key={v}
          role="tab"
          type="button"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cn('rv-segment flex-1 sm:flex-none', value === v && 'rv-segment-on')}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

function Pills<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="rv-segmented">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn('rv-segment', value === o.v && 'rv-segment-on')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MrRow({ m, from }: { m: InboxMr; from: string }) {
  const userLabel = useUserLabel();
  return (
    <li>
      <Link {...reviewLink(m.repoId, m.iid, from, 'Code Review')} className="rv-pick group">
        <div className="grid min-w-0 flex-1 gap-1.5">
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              {m.repoName} · !{m.iid}
            </span>
            <span className="flex min-w-0 items-center gap-1 font-mono text-2xs">
              <span className="truncate">{m.sourceBranch}</span>
              <MoveRight className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{m.targetBranch}</span>
            </span>
          </span>
          <span className="line-clamp-2 text-base leading-snug font-medium [overflow-wrap:anywhere]">
            {m.title}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {m.action.yours && <ActionBadge action={m.action} />}
            <MrStateBadge state={m.derivedState} />
            <PipelineBadge pipeline={m.headPipeline} />
            {m.author && <span>by {userLabel(m.author)}</span>}
            <span>
              · updated <TimeAgo at={m.updatedAt ?? m.createdAt} />
            </span>
          </span>
        </div>
        <ArrowRight
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden
        />
      </Link>
    </li>
  );
}

const PAGE = 20;
export type MrSort = 'action' | 'recent' | 'oldest';
const parseSort = (v: string | null): MrSort => (v === 'recent' || v === 'oldest' ? v : 'action');

/**
 * Search, author and order for the MR picker. Pure. `action` keeps the server's order (what needs me first, then
 * oldest); the others order by last activity.
 */
export function filterMrs<
  T extends {
    title: string;
    sourceBranch: string;
    iid: number;
    author: string | null;
    updatedAt: number | null;
    createdAt: number;
  },
>(items: readonly T[], f: { q: string; author: string; sort: MrSort }): T[] {
  const s = f.q.trim().toLowerCase();
  const out = items.filter(
    (m) =>
      (!f.author || m.author === f.author) &&
      (!s ||
        m.title.toLowerCase().includes(s) ||
        m.sourceBranch.toLowerCase().includes(s) ||
        `!${m.iid}`.includes(s) ||
        (m.author ?? '').toLowerCase().includes(s)),
  );
  if (f.sort === 'action') return out;
  const at = (m: T) => m.updatedAt ?? m.createdAt;
  return out.sort((a, b) => (f.sort === 'recent' ? at(b) - at(a) : at(a) - at(b)));
}

function MrPicker() {
  const userLabel = useUserLabel();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const repo = params.get('repo') ?? '';
  const state = params.get('state') === 'all' ? 'all' : 'open';
  const scope = params.get('scope') === 'all' ? 'all' : 'mine';
  // Every filter lives in the URL: a refresh or a shared link shows the same list.
  const q = params.get('q') ?? '';
  const author = params.get('author') ?? '';
  const sort = parseSort(params.get('sort'));
  const [limit, setLimit] = useState(PAGE);
  const inbox = useMrInbox({ repo, state, reviewer: '' });
  const set = (k: string, v: string, dflt: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v && v !== dflt) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );

  const scoped = useMemo(
    () => (inbox.data?.items ?? []).filter((m) => scope === 'all' || m.mine),
    [inbox.data, scope],
  );
  // Only authors who actually have an MR in this list: never an option that matches nothing.
  const authors = useMemo(
    () => [...new Set(scoped.map((m) => m.author).filter((a): a is string => !!a))].sort(),
    [scoped],
  );
  const items = useMemo(() => filterMrs(scoped, { q, author, sort }), [scoped, q, author, sort]);
  useEffect(() => setLimit(PAGE), [q, author, sort, repo, state, scope]);
  const shown = items.slice(0, limit);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => set('q', e.target.value, '')}
            placeholder="Search title, branch, !iid, author"
            aria-label="Search merge requests"
            className="h-10 w-full rounded-xl border bg-card pr-3 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Select
          value={repo}
          onChange={(e) => set('repo', e.target.value, '')}
          aria-label="Repository"
          className="h-10 w-auto rounded-xl pr-8"
        >
          <option value="">All repos</option>
          {(inbox.data?.repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        {authors.length > 1 && (
          <Select
            value={authors.includes(author) ? author : ''}
            onChange={(e) => set('author', e.target.value, '')}
            aria-label="Author"
            className="h-10 w-auto max-w-[12rem] rounded-xl pr-8"
          >
            <option value="">Any author</option>
            {authors.map((a) => (
              <option key={a} value={a}>
                {userLabel(a)}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={sort}
          onChange={(e) => set('sort', e.target.value, 'action')}
          aria-label="Sort"
          className="h-10 w-auto rounded-xl pr-8"
        >
          <option value="action">Needs me first</option>
          <option value="recent">Recently updated</option>
          <option value="oldest">Oldest first</option>
        </Select>
        <Pills
          label="State"
          value={state}
          onChange={(v) => set('state', v, 'open')}
          options={[
            { v: 'open', label: 'Open' },
            { v: 'all', label: 'All' },
          ]}
        />
        <Pills
          label="Whose"
          value={scope}
          onChange={(v) => set('scope', v, 'mine')}
          options={[
            { v: 'mine', label: 'Mine' },
            { v: 'all', label: 'Everyone' },
          ]}
        />
      </div>

      {inbox.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load merge requests</AlertTitle>
          <AlertDescription>{describeError(inbox.error)}</AlertDescription>
        </Alert>
      )}
      {inbox.isPending && (
        <ul className="grid gap-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="rv-pick">
              <div className="grid flex-1 gap-2">
                <span className="rv-skeleton h-3 w-48" />
                <span className="rv-skeleton h-4 w-3/4" />
              </div>
            </li>
          ))}
        </ul>
      )}
      {inbox.data && items.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {q || author || repo || state !== 'open' || scope !== 'mine'
            ? 'No merge request matches these filters.'
            : 'No open merge requests of yours. Try “Everyone”, or compare two branches.'}
        </p>
      )}
      <ul className="grid gap-2">
        {shown.map((m) => (
          <MrRow
            key={`${m.repoId}#${m.iid}`}
            m={m}
            from={`${location.pathname}${location.search}`}
          />
        ))}
      </ul>
      {items.length > shown.length && (
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {shown.length} of {items.length}
          </span>
          <button type="button" className="rv-pill" onClick={() => setLimit((n) => n + PAGE)}>
            Show {Math.min(PAGE, items.length - shown.length)} more
          </button>
        </div>
      )}
    </div>
  );
}

function BranchField({
  id,
  label,
  repo,
  value,
  onChange,
}: {
  id: string;
  label: string;
  repo: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(value.trim()), 250);
    return () => clearTimeout(t);
  }, [value]);
  const b = useBranches(repo, search);
  return (
    <div className="grid min-w-0 flex-1 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="relative">
        <GitBranch
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          id={id}
          list={`${id}-list`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={repo ? 'branch name' : 'pick a repo first'}
          disabled={!repo}
          autoComplete="off"
          spellCheck={false}
          className="h-10 w-full rounded-xl border bg-card pr-3 pl-9 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <datalist id={`${id}-list`}>
          {(b.data?.branches ?? []).map((br) => (
            <option key={br.name} value={br.name}>
              {br.default ? 'default' : br.protected ? 'protected' : ''}
            </option>
          ))}
        </datalist>
      </div>
      {b.error && <span className="text-xs text-destructive">{describeError(b.error)}</span>}
      {b.data?.truncated && (
        <span className="text-xs text-muted-foreground">
          Showing the first {b.data.branches.length} branches: type to narrow.
        </span>
      )}
    </div>
  );
}

function BranchPicker() {
  const navigate = useNavigate();
  const location = useLocation();
  const inbox = useMrInbox({ repo: '', state: 'open', reviewer: '' });
  const repos = inbox.data?.repos ?? [];
  // Repo and both branches live in the URL, so a refresh keeps a half-made comparison.
  const [params, setParams] = useSearchParams();
  const repo = params.get('repo') ?? '';
  const from = params.get('base') ?? '';
  const to = params.get('target') ?? '';
  const setParam = useCallback(
    (k: string, v: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v) next.set(k, v);
          else next.delete(k);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const setRepo = (v: string) => setParam('repo', v);
  const setFrom = (v: string) => setParam('base', v);
  const setTo = (v: string) => setParam('target', v);
  const effectiveRepo = repo || repos[0]?.id || '';
  const defaults = useBranches(effectiveRepo, '');
  const defaultBranch = defaults.data?.branches.find((b) => b.default)?.name ?? '';
  useEffect(() => {
    if (!from && defaultBranch) setFrom(defaultBranch);
  }, [defaultBranch, from]);

  const ok = effectiveRepo && from.trim() && to.trim() && from.trim() !== to.trim();
  const go = () => {
    if (!ok) return;
    const qs = new URLSearchParams({ from: from.trim(), to: to.trim() });
    const back = `${location.pathname}${location.search}`;
    void navigate(
      withBack(`/review/${encodeURIComponent(effectiveRepo)}/compare?${qs.toString()}`, back),
      { state: reviewState(back, 'Code Review') },
    );
  };

  return (
    <form
      className="rv-card grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <div className="grid gap-1">
        <label htmlFor="cmp-repo" className="text-xs font-medium text-muted-foreground">
          Repository
        </label>
        <Select
          id="cmp-repo"
          value={effectiveRepo}
          onChange={(e) => {
            setRepo(e.target.value);
            setFrom('');
            setTo('');
          }}
          className="h-10 rounded-xl"
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
        <BranchField
          id="cmp-from"
          label="Base"
          repo={effectiveRepo}
          value={from}
          onChange={setFrom}
        />
        <button
          type="button"
          className="rv-icon-btn self-center sm:mb-0.5"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
          aria-label="Swap base and target"
          title="Swap"
        >
          <ArrowUpDown className="size-4 sm:rotate-90" aria-hidden />
        </button>
        <BranchField id="cmp-to" label="Compare" repo={effectiveRepo} value={to} onChange={setTo} />
      </div>
      <p className="text-xs text-muted-foreground">
        Shows what <span className="font-mono">compare</span> adds on top of{' '}
        <span className="font-mono">base</span> (from their merge base), exactly like an MR would.
        Read-only: comments need an MR.
      </p>
      <div>
        <Button type="submit" disabled={!ok}>
          Compare
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </form>
  );
}

/** Sessions this browser opened lately: one click back into a review (Review Home's "continue"). */
function RecentReviews({ from }: { from: string }) {
  const [items] = useState(recentReviews);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="rv-recent" className="grid gap-2">
      <h2
        id="rv-recent"
        className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        <History className="size-3.5" aria-hidden />
        Continue reviewing
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.slice(0, 4).map((r) => (
          <li key={r.path} className="min-w-0">
            <Link
              to={withBack(r.path, from)}
              state={reviewState(from, 'Code Review')}
              className="rv-pick group py-2.5"
            >
              {r.kind === 'mr' ? (
                <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-sm font-medium" title={r.title}>
                  {r.title}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {r.context} · opened <TimeAgo at={r.at} />
                </span>
              </span>
              <ArrowRight
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CodeReview() {
  const [params, setParams] = useSearchParams();
  const source: Source = params.get('mode') === 'branches' ? 'branches' : 'mr';
  const location = useLocation();
  return (
    <div className="rv-root mx-auto grid w-full max-w-4xl min-w-0 gap-6">
      <div className="grid gap-1">
        <PageTitle>Code Review</PageTitle>
        <p className="text-sm text-muted-foreground">
          Read a merge request or compare two branches, file by file.
        </p>
      </div>
      <RecentReviews from={`${location.pathname}${location.search}`} />
      <Tabs
        value={source}
        onChange={(v) => setParams(v === 'branches' ? { mode: 'branches' } : {}, { replace: true })}
      />
      <div
        key={source}
        className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
      >
        {source === 'mr' ? <MrPicker /> : <BranchPicker />}
      </div>
    </div>
  );
}
