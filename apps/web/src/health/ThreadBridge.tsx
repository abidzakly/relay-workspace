import { motion, useMotionValue } from 'motion/react';
import { useId } from 'react';
import type { HealthReport, SyncSourceStatus } from '@relay/shared';
import { Gem, GlassGradients, prism, rnd } from '@/components/glass/parts';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';

const W = 1000;
const H = 270;
/** The two banks. Their crystals stand on y = 150 (the glass kit's baseline), lifted to sit on this bank. */
const LEFT_X = 120;
const RIGHT_X = 880;
const ANCHOR_L = 165;
const ANCHOR_R = 835;
const TOP = 66;
const BOTTOM = 214;
/** More threads than this and the bridge turns to felt: the counts below stay exact. */
const MAX_THREADS = 40;
const MAX_LOOSE = 8;

type Kind = 'taut' | 'soft' | 'slack' | 'strained' | 'snapped' | 'loose';
const SAG: Record<Kind, number> = {
  taut: 0,
  soft: 10,
  slack: 30,
  strained: 50,
  snapped: 0,
  loose: 0,
};

/** Split `cap` threads across the kinds in proportion, keeping at least one for any kind that has a finding. */
function allot(counts: [Kind, number][], cap: number): Kind[] {
  const total = counts.reduce((s, [, c]) => s + c, 0);
  if (total === 0) return [];
  const scale = Math.min(1, cap / total);
  return counts.flatMap(([kind, c]) =>
    Array.from({ length: c === 0 ? 0 : Math.max(1, Math.round(c * scale)) }, () => kind),
  );
}

