import { Unplug, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NotionSchemaProp, NotionSchemaView } from '@relay/shared';
import { sampleOf } from './autoMap';

const TYPE_LABEL: Record<string, string> = {
  title: 'Title',
  status: 'Status',
  select: 'Select',
  multi_select: 'Multi-select',
  people: 'People',
  date: 'Date',
  formula: 'Formula',
  rich_text: 'Text',
  relation: 'Relation',
  number: 'Number',
  rollup: 'Rollup',
};

/** One thing Relay reads, and the board columns that can hold it. */
export interface BayLine {
  key: string;
  label: string;
  required: boolean;
  fits: readonly NotionSchemaProp[];
}

const VIEW_KEY = 'relay.setup.wiringView';

/** Classic list of dropdowns (the default) or the patch bay, remembered on this device. */
export function useWiringView() {
  const [view, setView] = useState<'bay' | 'classic'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'bay' ? 'bay' : 'classic';
    } catch {
      return 'classic';
    }
  });
  const set = (v: 'bay' | 'classic') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Private mode: the choice lasts this visit only.
    }
  };
  return [view, set] as const;
}

/** Switch between the patch bay and the classic list. Hidden on narrow screens, which always get the list. */
export function WiringViewSwitch({
  value,
  onChange,
}: {
  value: 'bay' | 'classic';
  onChange: (v: 'bay' | 'classic') => void;
}) {
  return (
    <div className="sb-viewswitch" role="radiogroup" aria-label="Wiring view">
      {(
        [
          ['bay', 'Patch bay'],
          ['classic', 'Classic'],
        ] as const
      ).map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          className="sb-viewswitch-opt"
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

interface Cable {
  key: string;
  col: string;
  d: string;
  required: boolean;
}

/** A soft cable between two points: leaves and arrives level, sags a little in between. */
function cablePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.55);
  const sag = Math.min(18, Math.abs(y2 - y1) * 0.08 + 6);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1 + sag}, ${x2 - dx} ${y2 + sag}, ${x2} ${y2}`;
}

/**
 * The patch bay: what Relay reads on the left, the board's columns on the right, a cable for every line. Press a line
 * to lift its cable (it follows the pointer), then press a column to plug it in. Hover either end to trace a cable.
 */
export function PatchBay({
  view,
  lines: roles,
  map,
  onChange,
  boardLabel = 'Your board',
}: {
  view: NotionSchemaView;
  lines: readonly BayLine[];
  map: Readonly<Record<string, string | undefined>>;
  onChange: (key: string, column: string | undefined) => void;
  boardLabel?: string;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  const [hot, setHot] = useState<{ role?: string; col?: string } | null>(null);
  const [ptr, setPtr] = useState<{ x: number; y: number } | null>(null);
  const [cables, setCables] = useState<Cable[]>([]);
  const [armedFrom, setArmedFrom] = useState<{ x: number; y: number } | null>(null);
  const bay = useRef<HTMLDivElement>(null);
  const roleJacks = useRef(new Map<string, HTMLElement>());
  const colJacks = useRef(new Map<string, HTMLElement>());

  const byName = useMemo(() => new Map(view.props.map((p) => [p.name, p])), [view.props]);
  const armedRole = armed ? (roles.find((r) => r.key === armed) ?? null) : null;
  const fits = useMemo(() => armedRole?.fits ?? [], [armedRole]);
  const fitNames = useMemo(() => new Set(fits.map((p) => p.name)), [fits]);

  // The board side: the patched columns in line order, then (while a cable is lifted) every other column that fits.
  const patched = useMemo(() => {
    const seen: string[] = [];
    for (const r of roles) {
      const c = map[r.key];
      if (c && !seen.includes(c) && byName.has(c)) seen.push(c);
    }
    return seen.map((n) => byName.get(n)!);
  }, [roles, map, byName]);
  // While a cable is lifted the board side shows only the columns it fits, lined up beside the lifted line.
  const shown = armed ? fits : patched;

  const ROW = 58;
  const shift =
    armed && armedFrom ? Math.max(0, Math.round(armedFrom.y - 48 - (fits.length * ROW) / 2)) : 0;

  const usesOf = (col: string) => roles.filter((r) => map[r.key] === col);

  const measure = useCallback(() => {
    const box = bay.current?.getBoundingClientRect();
    if (!box) return;
    const centre = (el: HTMLElement | undefined) => {
      const r = el?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top } : null;
    };
    const out: Cable[] = [];
    for (const r of roles) {
      const c = map[r.key];
      if (!c) continue;
      const a = centre(roleJacks.current.get(r.key));
      const b = centre(colJacks.current.get(c));
      if (a && b)
        out.push({ key: r.key, col: c, required: r.required, d: cablePath(a.x, a.y, b.x, b.y) });
    }
    setCables(out);
    setArmedFrom(armed ? centre(roleJacks.current.get(armed)) : null);
  }, [roles, map, armed]);

  useLayoutEffect(() => {
    measure();
  }, [measure, shown.length, shift]);
  useEffect(() => {
    const el = bay.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Escape drops a lifted cable.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmed(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed]);

  const frame = useRef(0);
  const onMove = (e: React.PointerEvent) => {
    if (!armed || e.pointerType === 'touch') return;
    const box = bay.current?.getBoundingClientRect();
    if (!box) return;
    const p = { x: e.clientX - box.left, y: e.clientY - box.top };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setPtr(p));
  };

  const plug = (col: NotionSchemaProp) => {
    if (!armed || !fitNames.has(col.name)) return;
    onChange(armed, col.name);
    setArmed(null);
    setPtr(null);
  };

  const done = roles.filter((r) => map[r.key]).length;
  const missing = roles.filter((r) => r.required && !map[r.key]);
  const isHot = (role: string, col: string) =>
    !!hot && (hot.role === role || (hot.col !== undefined && hot.col === col));

  return (
    <div className="grid gap-3">
      <div className="sb-bay-status" aria-live="polite">
        {armedRole ? (
          <>
            <span>
              Plug <b>{armedRole.label}</b> into a column that fits ({fits.length}). Esc to drop it.
            </span>
            <button type="button" className="sb-bay-cancel" onClick={() => setArmed(null)}>
              <X className="size-3.5" aria-hidden />
              Cancel
            </button>
          </>
        ) : (
          <span>
            <b className="tabular-nums">
              {done} of {roles.length}
            </b>{' '}
            lines patched
            {missing.length ? (
              <span className="text-destructive">
                {' '}
                · {missing.map((r) => r.label.toLowerCase()).join(', ')} still loose
              </span>
            ) : null}
            . Press a line to move its cable.
          </span>
        )}
      </div>

      <div
        ref={bay}
        className="sb-bay"
        data-armed={!!armed}
        onPointerMove={onMove}
        onPointerLeave={() => setPtr(null)}
      >
        <div className="sb-bay-side">
          <p className="sb-bay-head">Relay reads</p>
          <ul className="grid gap-1.5">
            {roles.map((r) => {
              const col = map[r.key];
              const sample = sampleOf(view, col);
              const on = armed === r.key;
              const hotRow = !!hot && (hot.role === r.key || (!!col && hot.col === col));
              return (
                <li
                  key={r.key}
                  className="sb-line"
                  data-live={!!col}
                  data-armed={on}
                  data-hot={hotRow}
                >
                  <button
                    type="button"
                    className="sb-line-btn"
                    aria-pressed={on}
                    aria-label={`${r.label}: ${col ? `plugged into ${col}` : 'not plugged'}. Press to move the cable.`}
                    onClick={() => setArmed(on ? null : r.key)}
                    onPointerEnter={() => setHot({ role: r.key })}
                    onPointerLeave={() => setHot(null)}
                    onFocus={() => setHot({ role: r.key })}
                    onBlur={() => setHot(null)}
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-sm font-medium">
                        {r.label}
                        {r.required ? null : (
                          <span className="font-normal text-muted-foreground"> · optional</span>
                        )}
                      </span>
                      <span className="sb-line-read font-mono" title={sample}>
                        {col
                          ? sample
                            ? sample
                            : 'empty on your latest cards'
                          : r.required
                            ? 'Not plugged in'
                            : 'Not used'}
                      </span>
                    </span>
                    <span
                      className="sb-port"
                      ref={(el) => {
                        if (el) roleJacks.current.set(r.key, el);
                        else roleJacks.current.delete(r.key);
                      }}
                      aria-hidden
                    />
                  </button>
                  {col && !on ? (
                    <button
                      type="button"
                      className="sb-unplug"
                      aria-label={`Unplug ${r.label}`}
                      title="Unplug"
                      onClick={() => onChange(r.key, undefined)}
                    >
                      <Unplug className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        <svg className="sb-cables" aria-hidden>
          {cables.map((c) => (
            <g key={`${c.key}:${c.col}`} data-hot={isHot(c.key, c.col)} data-optional={!c.required}>
              <path className="sb-cable-shadow" d={c.d} />
              <path className="sb-cable-line" d={c.d} pathLength={1} />
            </g>
          ))}
          {armed && armedFrom ? (
            <path
              className="sb-cable-lifted"
              d={
                ptr
                  ? cablePath(armedFrom.x, armedFrom.y, ptr.x, ptr.y)
                  : cablePath(armedFrom.x, armedFrom.y, armedFrom.x + 70, armedFrom.y + 40)
              }
            />
          ) : null}
        </svg>

        <div className="sb-bay-side">
          <p className="sb-bay-head">
            {armedRole ? `Fits ${armedRole.label.toLowerCase()}` : boardLabel}
          </p>
          <ul
            className="sb-col-list grid gap-1.5"
            style={{ marginTop: shift }}
            onTransitionEnd={measure}
          >
            {shown.map((p) => {
              const uses = usesOf(p.name);
              const fit = fitNames.has(p.name);
              return (
                <li
                  key={p.name}
                  className="sb-col"
                  data-used={uses.length > 0}
                  data-fit={armed ? fit : undefined}
                  data-hot={!!hot && (hot.col === p.name || uses.some((r) => r.key === hot.role))}
                >
                  <button
                    type="button"
                    className="sb-col-btn"
                    disabled={!!armed && !fit}
                    onClick={() => (armed ? plug(p) : setHot({ col: p.name }))}
                    onPointerEnter={() => setHot({ col: p.name })}
                    onPointerLeave={() => setHot(null)}
                  >
                    <span
                      className="sb-port"
                      ref={(el) => {
                        if (el) colJacks.current.set(p.name, el);
                        else colJacks.current.delete(p.name);
                      }}
                      aria-hidden
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate text-sm font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {TYPE_LABEL[p.type] ?? p.type}
                        {uses.length > 1 ? ` · ${uses.length} lines` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {armed && fits.length === 0 ? (
              <li className="text-sm text-muted-foreground">No column on this board fits.</li>
            ) : null}
          </ul>
        </div>
      </div>
    </div>
  );
}
