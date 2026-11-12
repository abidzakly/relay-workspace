import { Ban, Check } from 'lucide-react';
import { useId, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { formatHours, type Sprint, type SprintMr, type SprintTask } from '@relay/shared';
import { cn } from '@/lib/utils';
import {
  HARBOR_ZONES,
  layoutHarbor,
  projectHue,
  VIEW,
  VITRINE,
  ZONE_COLUMNS,
  zoneCrates,
  type Box,
  type Crate,
  type HarborZone,
} from './harborLayout';

export const ZONE_LABEL: Record<HarborZone, string> = {
  quay: 'Quarry',
  crane: 'Cutting bench',
  ship: 'Vitrine',
};

/** Where a magnify tap landed, in viewport px: the lens grows out of this point. */
export interface TapPoint {
  x: number;
  y: number;
}

const STAMP: Record<SprintMr['state'], { cls: string; label: string }> = {
  merged: { cls: 'fill-success', label: 'merged' },
  approved: { cls: 'fill-river', label: 'approved' },
  reviewed: { cls: 'fill-foreground', label: 'reviewed' },
  open: { cls: 'fill-foreground', label: 'open' },
  draft: { cls: 'fill-stone', label: 'draft' },
  closed: { cls: 'fill-rosewood', label: 'closed' },
  none: { cls: 'fill-stone', label: 'none' },
};

/** A cut crystal's outline: a block with its corners ground off. */
function cutPath(x: number, y: number, w: number, h: number): string {
  const c = Math.min(7, w / 5, h / 3);
  return `M${x + c} ${y} H${x + w - c} L${x + w} ${y + c} V${y + h - c} L${x + w - c} ${y + h} H${x + c} L${x} ${y + h - c} V${y + c} Z`;
}

/** A raw stone straight from the quarry: the same box, but with broken, uneven edges. */
function roughPath(x: number, y: number, w: number, h: number, seed: number): string {
  const j = (k: number) => ((Math.sin(seed * 97.3 + k * 12.9) + 1) / 2) * 5;
  return `M${x + j(1)} ${y + j(2)} L${x + w * 0.45} ${y + j(3) - 2} L${x + w - j(4)} ${y + j(5)} L${x + w} ${y + h * 0.55} L${x + w - j(6)} ${y + h} L${x + w * 0.4} ${y + h - j(7) * 0.4} L${x + j(8) * 0.6} ${y + h} L${x} ${y + h * 0.45} Z`;
}

function CrateShape({
  crate,
  selected,
  interactive,
  onPick,
}: {
  crate: Crate;
  selected: boolean;
  /** False under the phone's magnify buttons: the crates are then pictures, the zone button takes the tap. */
  interactive: boolean;
  onPick: (t: SprintTask) => void;
}) {
  const { task, kind, x, y, w, h } = crate;
  const hue = projectHue(task.project);
  const sealed = task.stage === 'sealed';
  const raw = task.stage === 'quay';
  // Project hue as a pale tint of the glass, so a project's pieces are recognisable without shouting.
  const fill =
    kind === 'research'
      ? 'var(--plum)'
      : kind === 'unknown'
        ? 'var(--card)'
        : raw
          ? `oklch(0.74 0.02 ${hue})`
          : sealed
            ? `oklch(0.6 0.06 ${hue})`
            : `oklch(0.88 0.05 ${hue})`;
  const label = `${task.title} — ${task.status ?? 'no status'}${task.point ? `, ${task.point} pt` : ''}`;
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick(task);
    }
  };
  const known = task.subTasks.filter((s) => s.title !== null);
  const unknown = task.subTasks.length - known.length;
  const outline = raw ? roughPath(x, y, w, h, crate.phase) : cutPath(x, y, w, h);
  return (
    <g
      className={`harbor-crate ${kind === 'heavy' ? 'harbor-creak' : ''}`}
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': label,
            'aria-pressed': selected,
            onClick: () => onPick(task),
            onKeyDown: onKey,
          }
        : { 'aria-hidden': true })}
      style={{ animationDelay: `-${crate.phase}s` }}
    >
      <title>{label}</title>
      <path
        d={outline}
        fill={fill}
        stroke={selected ? 'var(--ring)' : 'var(--foreground)'}
        strokeOpacity={selected ? 1 : 0.55}
        strokeWidth={selected ? 2.5 : 1}
        strokeLinejoin="round"
        strokeDasharray={kind === 'unknown' ? '4 3' : undefined}
      />
      {/* facets: a cut piece catches the light along its top and down one side; a raw stone has none */}
      {!raw && kind !== 'unknown' && (
        <>
          <path
            d={`M${x + 4} ${y + 5} H${x + w - 4}`}
            stroke="white"
            strokeOpacity={0.7}
            strokeWidth={1.2}
          />
          <path
            d={`M${x + w * 0.62} ${y + 2} L${x + w * 0.48} ${y + h - 2}`}
            stroke="var(--foreground)"
            strokeOpacity={0.12}
          />
          {/* the rainbow glint the glass throws */}
          <path
            d={`M${x + w - 6} ${y + 2} L${x + w - 1} ${y + 7}`}
            stroke="var(--terracotta)"
            strokeWidth={1.5}
          />
        </>
      )}
      {kind === 'heavy' && (
        <text
          x={x + w / 2}
          y={y + h / 2 + 4}
          textAnchor="middle"
          className="fill-foreground text-micro font-semibold tracking-widest uppercase"
        >
          Heavy
        </text>
      )}
      {kind === 'research' && (
        <>
          <path
            d={cutPath(x - 3, y - 3, w + 6, h + 6)}
            fill="var(--terracotta)"
            className="harbor-glow"
            opacity={0.35}
          />
          <text
            x={x + w / 2}
            y={y + h / 2 + 6}
            textAnchor="middle"
            className="fill-harbor-label text-base font-semibold"
          >
            ?
          </text>
        </>
      )}
      {task.blocked && (
        <Ban
          x={x + 3}
          y={y + 3}
          width={10}
          height={10}
          strokeWidth={3}
          aria-hidden
          className="text-destructive"
        />
      )}
      {sealed && (
        <g>
          <circle cx={x + w - 8} cy={y + 8} r={6} className="fill-foreground" />
          <Check
            x={x + w - 12}
            y={y + 4}
            width={8}
            height={8}
            strokeWidth={4}
            aria-hidden
            className="text-background"
          />
        </g>
      )}
      {/* MR stamps along the bottom edge */}
      {task.mrs.slice(0, 3).map((m, i) => {
        const st = STAMP[m.state];
        return (
          <circle
            key={`${m.repoId}#${m.iid}`}
            cx={x + 7 + i * 11}
            cy={y + h - 6}
            r={4}
            className={st.cls}
            stroke="var(--card)"
            strokeWidth={1}
          />
        );
      })}
      {/* sub-tasks: small chips riding on top */}
      {known.slice(0, 6).map((sub, i) => (
        <rect
          key={sub.id}
          x={x + 2 + i * 9}
          y={y - 7}
          width={7}
          height={6}
          rx={1}
          className={sub.stage === 'sealed' ? 'fill-foreground' : 'fill-card'}
          stroke="var(--foreground)"
          strokeOpacity={0.5}
        />
      ))}
      {unknown > 0 && (
        <rect
          x={x + 2 + Math.min(6, known.length) * 9}
          y={y - 7}
          width={7}
          height={6}
          rx={1}
          fill="none"
          stroke="currentColor"
          strokeDasharray="2 1"
          className="text-muted-foreground"
        />
      )}
      {/* Invisible, slightly larger tap target (incl. the sub-task chips on top); last, so it is hit first. */}
      {interactive && <rect x={x - 3} y={y - 9} width={w + 6} height={h + 12} fill="transparent" />}
    </g>
  );
}

