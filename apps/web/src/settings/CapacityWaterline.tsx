import { Calculator, Check } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { formatHours } from '@relay/shared';
import { NumberField, type NumberUnit } from '@/components/ui/number-field';
import { useSprints } from '@/lib/sprintsApi';
import { cn } from '@/lib/utils';

/** `formatHours` reads 8 h as a day; the field agrees, and a week is five of them. */
export const HOUR_UNITS: readonly NumberUnit[] = [
  { suffix: 'h', factor: 1 },
  { suffix: 'd', factor: 8 },
  { suffix: 'w', factor: 40 },
];
const MAX_HOURS = 10_000;
const BARS = 8;
const CHART_PX = 128;
/** The waterline sticks to a sprint's load or the median when this close. */
const SNAP_PX = 6;

const median = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const roundHours = (h: number) => Math.max(1, Math.round(h));

/**
 * Sprint capacity, set where it means something: the number itself (typed, `2w`, `5d`), a waterline over the last
 * sprints' loads that you can drag, a click on a sprint to match it, and a team calculator. Saves each settled value.
 */
export function CapacityWaterline({
  saved,
  onSave,
  pending,
  justSaved,
  id,
  describedBy,
}: {
  saved: number;
  onSave: (hours: number) => void;
  pending: boolean;
  justSaved: boolean;
  id: string;
  describedBy?: string;
}) {
  const [value, setValue] = useState(saved);
  const [syncedFrom, setSyncedFrom] = useState(saved);
  if (saved !== syncedFrom) {
    setSyncedFrom(saved);
    setValue(saved);
  }
  const save = (h: number) => {
    const v = Math.min(MAX_HOURS, Math.max(1, h));
    setValue(v);
    if (v !== saved) onSave(v);
  };

  const sprints = useSprints();
  const recent = (sprints.data?.sprints ?? []).filter((s) => s.loadHours > 0).slice(0, BARS);
  const bars = [...recent].reverse();
  const loads = recent.map((s) => s.loadHours);
  const med = median(loads);
  const busiest = loads.length ? Math.max(...loads) : null;
  const [team, setTeam] = useState(false);

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-start">
      <div className="grid content-start gap-2">
        <div className="flex items-center gap-2">
          <NumberField
            id={id}
            size="lg"
            className="w-full"
            value={value}
            min={1}
            max={MAX_HOURS}
            step={1}
            precision={1}
            unit="h"
            units={HOUR_UNITS}
            aria-describedby={describedBy}
            onChange={setValue}
            onCommit={save}
          />
          <span
            aria-live="polite"
            className={cn(
              'flex shrink-0 items-center gap-1 text-xs text-success transition-opacity duration-300',
              justSaved && !pending ? 'opacity-100' : 'opacity-0',
            )}
          >
            <Check className="size-3.5" />
            Saved
          </span>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          ≈ {formatHours(value)}
          {value >= 40 ? ` · ${Math.round((value / 40) * 10) / 10} wk of one person` : ''}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {med !== null && recent.length >= 2 && (
            <Chip
              title={`Median load of the last ${recent.length} sprints`}
              active={roundHours(med) === value}
              onClick={() => save(roundHours(med))}
            >
              Median {roundHours(med)} h
            </Chip>
          )}
          {busiest !== null && busiest !== med && (
            <Chip active={roundHours(busiest) === value} onClick={() => save(roundHours(busiest))}>
              Busiest {roundHours(busiest)} h
            </Chip>
          )}
          <Chip active={team} onClick={() => setTeam((t) => !t)} aria-expanded={team}>
            <Calculator className="size-3" />
            Team
          </Chip>
        </div>
        {team && <TeamCalculator onUse={(h) => save(h)} />}
      </div>

      <Waterline
        bars={bars.map((s) => ({ name: s.name, load: s.loadHours, done: s.doneHours }))}
        value={value}
        snaps={[...loads, ...(med !== null ? [med] : [])]}
        loading={sprints.isLoading}
        onChange={setValue}
        onCommit={save}
      />
    </div>
  );
}