function ago(at: number | null): string {
  if (at === null) return 'never';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const curve = (y1: number, y2: number, sag: number) =>
  `M${ANCHOR_L} ${y1} C${ANCHOR_L + 220} ${y1 + sag}, ${ANCHOR_R - 220} ${y2 + sag}, ${ANCHOR_R} ${y2}`;

/** One bank: a crystal pillar for a sync source, pulsing while its sync is healthy, cracked when it fails. */
function Bank({
  x,
  name,
  source,
  glowId,
}: {
  x: number;
  name: string;
  source: SyncSourceStatus | undefined;
  glowId: string;
}) {
  const reduced = useReducedMotion();
  const state = source?.state ?? 'never';
  const shape = prism(x, 64, 118);
  const growth = useMotionValue(state === 'never' || state === 'skipped' ? 0.35 : 1);
  const flash = useMotionValue(0);
  const pulse = state === 'ok' || state === 'partial';
  return (
    <g>
      {/* lifted so the crystal stands on this bank's ground, not the kit's */}
      <g transform="translate(0 62)">
        {pulse && !reduced && (
          <motion.ellipse
            cx={x}
            cy={150}
            fill="none"
            className={state === 'ok' ? 'stroke-foreground/40' : 'stroke-warning'}
            initial={{ rx: 10, ry: 2, opacity: 0.8 }}
            animate={{ rx: 90, ry: 10, opacity: 0 }}
            transition={{
              duration: 1.6,
              repeat: Infinity,
              repeatDelay: state === 'ok' ? 0.8 : 2.4,
              ease: 'easeOut',
            }}
          />
        )}
        <line x1={x - 70} x2={x + 70} y1={150} y2={150} className="stroke-foreground/30" />
        <Gem
          shape={shape}
          growth={growth}
          flash={flash}
          cracked={state === 'error'}
          glowId={glowId}
        />
      </g>
      <text
        x={x}
        y={20}
        textAnchor="middle"
        className="fill-foreground text-micro font-semibold uppercase"
      >
        {name}
      </text>
      <text
        x={x}
        y={H - 12}
        textAnchor="middle"
        className={cn(
          'text-micro font-semibold uppercase',
          state === 'error'
            ? 'fill-destructive'
            : state === 'partial'
              ? 'fill-warning'
              : 'fill-muted-foreground',
        )}
      >
        {source ? `${state} · ${ago(source.lastSuccessAt)}` : 'not synced'}
      </text>
    </g>
  );
}

/**
 * The bridge: Notion on one bank, GitLab on the other, one thread per finding. In sync, a thread is taut and light runs
 * along it; out of step it goes slack and sways; a critical mismatch snaps it, both ends hanging; a card with no rule is
 * a loose end. Each bank's crystal pulses while its sync is healthy and cracks when it fails. The counts and the list
 * below say all of it in words.
 */
export function ThreadBridge({
  report,
  sources,
}: {
  report: HealthReport;
  sources: SyncSourceStatus[];
}) {
  const reduced = useReducedMotion();
  const uid = useId();
  const glowId = `${uid}-glow`;
  const by = report.counts.bySeverity;
  const counts: [Kind, number][] = [
    ['taut', by.ok ?? 0],
    ['soft', by.info ?? 0],
    ['slack', by.warn ?? 0],
    ['strained', by.action ?? 0],
    ['snapped', by.critical ?? 0],
  ];
  const loose = report.unruled.length;
  // Loose ends are a fringe on the Notion bank, capped on their own so they never crowd out the findings.
  const threads = [...allot(counts, MAX_THREADS), ...allot([['loose', loose]], MAX_LOOSE)];
  const n = threads.length;
  const slot = (i: number) => TOP + (n <= 1 ? 0.5 : i / (n - 1)) * (BOTTOM - TOP);
  // The right bank's order is shuffled, so the threads cross like a weave.
  const order = threads.map((_, i) => i).sort((a, b) => rnd(a, 51) - rnd(b, 51));
  const find = (word: string) => sources.find((s) => s.source.toLowerCase().includes(word));

  const word = (k: Kind) => (k === 'loose' ? loose : (counts.find(([c]) => c === k)?.[1] ?? 0));
  const total = counts.reduce((s, [, c]) => s + c, 0);
  const empty = total === 0 && loose === 0;
  const clear = total > 0 && word('slack') + word('strained') + word('snapped') === 0;

  return (
    // Below 720px it scrolls sideways in its own box rather than shrinking past legibility.
    <div className="-mx-1 overflow-x-auto px-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full min-w-180 overflow-visible select-none"
        role="img"
        aria-label={
          empty
            ? 'No findings yet: the bridge has no threads.'
            : `${word('taut')} threads taut, ${word('soft')} soft, ${word('slack') + word('strained')} slack, ${word('snapped')} snapped, ${word('loose')} loose.`
        }
      >
        <defs>
          <GlassGradients glowId={glowId} haloId={`${uid}-halo`} />
        </defs>

        {/* the threads */}
        {threads.map((kind, i) => {
          const y1 = slot(i);
          const y2 = slot(order.indexOf(i));
          const delay = reduced ? 0 : 0.15 + i * 0.018;
          if (kind === 'snapped') {
            // Both ends hang from their banks, swinging a little.
            const left = `M${ANCHOR_L} ${y1} Q${ANCHOR_L + 120} ${y1 + 10} ${ANCHOR_L + 170} ${y1 + 70}`;
            const right = `M${ANCHOR_R} ${y2} Q${ANCHOR_R - 120} ${y2 + 10} ${ANCHOR_R - 170} ${y2 + 70}`;
            return (
              <g key={i} className="stroke-destructive" fill="none" strokeWidth={1.5}>
                {[
                  { d: left, ox: ANCHOR_L, oy: y1, end: { x: ANCHOR_L + 170, y: y1 + 70 } },
                  { d: right, ox: ANCHOR_R, oy: y2, end: { x: ANCHOR_R - 170, y: y2 + 70 } },
                ].map((half, h) => (
                  <motion.g
                    key={h}
                    style={{
                      originX: `${half.ox}px`,
                      originY: `${half.oy}px`,
                      transformBox: 'view-box',
                    }}
                    animate={reduced ? undefined : { rotate: h === 0 ? [-3, 3] : [3, -3] }}
                    transition={{
                      duration: 2.6 + rnd(i, 52),
                      repeat: Infinity,
                      repeatType: 'mirror',
                      ease: 'easeInOut',
                    }}
                  >
                    <motion.path
                      d={half.d}
                      initial={{ pathLength: reduced ? 1 : 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.6, delay }}
                    />
                    <path
                      d={`M${half.end.x - 3} ${half.end.y + 4} L${half.end.x} ${half.end.y} L${half.end.x + 3} ${half.end.y + 5}`}
                      strokeWidth={1}
                    />
                  </motion.g>
                ))}
              </g>
            );
          }
          if (kind === 'loose') {
            // A loose end: tied on the Notion bank only, drifting with nothing to hold it.
            const d = `M${ANCHOR_L} ${y1} C${ANCHOR_L + 140} ${y1 - 20}, ${ANCHOR_L + 200} ${y1 + 30}, ${ANCHOR_L + 290} ${y1 - 6}`;
            const d2 = `M${ANCHOR_L} ${y1} C${ANCHOR_L + 140} ${y1 + 16}, ${ANCHOR_L + 210} ${y1 - 22}, ${ANCHOR_L + 290} ${y1 + 10}`;
            return (
              <g key={i}>
                <motion.path
                  d={d}
                  fill="none"
                  className="stroke-foreground/40"
                  strokeDasharray="1.5 4"
                  strokeLinecap="round"
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={reduced ? { pathLength: 1 } : { pathLength: 1, d: [d, d2] }}
                  transition={{
                    pathLength: { duration: 0.8, delay },
                    d: { duration: 3.4, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' },
                  }}
                />
              </g>
            );
          }
          const sag = SAG[kind];
          const d = curve(y1, y2, sag);
          const sway = kind === 'slack' || kind === 'strained';
          const d2 = curve(y1, y2, sag + (kind === 'strained' ? 14 : 9));
          return (
            <g key={i}>
              <motion.path
                d={d}
                fill="none"
                className={cn(
                  kind === 'taut' && 'stroke-foreground/45',
                  kind === 'soft' && 'stroke-foreground/30',
                  (kind === 'slack' || kind === 'strained') && 'stroke-warning',
                )}
                strokeWidth={kind === 'strained' ? 1.5 : 1}
                strokeDasharray={kind === 'strained' ? '5 4' : undefined}
                initial={{ pathLength: reduced ? 1 : 0 }}
                animate={sway && !reduced ? { pathLength: 1, d: [d, d2] } : { pathLength: 1 }}
                transition={{
                  pathLength: { duration: 0.9, delay, ease: 'easeOut' },
                  d: {
                    duration: 2.8 + rnd(i, 53) * 1.6,
                    repeat: Infinity,
                    repeatType: 'mirror',
                    ease: 'easeInOut',
                  },
                }}
              />
              {/* light running along a taut thread: the sync carrying */}
              {kind === 'taut' && !reduced && i % 4 === 0 && (
                <circle r={2} className="fill-terracotta">
                  <animateMotion
                    dur={`${2.4 + rnd(i, 54) * 2}s`}
                    begin={`${1 + rnd(i, 55) * 2}s`}
                    repeatCount="indefinite"
                    path={d}
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* all clear: one glint runs across every thread */}
        {clear && !reduced && (
          <g>
            {threads.map((_, i) => (
              <motion.path
                key={`glint-${i}`}
                d={curve(slot(i), slot(order.indexOf(i)), 0)}
                fill="none"
                className="stroke-terracotta"
                strokeWidth={2}
                initial={{ pathLength: 0, pathOffset: 0, opacity: 0.9 }}
                animate={{
                  pathLength: [0, 0.2, 0],
                  pathOffset: [0, 0.4, 1],
                  opacity: [0.9, 0.9, 0],
                }}
                transition={{ duration: 1.4, delay: 1 + i * 0.03, ease: 'easeInOut' }}
              />
            ))}
          </g>
        )}

        <Bank x={LEFT_X} name="Notion" source={find('notion')} glowId={glowId} />
        <Bank x={RIGHT_X} name="GitLab" source={find('gitlab')} glowId={glowId} />

        {/* the tally, in words */}
        <text
          x={W / 2}
          y={36}
          textAnchor="middle"
          className="fill-foreground font-mono"
          fontSize={30}
          letterSpacing={-1}
        >
          {total === 0
            ? '—'
            : `${String(word('taut')).padStart(3, '0')}/${String(total).padStart(3, '0')}`}
        </text>
        <text
          x={W / 2}
          y={54}
          textAnchor="middle"
          className="fill-muted-foreground text-micro font-semibold uppercase"
        >
          {empty
            ? 'No findings yet'
            : `${clear ? 'All taut: in sync' : `taut · ${word('slack') + word('strained')} slack · ${word('snapped')} snapped`}${loose ? ` · ${loose} loose ends` : ''}`}
        </text>
      </svg>
    </div>
  );
}
