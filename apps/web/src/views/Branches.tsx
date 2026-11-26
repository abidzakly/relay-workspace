import { BOTTOM_BAR } from '@/components/FloatingThemeSwitch';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckSquare,
  FolderGit2,
  GitCompare,
  GitPullRequestCreate,
  Inbox,
  Link2,
  NotebookText,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { BranchRow, BranchSourceState } from '@relay/shared';
import { isReservedBranch } from '@relay/shared';
import { CardLinkDialog } from '@/components/cardLink/CardLinkDialog';
import { BulkDeleteDialog } from '@/components/branches/BulkDeleteDialog';
import { DeleteBranchDialog } from '@/components/branches/DeleteBranchDialog';
import { Dropdown } from '@/components/Dropdown';
import { PageTitle } from '@/components/PageTitle';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/api';
import { branchesPath, useBranches, useFetchBranches } from '@/lib/branchesApi';
import { mrCreatePath } from '@/lib/mrCreateApi';
import { testBenchPath } from '@/lib/runBranchApi';
import { useRepos } from '@/lib/settingsApi';
import { cn } from '@/lib/utils';
import '@/components/branches/branches.css';
import '@/review/review.css';

type Filter = 'all' | 'mr' | 'nomr' | 'local' | 'remote';
const FILTERS: { id: Filter; label: string; test: (r: BranchRow) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'mr', label: 'Has MR', test: (r) => !!r.mr },
  { id: 'nomr', label: 'No MR', test: (r) => !r.mr && !r.isBase },
  { id: 'local', label: 'Only on this Mac', test: (r) => r.local && !r.remote },
  { id: 'remote', label: 'Only on origin', test: (r) => r.remote && !r.local },
];
const PAGE = 120;
/** Never ticked or trashed here: the base, GitLab-protected and long-lived environment branches. */
const undeletable = (r: BranchRow) => r.isBase || r.protected || isReservedBranch(r.name);
/** "Created by": the head commit's author (git does not record who made a branch). */
const UNKNOWN = '\u0000unknown';
const authorKey = (r: BranchRow) => r.authorEmail ?? r.author ?? UNKNOWN;
const LAST_REPO = 'relay.branches.repo';

const kindOf = (r: BranchRow) =>
  r.isBase
    ? 'base'
    : r.current
      ? 'current'
      : r.mr
        ? 'mr'
        : r.local && !r.remote
          ? 'local'
          : 'plain';

/**
 * Every branch of a repository, wherever it came from (Relay, an IDE, a colleague): local and remote, with its MR and
 * card. From here a branch runs on a device, gets reviewed, or becomes an MR.
 */