function Chip({
  active,
  className,
  ...props
}: React.ComponentProps<'button'> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 font-mono text-xs tabular-nums transition-colors',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-input text-muted-foreground hover:border-foreground hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/** People × working days × focus hours a day. Only the result is saved. */
function TeamCalculator({ onUse }: { onUse: (hours: number) => void }) {
  const [people, setPeople] = useState(1);
  const [days, setDays] = useState(10);
  const [focus, setFocus] = useState(6);
  const total = Math.round(people * days * focus * 10) / 10;
  const part = (
    label: string,
    v: number,
    set: (n: number) => void,
    max: number,
    unit: string,
    step = 1,
  ) => (
    <label className="grid gap-1">
      <span className="type-micro text-muted-foreground">{label}</span>
      <NumberField
        className="w-full"
        value={v}
        min={step}
        max={max}
        step={step}
        unit={unit}
        aria-label={label}
        onChange={set}
        onCommit={set}
      />
    </label>
  );
  return (
    <div className="grid gap-2 rounded-control border border-hairline bg-muted/40 p-2.5">
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-end gap-1.5">
        {part('People', people, setPeople, 100, 'ppl')}
        <span className="pb-1.5 text-muted-foreground">×</span>
        {part('Days', days, setDays, 60, 'd')}
        <span className="pb-1.5 text-muted-foreground">×</span>
        {part('Focus / day', focus, setFocus, 24, 'h', 0.5)}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm tabular-nums">= {total} h</span>
        <button
          type="button"
          disabled={total < 1 || total > MAX_HOURS}
          className="h-7 rounded-control bg-foreground px-2.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          onClick={() => onUse(total)}
        >
          Use {total} h
        </button>
      </div>
    </div>
  );
}

interface Bar {
  name: string;
  load: number;
  done: number;
}

/** The last sprints' loads as hulls, the capacity as the sea level over them. Drag it, or click a sprint. */
function Waterline({
  bars,
  value,
  snaps,
  loading,
  onChange,
  onCommit,
}: {
  bars: readonly Bar[];
  value: number;
  snaps: readonly number[];
  loading: boolean;
  onChange: (h: number) => void;
  onCommit: (h: number) => void;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const drag = useRef<{ last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (keyTimer.current) clearTimeout(keyTimer.current);
    },
    [],
  );

  const top = Math.max(value, ...bars.map((b) => b.load), 8) * 1.18;
  const pct = (h: number) => Math.min(100, (h / top) * 100);
  const sortedSnaps = [...new Set(snaps.map(roundHours))].sort((a, b) => a - b);

  const hoursAt = (clientY: number, free: boolean) => {
    const r = plot.current!.getBoundingClientRect();
    const y = Math.min(r.bottom, Math.max(r.top, clientY));
    const raw = ((r.bottom - y) / r.height) * top;
    if (!free) {
      const near = sortedSnaps.find(
        (s) => Math.abs((s / top) * r.height - (raw / top) * r.height) <= SNAP_PX,
      );
      if (near !== undefined) return near;
    }
    return roundHours(raw);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !plot.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const h = hoursAt(e.clientY, e.shiftKey);
    drag.current = { last: h };
    setDragging(true);
    onChange(h);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const h = hoursAt(e.clientY, e.shiftKey);
    if (h === drag.current.last) return;
    drag.current.last = h;
    onChange(h);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d) onCommit(d.last);
  };
  const commitSoon = (h: number) => {
    onChange(h);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => onCommit(h), 600);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? 10 : 1;
    let next: number | undefined;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = value + by;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = value - by;
    else if (e.key === 'PageUp') next = sortedSnaps.find((s) => s > value) ?? value;
    else if (e.key === 'PageDown')
      next = [...sortedSnaps].reverse().find((s) => s < value) ?? value;
    else return;
    e.preventDefault();
    commitSoon(Math.min(MAX_HOURS, Math.max(1, next)));
  };

  const level = pct(value);
  return (
    <div className="grid gap-1.5">
      <div
        ref={plot}
        className={cn(
          'relative overflow-hidden rounded-control border border-hairline bg-muted/30 select-none',
          dragging ? 'cursor-grabbing' : 'cursor-ns-resize',
        )}
        style={{ height: CHART_PX }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* The sea below the waterline. */}
        <div
          aria-hidden
          className={cn(
            'absolute inset-x-0 bottom-0 bg-river/20',
            !dragging && 'transition-[height] duration-200 ease-out motion-reduce:transition-none',
          )}
          style={{ height: `${level}%` }}
        />
        <div className="absolute inset-x-3 inset-y-0 flex items-end justify-around gap-2">
          {bars.map((b) => {
            const over = Math.max(0, b.load - value);
            const under = b.load - over;
            return (
              <button
                key={b.name}
                type="button"
                title={`${b.name}: ${formatHours(b.load)} loaded, ${formatHours(b.done)} done. Click to match.`}
                aria-label={`Match ${b.name}: ${formatHours(b.load)}`}
                className="group/bar relative flex h-full max-w-10 flex-1 cursor-pointer flex-col justify-end"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onCommit(roundHours(b.load))}
              >
                <span
                  aria-hidden
                  className="w-full rounded-t-[2px] bg-destructive/80 transition-[height] duration-200 motion-reduce:transition-none"
                  style={{ height: `${(over / top) * 100}%` }}
                />
                <span
                  aria-hidden
                  className="w-full bg-[var(--harbor-hull)] transition-[height,opacity] duration-200 group-hover/bar:opacity-80 motion-reduce:transition-none"
                  style={{ height: `${(under / top) * 100}%` }}
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 mb-0.5 -translate-x-1/2 rounded-sm bg-foreground px-1 font-mono text-[10px] text-background opacity-0 transition-opacity group-hover/bar:opacity-100"
                  style={{ bottom: `${pct(b.load)}%` }}
                >
                  {formatHours(b.load)}
                </span>
              </button>
            );
          })}
        </div>
        {/* The waterline itself, a focusable handle for the keyboard. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Capacity waterline"
          aria-valuemin={1}
          aria-valuemax={MAX_HOURS}
          aria-valuenow={value}
          aria-valuetext={`${value} h. Page Up and Page Down jump between sprint loads.`}
          className={cn(
            'group/line absolute inset-x-0 h-0 outline-none',
            !dragging && 'transition-[bottom] duration-200 ease-out motion-reduce:transition-none',
          )}
          style={{ bottom: `${level}%` }}
          onKeyDown={onKey}
        >
          <div className="absolute inset-x-0 -top-px border-t-2 border-dashed border-river-ink group-focus-visible/line:border-solid" />
          <span className="absolute right-1.5 bottom-1 rounded-sm bg-river-ink px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-white shadow-sm group-focus-visible/line:ring-2 group-focus-visible/line:ring-ring">
            {value} h
          </span>
        </div>
        {!bars.length && (
          <p className="absolute inset-x-3 top-3 text-xs text-muted-foreground">
            {loading
              ? 'Reading your sprints…'
              : 'No sprint loads yet. Sprints with estimated cards show here to set the line against.'}
          </p>
        )}
      </div>
      {bars.length > 0 && (
        <div className="flex justify-around gap-2 px-3">
          {bars.map((b) => (
            <span
              key={b.name}
              className="max-w-10 flex-1 truncate text-center font-mono text-[10px] text-muted-foreground"
              title={b.name}
            >
              {b.name}
            </span>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Drag the line or click a sprint. Red is what went over. Shift drags freely.
      </p>
    </div>
  );
}
