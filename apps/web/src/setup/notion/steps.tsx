import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Table2 } from 'lucide-react';
import { formatAgo, type NotionMe, type NotionPerson, type NotionSchemaView } from '@relay/shared';
import { initials, PickRow, PickTag } from '@/components/PickRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { useNotionDataSources, useNotionPeople } from '@/lib/oauthApi';
import { cn } from '@/lib/utils';
import { OAuthConnect } from '@/settings/OAuthConnect';
import { PatchBay, useWiringView, WiringViewSwitch } from './PatchBay';
import { candidates, ROLES, sampleOf, STAGES, type RoleKey, type StageKey } from './autoMap';

export { sampleOf } from './autoMap';

// ───────────────────────────── Connect ─────────────────────────────

export function ConnectStep({
  connected,
  onUseToken,
}: {
  connected: boolean;
  onUseToken: () => void;
}) {
  return (
    <div className="grid gap-6">
      <Plug live={connected} />
      <OAuthConnect
        provider="notion"
        what="A Notion tab opens. Sign in, then tick the board database (and any database Relay should read). Come back here when it says connected."
      />
      <p className="text-sm text-muted-foreground">
        Board not in Notion’s list? The list shows only databases you have Full access to.{' '}
        <button type="button" className="underline underline-offset-2" onClick={onUseToken}>
          Use a personal access token instead
        </button>
        : it reads every database your account can open.
      </p>
    </div>
  );
}

/** Advanced mode's way in: a personal access token (or integration secret), saved here, read with right away. */
export function TokenStep({
  tokenSet,
  saving,
  error,
  onSave,
  onUseSignIn,
}: {
  tokenSet: boolean;
  saving: boolean;
  error: unknown;
  onSave: (token: string) => void;
  onUseSignIn: () => void;
}) {
  const [token, setToken] = useState('');
  return (
    <div className="grid gap-6">
      <Plug live={tokenSet} />
      <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          Open{' '}
          <a
            href="https://www.notion.so/developers/tokens"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            Notion personal access tokens
          </a>{' '}
          and press <span className="text-foreground">New token</span>. Pick your workspace, tick
          the <span className="text-foreground">Notion API</span> capability, then{' '}
          <span className="text-foreground">Create token</span>.
        </li>
        <li>
          Copy it and paste it here. Relay reads what your account can open; nothing to share. The
          token expires (1 year by default): make a new one and paste it here then.
        </li>
      </ol>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) onSave(token.trim());
        }}
      >
        <Input
          aria-label="Personal access token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={tokenSet ? 'Token saved. Paste a new one to replace it.' : 'ntn_…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-11 min-w-64 flex-1 text-base"
        />
        <Button type="submit" size="lg" disabled={!token.trim() || saving}>
          {saving ? 'Saving…' : tokenSet ? 'Replace' : 'Save token'}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(error)}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <button type="button" className="underline underline-offset-2" onClick={onUseSignIn}>
          Sign in with Notion instead
        </button>
      </p>
    </div>
  );
}

function Plug({ live }: { live: boolean }) {
  return (
    <div className={cn('sb-plug', live && 'sb-plug-live')} role="status" aria-live="polite">
      <span className="sb-plug-end font-mono text-xs">Notion</span>
      <span className="sb-wire" data-live={live} aria-hidden />
      <span className="sb-plug-end font-mono text-xs">Relay</span>
    </div>
  );
}

// ───────────────────────────── paging ─────────────────────────────

const PAGE_SIZE = 5;

/** One page of a filtered list. Starts on the page holding `selected`; a new filter goes back to page 1. */
function usePaged<T>(items: readonly T[], isSelected: (x: T) => boolean, filterKey: string) {
  const [page, setPage] = useState<{ key: string; at: number } | null>(null);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  let at: number;
  if (page && page.key === filterKey) at = page.at;
  else {
    const i = filterKey ? -1 : items.findIndex(isSelected);
    at = i < 0 ? 0 : Math.floor(i / PAGE_SIZE);
  }
  at = Math.min(at, pages - 1);
  return {
    shown: items.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE),
    pager:
      pages > 1 ? (
        <Pager
          at={at}
          pages={pages}
          total={items.length}
          onGo={(n) => setPage({ key: filterKey, at: n })}
        />
      ) : null,
  };
}

