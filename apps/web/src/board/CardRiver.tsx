import { motion } from 'motion/react';
import { useState } from 'react';
import { rnd } from '@/components/glass/parts';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import type { CardTileModel, ColumnName } from './model';

const W = 1000;
// MID leaves a clear band under the legend row for the "Most cards" marker over the widest pool.
const H = 270;
const MID = 148;
const LEFT = 80;
const RIGHT = 920;
const THIN = 10;
const WIDE = 130;
/** Beads per column; the rest are counted as "+N". */
const MAX_BEADS = 40;

type Mood = 'calm' | 'warn' | 'off' | 'fix';

/** What a bead says about its card. Shape and word carry it as well as colour. */
function moodOf(t: CardTileModel): Mood {
  if (t.severity === 'critical' || t.severity === 'action') return 'fix';
  if (t.statusMismatch) return 'off';
  if (t.severity === 'warn') return 'warn';
  return 'calm';
}

/** A stable [0, 1) pair from a card id, so a bead keeps its place in the stream between renders. */
function spot(id: string): [number, number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return [rnd(h, 61), rnd(h, 62)];
}

/** The river's banks through every station, as one closed shape: smooth, wide where the cards pool. */
function banks(xs: number[], widths: number[]): string {
  const top = xs.map((x, i) => [x, MID - widths[i]! / 2] as const);
  const bottom = xs.map((x, i) => [x, MID + widths[i]! / 2] as const).reverse();
  const through = (pts: readonly (readonly [number, number])[]) =>
    pts
      .slice(1)
      .map(([x, y], i) => {
        const [px, py] = pts[i]!;
        const mx = (px + x) / 2;
        return `C${mx} ${py} ${mx} ${y} ${x} ${y}`;
      })
      .join(' ');
  const [fx, fy] = top[0]!;
  const [lx, ly] = top[top.length - 1]!;
  const [bx, by] = bottom[0]!;
  const [ex, ey] = bottom[bottom.length - 1]!;
  return [
    `M${fx - 60} ${fy} L${fx} ${fy}`,
    through(top),
    `L${lx + 60} ${ly} L${bx + 60} ${by} L${bx} ${by}`,
    through(bottom),
    `L${ex - 60} ${ey} Z`,
  ].join(' ');
}

/**
 * The card river. The board's columns are stations along a stream, the stream as wide at each as the cards pooled
 * there, so the bottleneck shows at a glance. Every card is a bead: plain when it is fine, violet when its status and
 * MR are out of step, a red ring with a cross when it needs fixing. A card that changes column glides downstream to
 * it. Click a bead to jump to its card; click a station to scroll to its column.
 */
