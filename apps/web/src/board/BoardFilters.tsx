import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { NO_FILTERS, type BoardFilters } from './model';

/**
 * Search the board: every word must match a card's title, status, type, assignees, or its MR's number (`!123`) or
 * title. `/` focuses it from anywhere on the page; Escape clears it.
 */
function BoardSearch({
  value,
  onChange,
  matches,
}: {
  value: string;
  onChange: (v: string) => void;
  matches: number | null;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="grid gap-1">
      <Label htmlFor="board-search" className="text-xs text-muted-foreground">
        Search
        {value && matches !== null && (
          <span className="ml-2 font-mono text-foreground">
            {matches} match{matches === 1 ? '' : 'es'}
          </span>
        )}
      </Label>
      <div className="relative w-full sm:w-72">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={ref}
          id="board-search"
          type="search"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="Title, !MR, assignee…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault();
              e.stopPropagation();
              onChange('');
            }
          }}
          className={cn(
            'flex h-9 w-full rounded-control border border-input bg-card/60 pr-14 pl-9 text-sm transition-colors outline-none placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:border-foreground focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden',
            value && 'border-foreground bg-card',
          )}
        />
        {value ? (
          <button
            type="button"
            aria-label="Clear the search"
            onClick={() => {
              onChange('');
              ref.current?.focus();
            }}
            className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground hover:text-background focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        ) : (
          <kbd
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-[3px] border border-hairline px-1.5 font-mono text-2xs text-muted-foreground"
          >
            /
          </kbd>
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = `board-filter-${label.toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="w-44">
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function BoardFilterBar({
  filters,
  onChange,
  repos,
  assignees,
  types,
  matches = null,
}: {
  /** How many cards the filters leave, shown next to the search while it has text. */
  matches?: number | null;
  filters: BoardFilters;
  onChange: (f: BoardFilters) => void;
  repos: { id: string; name: string }[];
  assignees: string[];
  types: string[];
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <BoardSearch
        value={filters.query ?? ''}
        onChange={(query) => onChange({ ...filters, query })}
        matches={matches}
      />
      <FilterSelect
        label="Repo"
        value={filters.repo}
        onChange={(repo) => onChange({ ...filters, repo })}
        options={repos.map((r) => ({ value: r.id, label: r.name }))}
      />
      <FilterSelect
        label="Assignee"
        value={filters.assignee}
        onChange={(assignee) => onChange({ ...filters, assignee })}
        options={assignees.map((a) => ({ value: a, label: a }))}
      />
      <FilterSelect
        label="Type"
        value={filters.type}
        onChange={(type) => onChange({ ...filters, type })}
        options={types.map((t) => ({ value: t, label: t }))}
      />
      {(filters.repo || filters.assignee || filters.type || filters.query) && (
        <button
          type="button"
          className="h-9 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => onChange(NO_FILTERS)}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