function Pager({
  at,
  pages,
  total,
  onGo,
}: {
  at: number;
  pages: number;
  total: number;
  onGo: (n: number) => void;
}) {
  const from = at * PAGE_SIZE + 1;
  const to = Math.min(total, from + PAGE_SIZE - 1);
  return (
    <nav className="sb-pager" aria-label="Pages">
      <span className="tabular-nums" aria-live="polite">
        <span className="text-foreground">
          {from}–{to}
        </span>{' '}
        of {total}
      </span>
      <span className="flex gap-1.5">
        <button
          type="button"
          className="sb-pager-btn"
          aria-label="Previous page"
          disabled={at === 0}
          onClick={() => onGo(at - 1)}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          className="sb-pager-btn"
          aria-label="Next page"
          disabled={at >= pages - 1}
          onClick={() => onGo(at + 1)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </span>
    </nav>
  );
}

// ───────────────────────────── the board picker ─────────────────────────────

export function DatabasePicker({
  value,
  onPick,
  label,
}: {
  value: string;
  onPick: (d: { id: string; title: string }) => void;
  label: string;
}) {
  const [q, setQ] = useState('');
  const list = useNotionDataSources(true);
  const t = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (list.data ?? []).filter((d) => !t || d.title.toLowerCase().includes(t)),
    [list.data, t],
  );
  const { shown, pager } = usePaged(filtered, (d) => d.id === value, t);
  return (
    <div className="grid gap-3">
      <Input
        aria-label={label}
        placeholder="Filter by name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="h-11 text-base"
      />
      {list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(list.error)}
        </p>
      ) : null}
      {list.isFetching && !list.data ? (
        <p className="text-sm text-muted-foreground">Looking in Notion…</p>
      ) : null}
      {list.data && filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {list.data.length === 0
            ? 'Notion shares no database with Relay yet. Connect again and tick your board on Notion’s page.'
            : 'Nothing by that name.'}
        </p>
      ) : null}
      <ul className="sb-db-list" aria-busy={list.isFetching}>
        {shown.map((d) => {
          const facts = [
            d.columns != null ? `${d.columns} column${d.columns === 1 ? '' : 's'}` : null,
            d.editedAt ? `edited ${formatAgo(Date.now() - Date.parse(d.editedAt))}` : null,
          ].filter(Boolean);
          return (
            <li key={d.id}>
              <PickRow
                selected={d.id === value}
                onSelect={() => onPick({ id: d.id, title: d.title })}
                leading={d.emoji ?? <Table2 className="size-[1.05rem]" strokeWidth={1.75} />}
                title={d.title}
                meta={facts.join(' · ') || null}
                trailing={d.boardLike ? <PickTag em>Status &amp; people</PickTag> : null}
              />
            </li>
          );
        })}
      </ul>
      {pager}
    </div>
  );
}