export function CardRiver({
  columns,
  onPickColumn,
  onPickCard,
}: {
  columns: { name: ColumnName; tiles: CardTileModel[] }[];
  onPickColumn: (name: ColumnName) => void;
  onPickCard: (cardId: string) => void;
}) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<ColumnName | null>(null);
  const n = columns.length;
  if (n === 0) return null;
  const xs = columns.map((_, i) => LEFT + (n <= 1 ? 0.5 : i / (n - 1)) * (RIGHT - LEFT));
  const counts = columns.map((c) => c.tiles.length);
  const most = Math.max(0, ...counts);
  const widths = counts.map((c) => (most === 0 ? THIN : THIN + (c / most) * (WIDE - THIN)));
  const step = n <= 1 ? RIGHT - LEFT : (RIGHT - LEFT) / (n - 1);
  const d = banks(xs, widths);
  const total = counts.reduce((a, b) => a + b, 0);
  const moods = columns.flatMap((c) => c.tiles.map(moodOf));
  const off = moods.filter((m) => m === 'off').length;
  const fix = moods.filter((m) => m === 'fix').length;
  const warn = moods.filter((m) => m === 'warn').length;
  const spring = reduced ? { duration: 0 } : SPRING.settle;

  return (
    // Below 720px it scrolls sideways in its own box rather than shrinking past legibility.
    <div className="-mx-1 overflow-x-auto px-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full min-w-180 overflow-visible select-none"
        role="group"
        aria-label={`The card river: ${total} cards. ${columns.map((c) => `${c.name} ${c.tiles.length}`).join(', ')}. ${off} out of step, ${fix} need fixing, ${warn} with a warning.`}
      >
        {/* the legend: shape and word, not colour alone */}
        <g className="fill-muted-foreground text-micro font-semibold uppercase">
          <path d="M24 16 L29 21 L24 26 L19 21 Z" className="fill-card stroke-foreground" />
          <text x={36} y={25}>
            Card
          </text>
          <path d="M84 16 L89 21 L84 26 L79 21 Z" className="fill-terracotta" />
          <text x={96} y={25}>
            {`Out of step · ${off}`}
          </text>
          <g transform="translate(206 21)">
            <circle r={5} className="fill-none stroke-destructive" strokeWidth={1.5} />
            <path d="M-2.5 -2.5 L2.5 2.5 M2.5 -2.5 L-2.5 2.5" className="stroke-destructive" />
          </g>
          <text x={218} y={25}>
            {`Needs fixing · ${fix}`}
          </text>
          <path d="M344 16 L349 21 L344 26 L339 21 Z" className="fill-warning/80 stroke-warning" />
          <text x={356} y={25}>
            {`Warning · ${warn}`}
          </text>
        </g>
        <text
          x={W - 20}
          y={30}
          textAnchor="end"
          className="fill-foreground font-mono"
          fontSize={30}
          letterSpacing={-1}
        >
          {String(total).padStart(3, '0')}
        </text>

        {/* the stream: its banks, and the current running through it */}
        <motion.path
          initial={false}
          animate={{ d }}
          transition={spring}
          className="fill-foreground/[0.05] stroke-foreground/35"
          strokeWidth={1}
        />
        {[-0.22, 0, 0.22].map((k) => (
          <motion.path
            key={k}
            initial={false}
            animate={{
              d: `M${xs[0]! - 60} ${MID + k * widths[0]!} ${xs
                .slice(1)
                .map((x, i) => {
                  const mx = (xs[i]! + x) / 2;
                  return `C${mx} ${MID + k * widths[i]!} ${mx} ${MID + k * widths[i + 1]!} ${x} ${MID + k * widths[i + 1]!}`;
                })
                .join(' ')} L${xs[n - 1]! + 60} ${MID + k * widths[n - 1]!}`,
            }}
            transition={spring}
            fill="none"
            className={cn('stroke-foreground/20', !reduced && 'river-flow')}
            strokeDasharray="2 12"
            strokeLinecap="round"
          />
        ))}

        {/* the stations */}
        {columns.map((col, i) => {
          const x = xs[i]!;
          const busiest = most > 0 && col.tiles.length === most;
          const over = col.tiles.length - MAX_BEADS;
          return (
            <g
              key={col.name}
              role="button"
              tabIndex={0}
              aria-label={`Show ${col.name}: ${col.tiles.length} cards`}
              className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-ring"
              onPointerEnter={() => setHover(col.name)}
              onPointerLeave={() => setHover(null)}
              onClick={() => onPickColumn(col.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPickColumn(col.name);
                }
              }}
            >
              <rect
                x={x - step / 2}
                y={44}
                width={step}
                height={H - 44}
                fill="transparent"
                stroke="transparent"
                strokeWidth={2}
                rx={4}
              />
              <line
                x1={x}
                x2={x}
                y1={MID - widths[i]! / 2 - 10}
                y2={MID + widths[i]! / 2 + 10}
                className={hover === col.name ? 'stroke-foreground/60' : 'stroke-foreground/15'}
                strokeDasharray="2 3"
              />
              {busiest && (
                <g transform={`translate(${x} ${MID - widths[i]! / 2 - 18})`}>
                  <path d="M-5 -6 L5 -6 L0 0 Z" className="fill-foreground" />
                  <text
                    y={-11}
                    textAnchor="middle"
                    className="fill-foreground text-micro font-semibold uppercase"
                  >
                    Most cards
                  </text>
                </g>
              )}
              {over > 0 && (
                <text
                  x={x + 14}
                  y={MID - widths[i]! / 2 - 4}
                  className="fill-muted-foreground font-mono"
                  fontSize={11}
                >
                  {`+${over}`}
                </text>
              )}
              <text
                x={x}
                y={H - 26}
                textAnchor="middle"
                className={cn(
                  'text-micro font-semibold uppercase',
                  hover === col.name ? 'fill-foreground' : 'fill-muted-foreground',
                )}
              >
                {col.name}
              </text>
              <text
                x={x}
                y={H - 8}
                textAnchor="middle"
                className="fill-foreground font-mono"
                fontSize={13}
              >
                {col.tiles.length}
              </text>
            </g>
          );
        })}

        {/* the beads: they find their station, and glide downstream when a card moves */}
        {columns.flatMap((col, i) =>
          col.tiles.slice(0, MAX_BEADS).map((t, j) => {
            const [u, v] = spot(t.card.id);
            const spread = Math.min(step * 0.62, 90);
            const x = xs[i]! + (u - 0.5) * spread;
            const y = MID + (v - 0.5) * Math.max(0, widths[i]! - 12);
            const mood = moodOf(t);
            return (
              <motion.g
                key={t.card.id}
                initial={reduced ? false : { x, y: y - 24, opacity: 0 }}
                animate={{ x, y, opacity: 1 }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { ...SPRING.wobble, delay: Math.min(0.6, 0.004 * (i * MAX_BEADS + j)) }
                }
                className="cursor-pointer"
                onClick={() => onPickCard(t.card.id)}
              >
                <g
                  className={cn(!reduced && 'river-bob')}
                  style={{ animationDelay: `${-u * 4}s`, animationDuration: `${3 + v * 2}s` }}
                >
                  <title>{`${t.card.title} · ${col.name}${mood === 'fix' ? ' · needs fixing' : mood === 'off' ? ' · out of step' : ''}`}</title>
                  {mood === 'fix' ? (
                    <>
                      <circle
                        r={5}
                        className="fill-background stroke-destructive"
                        strokeWidth={1.5}
                      />
                      <path
                        d="M-2.5 -2.5 L2.5 2.5 M2.5 -2.5 L-2.5 2.5"
                        className="stroke-destructive"
                      />
                    </>
                  ) : (
                    <>
                      {mood === 'off' && !reduced && (
                        <circle r={9} className="crystal-halo fill-terracotta/20" />
                      )}
                      <path
                        d="M0 -5 L5 0 L0 5 L-5 0 Z"
                        className={cn(
                          mood === 'off' && 'fill-terracotta',
                          mood === 'warn' && 'fill-warning/80 stroke-warning',
                          mood === 'calm' && 'fill-card stroke-foreground/70',
                        )}
                        strokeWidth={1}
                      />
                    </>
                  )}
                </g>
              </motion.g>
            );
          }),
        )}
      </svg>
    </div>
  );
}