export function Branches() {
  const params = useParams();
  const navigate = useNavigate();
  const repos = useRepos();
  const enabled = useMemo(() => (repos.data ?? []).filter((r) => r.enabled), [repos.data]);
  const repo =
    params.repo ??
    (() => {
      const last = localStorage.getItem(LAST_REPO);
      return enabled.find((r) => r.id === last)?.id ?? enabled[0]?.id ?? null;
    })();
  const { search } = useLocation();
  const [sp] = useSearchParams();
  useEffect(() => {
    if (!params.repo && repo) void navigate(`${branchesPath(repo)}${search}`, { replace: true });
    if (repo) localStorage.setItem(LAST_REPO, repo);
  }, [params.repo, repo, navigate, search]);

  const q = useBranches(repo);
  const fetchOrigin = useFetchBranches();
  const [filter, setFilter] = useState<Filter>(() => {
    const f = sp.get('filter');
    return FILTERS.some((x) => x.id === f) ? (f as Filter) : 'all';
  });
  const [query, setQuery] = useState('');
  const [authors, setAuthors] = useState<string[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [linking, setLinking] = useState<BranchRow | null>(null);
  const [deleting, setDeleting] = useState<BranchRow | null>(null);
  // Several branches at once: a selection of names, kept to the rows that still exist.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const lastPicked = useRef<string | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
    setAuthors([]);
  }, [repo]);
  useEffect(() => setLimit(PAGE), [repo, filter, query, authors]);

  const rows = q.data?.rows ?? [];
  const me = q.data?.meEmail ?? null;
  // Only the people who pushed a branch in this list.
  const authorOptions = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    for (const r of q.data?.rows ?? []) {
      const k = authorKey(r);
      const cur = m.get(k);
      if (cur) cur.n++;
      else m.set(k, { label: k === UNKNOWN ? 'Unknown' : (r.author ?? r.authorEmail ?? k), n: 1 });
    }
    return [...m.entries()]
      .sort(
        ([a, x], [b, y]) =>
          Number(b === me) - Number(a === me) ||
          Number(a === UNKNOWN) - Number(b === UNKNOWN) ||
          x.label.localeCompare(y.label),
      )
      .map(([value, { label, n }]) => ({
        value,
        label: value === me ? `${label} (you)` : label,
        hint: String(n),
      }));
  }, [q.data?.rows, me]);
  const byAuthor = authors.length ? rows.filter((r) => authors.includes(authorKey(r))) : rows;
  const needle = query.trim().toLowerCase();
  const searched = needle
    ? byAuthor.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          (r.subject ?? '').toLowerCase().includes(needle) ||
          (r.author ?? '').toLowerCase().includes(needle) ||
          (r.card?.title ?? '').toLowerCase().includes(needle) ||
          (r.mr ? `!${r.mr.iid} ${r.mr.title}`.toLowerCase().includes(needle) : false),
      )
    : byAuthor;
  const test = FILTERS.find((f) => f.id === filter)!.test;
  const shown = searched.filter(test);
  useEffect(() => {
    const names = new Set(rows.map((r) => r.name));
    setSelected((cur) => {
      const next = new Set([...cur].filter((n) => names.has(n)));
      return next.size === cur.size ? cur : next;
    });
  }, [rows]);
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !bulkOpen && !deleting) {
        setSelected(new Set());
        setSelecting(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, bulkOpen, deleting]);
  const selectable = shown.filter((r) => !undeletable(r));
  const toggle = (name: string, range: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const on = !cur.has(name);
      if (range && lastPicked.current) {
        const names = selectable.map((r) => r.name);
        const a = names.indexOf(lastPicked.current);
        const b = names.indexOf(name);
        if (a >= 0 && b >= 0) {
          for (const n of names.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            if (on) next.add(n);
            else next.delete(n);
          }
          return next;
        }
      }
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
    lastPicked.current = name;
  };
  const othersSelected = rows.filter((r) => selected.has(r.name) && r.mine !== true).length;
  const allShownSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.name));
  const noWorkspace =
    q.data?.sources.local.ok === false && q.data.sources.local.code === 'no_workspace';

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4">
      <div>
        <PageTitle>Branches</PageTitle>
        <p className="text-sm text-muted-foreground">
          Every branch, wherever it was pushed from. Run one on a device, review it, or turn it into
          an MR.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-64">
          <Dropdown
            label="Repo"
            options={enabled.map((r) => ({ value: r.id, label: r.name, hint: r.baseBranch }))}
            value={repo}
            onChange={(v) => void navigate(branchesPath(v))}
            icon={FolderGit2}
            width="full"
            searchable={enabled.length > 6}
            placeholder={repos.isPending ? 'Loading repos…' : 'Pick a repo'}
          />
        </div>
        <label className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Branch, commit, author, card or !MR"
            aria-label="Search branches"
            className="h-11 pl-9"
          />
        </label>
        <div className="w-full sm:w-56" title="The author of each branch's last commit">
          <Dropdown
            multiple
            label="Created by"
            allLabel="Everyone"
            options={authorOptions}
            value={authors}
            onChange={setAuthors}
            icon={UserRound}
            width="full"
            searchable={authorOptions.length > 6}
            placeholder="Everyone"
            disabled={!q.data}
          />
        </div>
        <Button
          variant="outline"
          className="h-11"
          disabled={!repo || noWorkspace || fetchOrigin.isPending}
          title={
            noWorkspace ? 'No workspace on this Mac holds this repo' : 'git fetch origin on the Mac'
          }
          onClick={() => repo && fetchOrigin.mutate({ repo })}
        >
          <RefreshCw
            className={cn('size-4', fetchOrigin.isPending && 'motion-safe:animate-spin')}
          />
          Fetch
        </Button>
      </div>

      <div className="br-filters" role="group" aria-label="Filter branches">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="br-filter"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span className="br-filter-n">{searched.filter(f.test).length}</span>
          </button>
        ))}
        <span className="flex-1" />
        {selecting && (
          <button
            type="button"
            className="br-filter"
            onClick={() =>
              setSelected((cur) => {
                const next = new Set(cur);
                for (const r of selectable) {
                  if (allShownSelected) next.delete(r.name);
                  else next.add(r.name);
                }
                return next;
              })
            }
          >
            {allShownSelected ? 'Unselect shown' : `Select all shown`}
            <span className="br-filter-n">{selectable.length}</span>
          </button>
        )}
        <button
          type="button"
          className="br-filter"
          aria-pressed={selecting}
          onClick={() => {
            setSelecting((v) => !v);
            setSelected(new Set());
          }}
        >
          <CheckSquare aria-hidden className="size-3.5" /> {selecting ? 'Done' : 'Select'}
        </button>
      </div>

      {fetchOrigin.data?.fetchFailed && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>
            {fetchOrigin.data.fetchFailed.reason === 'network'
              ? 'Can’t reach GitLab — is the VPN on?'
              : fetchOrigin.data.fetchFailed.reason === 'auth'
                ? 'GitLab refused the fetch'
                : 'Fetch failed'}
          </AlertTitle>
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {fetchOrigin.data.fetchFailed.message}
          </AlertDescription>
        </Alert>
      )}
      {fetchOrigin.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Fetch failed</AlertTitle>
          <AlertDescription>{describeError(fetchOrigin.error)}</AlertDescription>
        </Alert>
      )}
      {q.data && <SourceNotice which="local" state={q.data.sources.local} />}
      {q.data && <SourceNotice which="remote" state={q.data.sources.remote} />}
      {q.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Could not list branches</AlertTitle>
          <AlertDescription>{describeError(q.error)}</AlertDescription>
        </Alert>
      )}

      {!repo && !repos.isPending && (
        <p className="text-sm text-muted-foreground">
          No repository yet. <Link to="/settings#repos">Add one in Settings</Link>.
        </p>
      )}

      {repo && (q.isPending || shown.length > 0) && (
        <ul className="br-list" aria-busy={q.isPending}>
          {q.isPending
            ? Array.from({ length: 6 }, (_, i) => <li key={i} className="br-skel" aria-hidden />)
            : shown
                .slice(0, limit)
                .map((r, i) => (
                  <Row
                    key={r.name}
                    repo={repo}
                    base={q.data!.baseBranch}
                    row={r}
                    index={Math.min(i, 20)}
                    canRun={!noWorkspace}
                    onLink={() => setLinking(r)}
                    onDelete={() => setDeleting(r)}
                    selecting={selecting}
                    selected={selected.has(r.name)}
                    onToggle={(range) => toggle(r.name, range)}
                  />
                ))}
        </ul>
      )}
      {q.data && shown.length === 0 && (
        <p className="rounded-sheet border border-dashed border-hairline p-6 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? 'No branches found.' : 'No branch matches this filter.'}
        </p>
      )}
      {shown.length > limit && (
        <Button variant="ghost" className="self-center" onClick={() => setLimit((n) => n + PAGE)}>
          Show {Math.min(PAGE, shown.length - limit)} more
        </Button>
      )}
      {q.data?.truncated && (
        <p className="text-center text-xs text-muted-foreground">
          GitLab has more branches than one read lists: search narrows it down.
        </p>
      )}

      {selecting && selected.size > 0 && (
        <div className="br-bulkbar" {...BOTTOM_BAR} role="region" aria-label="Selected branches">
          <span className="text-sm">
            <span className="font-mono font-medium">{selected.size}</span> selected
          </span>
          {othersSelected > 0 && (
            <span className="br-bulkbar-warn">
              <TriangleAlert aria-hidden className="size-3.5" />
              {othersSelected} of these {othersSelected > 1 ? 'are' : 'is'} by someone else
            </span>
          )}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            <X className="size-4" /> Clear
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setBulkOpen(true)}>
            <Trash2 className="size-4" /> Delete…
          </Button>
        </div>
      )}
      {bulkOpen && repo && q.data && (
        <BulkDeleteDialog
          repo={repo}
          list={q.data}
          names={[...selected]}
          onClose={(done) => {
            setBulkOpen(false);
            if (done) {
              setSelected(new Set());
              setSelecting(false);
            }
          }}
        />
      )}
      {deleting && repo && q.data && (
        <DeleteBranchDialog
          repo={repo}
          row={deleting}
          hasWorkspace={!!q.data.workspaceId}
          workspaceId={q.data.workspaceId}
          base={q.data.baseBranch}
          gitlabOk={q.data.sources.remote.ok}
          onClose={() => setDeleting(null)}
        />
      )}
      {linking && repo && (
        <CardLinkDialog
          repo={repo}
          branch={linking.name}
          currentCardId={linking.card?.id ?? null}
          linked={linking.card?.linked ?? false}
          onClose={() => setLinking(null)}
        />
      )}
    </div>
  );
}