export function BoardPreview({ view }: { view: NotionSchemaView | undefined }) {
  if (!view) return null;
  const title = view.props.find((p) => p.type === 'title')?.name;
  const status = view.props.find((p) => p.name.toLowerCase() === 'status')?.name;
  if (view.samples.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        “{view.title}” has no cards yet. Relay will show them as soon as there are.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">Latest cards in “{view.title}”</p>
      <ul className="grid gap-1.5">
        {view.samples.slice(0, 3).map((s, i) => (
          <li key={i} className="sb-card-peek">
            <span className="truncate">{title ? s[title] : '(untitled)'}</span>
            {status && s[status] ? <span className="sb-status-chip">{s[status]}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────── Columns (the switchboard) ─────────────────────────────

export function ColumnsStep({
  view,
  map,
  onChange,
}: {
  view: NotionSchemaView;
  map: Partial<Record<RoleKey, string>>;
  onChange: (role: RoleKey, column: string | undefined) => void;
}) {
  const [showOptional, setShowOptional] = useState(ROLES.some((r) => !r.required && map[r.key]));
  const roles = ROLES.filter((r) => r.required || showOptional);
  const [mode, setMode] = useWiringView();
  const lines = roles.map((r) => ({
    key: r.key,
    label: r.label,
    required: r.required,
    fits: candidates(r, view.props),
  }));
  return (
    <div className="grid gap-4" data-wiring={mode}>
      <WiringViewSwitch value={mode} onChange={setMode} />
      <div className="sb-bay-wrap">
        <PatchBay
          view={view}
          lines={lines}
          map={map}
          onChange={(k, c) => onChange(k as RoleKey, c)}
        />
      </div>
      <ol className="sb-board sb-board-narrow">
        {roles.map((role) => {
          const opts = candidates(role, view.props);
          const col = map[role.key];
          const live = !!col;
          const sample = sampleOf(view, col);
          return (
            <li key={role.key} className="sb-row" data-live={live}>
              <div className="sb-role">
                <span className="text-sm font-medium">
                  {role.label}
                  {role.required ? null : (
                    <span className="font-normal text-muted-foreground"> (optional)</span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{role.hint}</span>
              </div>
              <span className="sb-wire" data-live={live} aria-hidden />
              <div className="sb-jack">
                <Select
                  aria-label={`Notion column for ${role.label}`}
                  value={col ?? ''}
                  onChange={(e) => onChange(role.key, e.target.value || undefined)}
                >
                  <option value="">{opts.length ? 'Not connected' : 'No column fits'}</option>
                  {opts.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <span className="sb-sample font-mono" title={sample}>
                  {live ? sample || 'empty on your latest cards' : ' '}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowOptional((v) => !v)}>
          {showOptional ? 'Hide the optional columns' : 'Show the optional columns'}
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────── Statuses ─────────────────────────────

const RATE_TEXT = {
  'left out': 'left out of the completion rate',
  unfinished: 'counts as unfinished',
  finished: 'counts as finished',
} as const;

/** One stage per status, with what that means shown next to it; then which "with QA" status is Ready to Test. */
export function StatusesStep({
  options,
  stages,
  ready,
  onStage,
  onReady,
}: {
  options: string[];
  stages: Record<string, StageKey>;
  ready: string;
  onStage: (status: string, stage: StageKey) => void;
  onReady: (s: string) => void;
}) {
  const qa = options.filter((s) => stages[s] === 'qa');
  return (
    <div className="grid gap-8">
      <dl className="sb-stages">
        {STAGES.map((g) => (
          <div key={g.key}>
            <dt>
              <span className="sb-stage-dot" data-stage={g.key} aria-hidden />
              {g.label}
            </dt>
            <dd>{g.hint}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-2">
        <p className="text-sm font-medium">Put each status of your board in one stage</p>
        <ul className="sb-stage-rows">
          {options.map((s) => {
            const st = STAGES.find((g) => g.key === (stages[s] ?? 'working'))!;
            return (
              <li key={s} data-stage={st.key}>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="sb-stage-dot" data-stage={st.key} aria-hidden />
                  <span className="truncate font-medium">{s}</span>
                </span>
                <Select
                  aria-label={`Stage of ${s}`}
                  value={st.key}
                  onChange={(e) => onStage(s, e.target.value as StageKey)}
                >
                  {STAGES.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label}
                    </option>
                  ))}
                </Select>
                <span className="flex flex-wrap gap-1.5">
                  <PickTag em={st.focus}>
                    {st.focus ? 'In Today’s focus' : 'Not in Today’s focus'}
                  </PickTag>
                  <PickTag>{RATE_TEXT[st.rate]}</PickTag>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Which one means “ready for QA”?</legend>
        <p className="text-xs text-muted-foreground">
          Relay moves a card here when its merge request is ready, and after a release. Only
          statuses in “With QA or finished” can be picked.
        </p>
        {qa.length ? (
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {qa.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={ready === s}
                className={cn('sb-chip', ready === s && 'sb-chip-on')}
                onClick={() => onReady(s)}
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            Put at least one status in “With QA or finished”.
          </p>
        )}
      </fieldset>
    </div>
  );
}

// ───────────────────────────── You ─────────────────────────────

const personLabel = (p: NotionPerson) => p.name ?? p.email ?? p.id;
const splitNames = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const HAS_USER_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/**
 * Who you are on the Developer column: pick yourself from the people on the board. The sync only reads cards that tag
 * your Notion user id; extra names (an old display name) can be added by hand.
 */
export function YouStep({
  me,
  meError,
  boardId,
  assigneeColumn,
  aliases,
  onChange,
}: {
  me: NotionMe | undefined;
  meError: unknown;
  boardId: string;
  assigneeColumn: string | undefined;
  aliases: string;
  onChange: (v: string) => void;
}) {
  const people = useNotionPeople(boardId || undefined, assigneeColumn);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const all = [...(people.data ?? [])];
    if (me && !all.some((p) => p.id === me.id)) all.push(me);
    // You first, then the rest by name.
    return all.sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : 0));
  }, [people.data, me]);
  const t = q.trim().toLowerCase();
  const filtered = list.filter(
    (p) => !t || `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(t),
  );
  const parts = splitNames(aliases);
  const picked = list.find((p) => parts.includes(p.id));
  const extra = parts.filter((x) => !picked || ![picked.id, picked.name, picked.email].includes(x));
  const { shown, pager } = usePaged(filtered, (p) => p.id === picked?.id, t);
  // Typed text kept as is, so a trailing comma survives while typing.
  const [extraText, setExtraText] = useState(() => extra.join(', '));
  const join = (p: NotionPerson | undefined, more: string[]) =>
    [...(p ? [p.id, p.name ?? '', p.email ?? ''] : []), ...more].filter(Boolean).join(', ');

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        People on the {assigneeColumn ?? 'Developer'} column of your board. Pick yourself.
      </p>
      {list.length > PAGE_SIZE ? (
        <Input
          aria-label="Filter people"
          placeholder="Filter by name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-11 text-base"
        />
      ) : null}
      {people.isFetching && !people.data ? (
        <p className="text-sm text-muted-foreground">Reading the board…</p>
      ) : null}
      {people.error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(people.error)}
        </p>
      ) : null}
      <ul className="sb-db-list">
        {shown.map((p) => (
          <li key={p.id}>
            <PickRow
              selected={p.id === picked?.id}
              onSelect={() => onChange(join(p, splitNames(extraText)))}
              leading={
                p.avatarUrl ? (
                  <img src={p.avatarUrl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="text-xs font-semibold tracking-wide">
                    {initials(personLabel(p))}
                  </span>
                )
              }
              title={personLabel(p)}
              meta={p.email && p.name ? p.email : null}
              trailing={p.id === me?.id ? <PickTag em>Signed in</PickTag> : null}
              pickedLabel="You"
            />
          </li>
        ))}
      </ul>
      {pager}
      {!picked && !HAS_USER_ID.test(aliases) ? (
        <p role="alert" className="text-sm text-destructive">
          {meError && !people.data?.length
            ? `Relay could not read your Notion user (${describeError(meError)}). Add your user id under Extra names.`
            : 'Pick yourself to continue.'}
        </p>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Extra names</summary>
        <label className="mt-2 grid gap-1.5">
          <Input
            aria-label="Extra names"
            value={extraText}
            onChange={(e) => {
              setExtraText(e.target.value);
              onChange(join(picked, splitNames(e.target.value)));
            }}
          />
          <span className="text-xs text-muted-foreground">
            Comma separated. Other names or emails that mean you on the board, such as an old
            display name. A Notion user id here also works.
          </span>
        </label>
      </details>
    </div>
  );
}
