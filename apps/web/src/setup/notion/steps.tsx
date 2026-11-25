import { useMemo, useState } from 'react';
import type { NotionMe, NotionSchemaView } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { useNotionDataSources } from '@/lib/oauthApi';
import { cn } from '@/lib/utils';
import { OAuthConnect } from '@/settings/OAuthConnect';
import { candidates, GROUPS, ROLES, type GroupKey, type RoleKey } from './autoMap';

/** Text of one sample card's column, as Notion shows it. */
export function sampleOf(view: NotionSchemaView | undefined, column: string | undefined): string {
  if (!view || !column) return '';
  for (const s of view.samples) {
    const v = s[column];
    if (v) return v;
  }
  return '';
}

// ───────────────────────────── Connect ─────────────────────────────

export function ConnectStep({ connected }: { connected: boolean }) {
  return (
    <div className="grid gap-6">
      <div className={cn('sb-plug', connected && 'sb-plug-live')} role="status" aria-live="polite">
        <span className="sb-plug-end font-mono text-xs">Notion</span>
        <span className="sb-wire" data-live={connected} aria-hidden />
        <span className="sb-plug-end font-mono text-xs">Relay</span>
      </div>
      <OAuthConnect
        provider="notion"
        what="A Notion tab opens. Sign in, then tick the board database (and any database Relay should read). Come back here when it says connected."
      />
    </div>
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
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list.data ?? []).filter((d) => !t || d.title.toLowerCase().includes(t));
  }, [list.data, q]);
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
      {list.data && shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {list.data.length === 0
            ? 'Notion shares no database with Relay yet. Connect again and tick your board on Notion’s page.'
            : 'Nothing by that name.'}
        </p>
      ) : null}
      <ul className="sb-db-list" aria-busy={list.isFetching}>
        {shown.map((d) => {
          const on = d.id === value;
          return (
            <li key={d.id}>
              <button
                type="button"
                className={cn('sb-db', on && 'sb-db-on')}
                aria-pressed={on}
                onClick={() => onPick({ id: d.id, title: d.title })}
              >
                <span className="sb-db-jack" aria-hidden />
                <span className="grid min-w-0 gap-0.5 text-left">
                  <span className="truncate text-base font-medium">{d.title}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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
  return (
    <div className="grid gap-4">
      <ol className="sb-board">
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

export function StatusesStep({
  options,
  ready,
  groups,
  onReady,
  onToggle,
}: {
  options: string[];
  ready: string;
  groups: Record<GroupKey, string[]>;
  onReady: (s: string) => void;
  onToggle: (group: GroupKey, status: string) => void;
}) {
  return (
    <div className="grid gap-8">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Which status means “ready for QA”?</legend>
        <p className="text-xs text-muted-foreground">
          Relay moves a card here when its merge request is ready, and after a release.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {options.map((s) => (
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
      </fieldset>

      <div className="grid gap-3">
        <p className="text-sm font-medium">How each status counts</p>
        <div className="sb-matrix-wrap">
          <table className="sb-matrix">
            <thead>
              <tr>
                <th scope="col" className="sr-only">
                  Status
                </th>
                {GROUPS.map((g) => (
                  <th key={g.key} scope="col" title={g.hint}>
                    {g.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {options.map((s) => (
                <tr key={s}>
                  <th scope="row">{s}</th>
                  {GROUPS.map((g) => {
                    const on = groups[g.key].includes(s);
                    return (
                      <td key={g.key}>
                        <button
                          type="button"
                          className="sb-dot"
                          data-on={on}
                          aria-pressed={on}
                          aria-label={`${s}: ${g.label}`}
                          onClick={() => onToggle(g.key, s)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.key} className="grid gap-0.5">
              <dt className="font-medium">{g.label}</dt>
              <dd className="text-muted-foreground">{g.means}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// ───────────────────────────── You ─────────────────────────────

/** "My names": who you are on the Developer column. The sync only reads cards that tag your Notion user id. */
export function YouStep({
  me,
  meError,
  aliases,
  onChange,
}: {
  me: NotionMe | undefined;
  meError: unknown;
  aliases: string;
  onChange: (v: string) => void;
}) {
  const hasId = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i.test(aliases);
  return (
    <div className="grid gap-4">
      {me ? (
        <p className="text-base">
          Notion knows you as <span className="font-medium">{me.name ?? me.email ?? me.id}</span>.
        </p>
      ) : null}
      <label className="grid gap-1.5">
        <span className="text-sm font-medium">My names</span>
        <Input
          value={aliases}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 text-base"
        />
        <span className="text-xs text-muted-foreground">
          Comma separated: your Notion user id (required: the sync reads only the cards that tag
          it), plus your name or email as they appear on the Developer column.
        </span>
      </label>
      {!hasId ? (
        <p role="alert" className="text-sm text-destructive">
          {meError
            ? `Relay could not read your Notion user id (${describeError(meError)}). Paste it here.`
            : 'Your Notion user id is still missing.'}
        </p>
      ) : null}
    </div>
  );
}