function SourceNotice({ which, state }: { which: 'local' | 'remote'; state: BranchSourceState }) {
  if (state.ok) return null;
  const quiet = state.code === 'no_workspace';
  return (
    <Alert variant={quiet ? 'default' : 'warning'}>
      <TriangleAlert />
      <AlertTitle>
        {which === 'local'
          ? state.code === 'no_workspace'
            ? 'Remote branches only'
            : state.code === 'agent_outdated'
              ? 'Restart the host agent'
              : 'Local branches unavailable'
          : state.code === 'gitlab_unreachable'
            ? 'GitLab unreachable'
            : 'Remote branches unavailable'}
      </AlertTitle>
      <AlertDescription>
        {state.message}{' '}
        {state.code === 'no_workspace' && (
          <Link to="/settings#workspaces" className="underline">
            Add a workspace
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

function Row({
  repo,
  base,
  row: r,
  index,
  canRun,
  onLink,
  onDelete,
  selecting,
  selected,
  onToggle,
}: {
  repo: string;
  base: string;
  row: BranchRow;
  index: number;
  canRun: boolean;
  onLink: () => void;
  onDelete: () => void;
  selecting: boolean;
  selected: boolean;
  onToggle: (range: boolean) => void;
}) {
  const compare = `/review/${encodeURIComponent(repo)}/compare?${new URLSearchParams({ from: base, to: r.name }).toString()}`;
  const where = r.local && r.remote ? null : r.local ? 'local only' : 'origin only';
  const locked = undeletable(r);
  return (
    <li
      className={cn('br-row', selecting && 'br-row-selecting')}
      data-kind={kindOf(r)}
      data-selected={selected}
      style={{ ['--i' as string]: index }}
    >
      {selecting && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          disabled={locked}
          className="br-select"
          aria-label={locked ? `${r.name} cannot be selected` : `Select ${r.name}`}
          title={
            r.isBase
              ? 'The base branch is never deleted from Relay'
              : r.protected
                ? 'Protected on GitLab: never deleted from Relay'
                : locked
                  ? 'Reserved branch: never deleted from Relay'
                  : 'Shift-click selects a range'
          }
          onClick={(e) => onToggle(e.shiftKey)}
        >
          {selected && <Check className="size-3" />}
        </button>
      )}
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="br-name">{r.name}</span>
          {r.isBase && <span className="br-tag">base</span>}
          {!r.isBase && locked && (
            <span className="br-tag" title="Never deleted from Relay">
              {r.protected ? 'protected' : 'reserved'}
            </span>
          )}
          {!locked && r.mine === false && (
            <span className="br-tag" data-tone="warn" title={r.authorEmail ?? undefined}>
              by {r.author ?? r.authorEmail ?? 'someone else'}
            </span>
          )}
          {!locked && r.mine === null && (
            <span
              className="br-tag"
              data-tone="muted"
              title="Relay cannot tell whose branch this is"
            >
              owner unknown
            </span>
          )}
          {r.current && (
            <span className="br-tag" data-tone="current" title="Checked out in the repo workspace">
              checked out
            </span>
          )}
          {r.mr && (
            <span className="br-tag" data-tone="mr" title={r.mr.title}>
              !{r.mr.iid}
              {r.mr.draft ? ' draft' : ''}
            </span>
          )}
          {where && (
            <span className="br-tag" data-tone={r.local ? 'warn' : 'muted'}>
              {where}
            </span>
          )}
          {r.track && (r.track.ahead > 0 || r.track.behind > 0) && (
            <span className="br-tag" data-tone="muted" title="Against its upstream">
              {r.track.ahead > 0 && (
                <>
                  <ArrowUp aria-hidden className="size-3" />
                  {r.track.ahead}
                </>
              )}
              {r.track.behind > 0 && (
                <>
                  <ArrowDown aria-hidden className="size-3" />
                  {r.track.behind}
                </>
              )}
            </span>
          )}
          {r.holder && (
            <span className="br-tag" data-tone="muted" title={r.holder.path}>
              worktree · {r.holder.name}
            </span>
          )}
          {r.track?.gone && (
            <span className="br-tag" data-tone="warn" title="Its upstream was deleted on origin">
              upstream gone
            </span>
          )}
          {r.merged && !r.isBase && <span className="br-tag">merged</span>}
        </div>
        {r.subject && <p className="truncate text-sm text-muted-foreground">{r.subject}</p>}
        <div className="br-meta">
          {r.author && <span>{r.author}</span>}
          <TimeAgo at={r.committedAt} />
          {!r.isBase &&
            (r.card ? (
              <button
                type="button"
                className="br-card"
                onClick={onLink}
                title={
                  r.card.linked ? 'Linked in Relay — change' : 'Matched by Branch formula — change'
                }
              >
                {r.card.linked ? (
                  <Link2 aria-hidden className="size-3.5 shrink-0 text-emphasis" />
                ) : (
                  <NotebookText aria-hidden className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{r.card.title}</span>
              </button>
            ) : (
              <button type="button" className="br-card-missing" onClick={onLink}>
                <Link2 aria-hidden className="size-3.5" /> No card · link one
              </button>
            ))}
        </div>
      </div>

      <div className="br-actions">
        <Link
          to={testBenchPath(repo, r.name, { run: true })}
          className="br-run"
          aria-disabled={!canRun}
          title={
            canRun
              ? `Check out ${r.name} on the Mac and run it on a device`
              : 'No workspace on this Mac'
          }
        >
          <Play aria-hidden className="size-3.5 fill-current" /> Run
        </Link>
        {r.mr ? (
          <>
            <Link
              to={`/review/${encodeURIComponent(repo)}/mr/${r.mr.iid}`}
              className="rv-icon-btn"
              title={`Review !${r.mr.iid}`}
              aria-label={`Review !${r.mr.iid}`}
            >
              <ScanSearch className="size-4" />
            </Link>
            <Link
              to={`/mrs/${encodeURIComponent(repo)}/${r.mr.iid}`}
              className="rv-icon-btn"
              title={`Open !${r.mr.iid}`}
              aria-label={`Open !${r.mr.iid}`}
            >
              <Inbox className="size-4" />
            </Link>
          </>
        ) : (
          !r.isBase &&
          (r.remote ? (
            <Link
              to={mrCreatePath(repo, r.name)}
              className="rv-icon-btn"
              title={r.card ? 'Create MR' : 'Create MR (needs a card — you can link one there)'}
              aria-label="Create MR"
            >
              <GitPullRequestCreate className="size-4" />
            </Link>
          ) : (
            <span
              className="rv-icon-btn opacity-40"
              title="Push it to origin first to create an MR"
              aria-label="Create MR unavailable: not on origin"
            >
              <GitPullRequestCreate className="size-4" />
            </span>
          ))
        )}
        {!r.isBase && r.remote && (
          <Link
            to={compare}
            className="rv-icon-btn"
            title={`Compare with ${base}`}
            aria-label={`Compare with ${base}`}
          >
            <GitCompare className="size-4" />
          </Link>
        )}
        {!locked && (
          <button
            type="button"
            className="rv-icon-btn br-trash"
            onClick={onDelete}
            title={`Delete ${r.name}`}
            aria-label={`Delete ${r.name}`}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}