/**
 * One sprint as an atelier: raw stones wait in the quarry (not started), pieces hang under the cutting beam (in
 * progress), cut crystals stand in the glass vitrine (in review, sealed). The vitrine's fill line is estimated hours
 * against capacity; past 100% it overflows and the glass cracks.
 *
 * `onMagnify` (phone portrait): three transparent buttons cover the quarry, bench and vitrine columns, so a tap opens
 * the magnifier instead of having to hit a 10 px piece. `viewBox` + `still` are how the magnifier draws one zone enlarged.
 */
export function HarborScene({
  sprint,
  tasks,
  selectedId,
  onPick,
  onMagnify,
  viewBox,
  zone,
  still = false,
  style,
}: {
  sprint: Sprint;
  tasks: readonly SprintTask[];
  selectedId: string | null;
  onPick: (t: SprintTask) => void;
  onMagnify?: (zone: HarborZone, at: TapPoint) => void;
  viewBox?: Box;
  /** With `viewBox`: only this zone's pieces take taps and focus; the rest are outside the crop. */
  zone?: HarborZone;
  /** Pause the swaying (the hanging pieces, the beam) so a piece does not move under the finger. */
  still?: boolean;
  style?: CSSProperties;
}) {
  // Two scenes are on the page while the magnifier is open: gradient ids must not collide.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fillId = `atelier-fill-${uid}`;
  const L = layoutHarbor(sprint, tasks);
  const live = zone ? new Set(zoneCrates(L, zone).map((c) => c.task.id)) : null;
  const canTap = (c: Crate) => !onMagnify && (!live || live.has(c.task.id));
  const over = L.ship.overloadedBy > 0;
  const fillY = VITRINE.floor - L.ship.sink;
  const vb = viewBox ?? { x: 0, y: 0, w: VIEW.w, h: VIEW.h };
  const svg = (
    <svg
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      className={cn('block h-auto w-full select-none', still && 'harbor-still')}
      style={style}
      role="group"
      aria-label={`Sprint ${sprint.name}: ${formatHours(sprint.loadHours)} of ${formatHours(sprint.capacityHours)} capacity`}
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0"
            style={{
              stopColor: over ? 'var(--destructive)' : 'var(--terracotta)',
              stopOpacity: 0.32,
            }}
          />
          <stop
            offset="1"
            style={{
              stopColor: over ? 'var(--destructive)' : 'var(--terracotta)',
              stopOpacity: 0.08,
            }}
          />
        </linearGradient>
      </defs>
      <rect width={VIEW.w} height={VIEW.h} className="fill-card" />
      {/* the page's column rules */}
      {Array.from({ length: 9 }, (_, i) => (
        <line
          key={i}
          x1={(i + 1) * 100}
          x2={(i + 1) * 100}
          y1={0}
          y2={VIEW.h}
          className="stroke-foreground/5"
        />
      ))}
      {/* the one dot in the sky */}
      <circle cx={900} cy={64} r={7} className="fill-foreground" />

      {/* floor */}
      <line x1={0} x2={VIEW.w} y1={404} y2={404} className="stroke-foreground/30" />

      {/* (01) quarry: a low heap of rubble behind the waiting stones */}
      <path
        d="M0 404 L0 372 L40 360 L90 366 L150 352 L210 362 L270 356 L322 372 L322 404 Z"
        className="fill-foreground/[0.06]"
      />
      <text x={20} y={436} className="fill-foreground text-xs font-semibold uppercase">
        (01) Quarry · not started
      </text>

      {/* (02) cutting bench: a post, an arm and the cutting beam */}
      <g>
        <rect x={334} y={60} width={6} height={344} className="fill-foreground" />
        <rect x={334} y={60} width={150} height={5} className="fill-foreground" />
        <rect x={392} y={56} width={16} height={12} rx={2} className="fill-foreground" />
        <rect x={330} y={398} width={150} height={6} className="fill-foreground" />
        <text x={344} y={436} className="fill-foreground text-xs font-semibold uppercase">
          (02) Bench · in progress
        </text>
      </g>
      <g className="harbor-swing">
        <line x1={400} y1={68} x2={400} y2={150} className="stroke-terracotta" strokeWidth={1.5} />
        <circle cx={400} cy={150} r={3} className="fill-terracotta harbor-glow" />
        {L.crane
          .filter((c) => c.y < 330)
          .map((c) => (
            <CrateShape
              key={c.task.id}
              crate={c}
              selected={selectedId === c.task.id}
              interactive={canTap(c)}
              onPick={onPick}
            />
          ))}
      </g>
      {L.crane
        .filter((c) => c.y >= 330)
        .map((c) => (
          <CrateShape
            key={c.task.id}
            crate={c}
            selected={selectedId === c.task.id}
            interactive={canTap(c)}
            onPick={onPick}
          />
        ))}
      {L.quay.map((c) => (
        <CrateShape
          key={c.task.id}
          crate={c}
          selected={selectedId === c.task.id}
          interactive={canTap(c)}
          onPick={onPick}
        />
      ))}

      {/* (03) the vitrine: a glass case on a plinth, filled to the sprint's load */}
      <g style={{ transform: `rotate(${L.ship.list}deg)`, transformOrigin: '760px 404px' }}>
        <rect
          x={VITRINE.x0}
          y={fillY}
          width={VITRINE.x1 - VITRINE.x0}
          height={VITRINE.floor - fillY}
          fill={`url(#${fillId})`}
        />
        <line
          x1={VITRINE.x0}
          x2={VITRINE.x1}
          y1={fillY}
          y2={fillY}
          className={over ? 'stroke-destructive' : 'stroke-terracotta'}
          strokeWidth={1.5}
        />
        {L.deck.map((c) => (
          <CrateShape
            key={c.task.id}
            crate={c}
            selected={selectedId === c.task.id}
            interactive={canTap(c)}
            onPick={onPick}
          />
        ))}
        {/* the glass, in front of the pieces */}
        <rect
          x={VITRINE.x0}
          y={VITRINE.top}
          width={VITRINE.x1 - VITRINE.x0}
          height={VITRINE.floor - VITRINE.top}
          fill="white"
          fillOpacity={0.06}
          className="pointer-events-none stroke-foreground/60"
          strokeWidth={1.2}
        />
        <path
          d={`M${VITRINE.x0 + 14} ${VITRINE.top + 10} L${VITRINE.x0 + 14} ${VITRINE.top + 120} M${VITRINE.x0 + 24} ${VITRINE.top + 10} L${VITRINE.x0 + 24} ${VITRINE.top + 50}`}
          stroke="white"
          strokeOpacity={0.8}
          strokeWidth={2}
          className="pointer-events-none"
        />
        {/* capacity marks on the glass */}
        {[0.5, 1].map((f) => {
          const y = VITRINE.floor - f * VITRINE.full;
          return (
            <g key={f} className="pointer-events-none">
              <line
                x1={VITRINE.x1 - 26}
                x2={VITRINE.x1}
                y1={y}
                y2={y}
                className="stroke-foreground"
                strokeWidth={1}
              />
              <text
                x={VITRINE.x1 + 6}
                y={y + 4}
                className="fill-foreground text-micro font-semibold"
              >
                {f * 100}%
              </text>
            </g>
          );
        })}
        {/* over capacity: the glass cracks */}
        {over && (
          <path
            d={`M${VITRINE.x0 + 120} ${VITRINE.top} L${VITRINE.x0 + 140} ${VITRINE.top + 40} L${VITRINE.x0 + 126} ${VITRINE.top + 62} L${VITRINE.x0 + 150} ${VITRINE.top + 110} M${VITRINE.x0 + 140} ${VITRINE.top + 40} L${VITRINE.x0 + 176} ${VITRINE.top + 54}`}
            className="pointer-events-none stroke-destructive"
            strokeWidth={1.4}
            fill="none"
          />
        )}
        {/* plinth with the sprint's name */}
        <rect
          x={VITRINE.x0 - 10}
          y={VITRINE.floor}
          width={VITRINE.x1 - VITRINE.x0 + 20}
          height={36}
          className="fill-foreground"
        />
        <text
          x={VITRINE.x0 + 6}
          y={VITRINE.floor + 24}
          className="fill-background text-sm font-semibold tracking-[0.04em] uppercase"
        >
          (03) {sprint.name.slice(0, 26)}
        </text>
      </g>
      {over &&
        [0, 1, 2, 3].map((i) => (
          <circle
            key={i}
            cx={620 + i * 90}
            cy={VITRINE.top + 4}
            r={3}
            className="harbor-bubble fill-destructive/70"
            style={{ animationDelay: `${i * 0.5}s` }}
          />
        ))}

      {/* fill readout */}
      <text x={VITRINE.x0} y={VIEW.h - 22} className="fill-foreground text-sm font-semibold">
        {over
          ? `Overflowing by ${formatHours(L.ship.overloadedBy)} · ${formatHours(sprint.loadHours)} / ${formatHours(sprint.capacityHours)}`
          : `Filled ${formatHours(sprint.loadHours)} / ${formatHours(sprint.capacityHours)} · ${Math.round(L.ship.ratio * 100)}%`}
      </text>
    </svg>
  );
  if (!onMagnify) return svg;

  const magnify = (zone: HarborZone) => (e: MouseEvent<HTMLButtonElement>) => {
    // A keyboard "click" has no pointer position: grow the lens out of the button's centre instead.
    const r = e.currentTarget.getBoundingClientRect();
    const fromPointer = e.detail > 0 && (e.clientX !== 0 || e.clientY !== 0);
    onMagnify(
      zone,
      fromPointer
        ? { x: e.clientX, y: e.clientY }
        : { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    );
  };
  return (
    <div className="relative">
      {svg}
      {HARBOR_ZONES.map((zone) => {
        const col = ZONE_COLUMNS[zone];
        const n = zoneCrates(L, zone).length;
        return (
          <button
            key={zone}
            type="button"
            onClick={magnify(zone)}
            aria-label={`Magnify ${ZONE_LABEL[zone].toLowerCase()}, ${n} container${n === 1 ? '' : 's'}`}
            className="absolute inset-y-0 cursor-zoom-in outline-none [-webkit-tap-highlight-color:transparent] focus-visible:bg-card/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-card/10"
            style={{
              left: `${(col.x0 / VIEW.w) * 100}%`,
              width: `${((col.x1 - col.x0) / VIEW.w) * 100}%`,
            }}
          />
        );
      })}
    </div>
  );
}
