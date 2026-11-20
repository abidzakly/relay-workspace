import { animate, motion, useMotionValue, useMotionValueEvent } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Job } from '@relay/shared';
import { BASE, Gem, GlassGradients, Mote, SealBurst, prism } from '@/components/glass/parts';
import { SPRING } from '@/lib/motion/presets';
import { playSound } from '@/lib/sound/engine';
import { cn } from '@/lib/utils';
import type { Stage } from '@/release/model';
import { useReducedMotion } from '@/workspace/useMedia';
import { buildPhases } from './buildPhases';
import type { BuildLog } from './useBuildLog';

const W = 520;
const H = 186;
const CX = 260;
const RULE = 220;
const MOTES = 22;

const finished = (s: Stage) => s.state === 'done' || s.state === 'skipped';

/** How much of the crystal has grown: a finished phase counts whole, a working one half. */
function progress(stages: Stage[]): number {
  if (stages.length === 0) return 0;
  const n = stages.reduce((sum, s) => sum + (finished(s) ? 1 : s.state === 'active' ? 0.5 : 0), 0);
  return Math.min(1, n / stages.length);
}

const WORD: Record<Stage['state'], string> = {
  done: 'done',
  active: 'in progress',
  waiting: 'waiting',
  failed: 'failed',
  skipped: 'skipped',
  unknown: 'cannot tell',
  idle: 'not reached',
};

/**
 * A build as a crystal growing on its own. It is the hold-to-start crystal, but nobody holds it: each phase the log
 * reaches (prepare, flavor, each flutter command, the saved file) grows it further, grains stream in while a phase
 * works, a failure cracks it, and a build that finishes while watched seals with a burst. The phase list below says
 * every phase's state in words, and the newest flutter line runs under it, so the picture is never the only signal.
 */
export function BuildCrystal({ job, log }: { job: Job; log: BuildLog }) {
  const reduced = useReducedMotion();
  const uid = useId();
  const glowId = `${uid}-glow`;
  const haloId = `${uid}-halo`;
  const allId = `${uid}-all`;

  const { stages, activity, current } = useMemo(
    () => buildPhases(job, log.lines),
    [job, log.lines],
  );
  const failed = stages.some((s) => s.state === 'failed');
  const working = stages.some((s) => s.state === 'active');
  const sealed = job.status === 'succeeded';
  const target = sealed ? 1 : progress(stages);

  const growth = useMotionValue(target);
  const flash = useMotionValue(0);
  const stream = useMotionValue(working ? 1 : 0);
  const clock = useMotionValue(0);
  const [pct, setPct] = useState(Math.round(target * 100));
  useMotionValueEvent(growth, 'change', (g) => setPct(Math.round(g * 100)));

  useEffect(() => {
    const c = animate(growth, target, reduced ? { duration: 0 } : SPRING.windup);
    return () => c.stop();
  }, [target, reduced, growth]);

  // Grains only while a phase works; a slow clock keeps them falling in.
  useEffect(() => {
    const fade = animate(stream, working && !reduced ? 1 : 0, { duration: 0.4 });
    if (!working || reduced) return () => fade.stop();
    const loop = animate(clock, [0, 1], { duration: 6, repeat: Infinity, ease: 'linear' });
    return () => {
      fade.stop();
      loop.stop();
    };
  }, [working, reduced, stream, clock]);

  // The seal: only when the build finishes in front of you, never for one opened already done.
  const lastStatus = useRef(job.status);
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = job.status;
    if (was === job.status || job.status !== 'succeeded') return;
    if (!reduced) {
      setBurst((n) => n + 1);
      void animate(flash, [0, 0.65, 0], { duration: 0.6, times: [0, 0.12, 1] });
    }
    if (!job.dryRun) playSound('pop');
  }, [job.status, job.dryRun, reduced, flash]);

  const shape = prism(CX, 52, 128);
  const n = stages.length;
  const tickAt = (i: number) => (n <= 1 ? 1 : (i + 1) / n);
  const here = stages[current];

  return (
    <div className="grid gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mx-auto block h-auto w-full max-w-xl overflow-visible select-none"
        role="img"
        aria-label={
          sealed
            ? 'The build is done: the crystal is sealed.'
            : failed
              ? `The build failed at ${here?.label ?? 'a phase'}: the crystal cracked.`
              : `The build crystal is ${pct} percent grown, at ${here?.label ?? 'the start'}.`
        }
      >
        <defs>
          <GlassGradients glowId={glowId} haloId={haloId} />
          <clipPath id={allId}>
            <path d={shape.outline} />
          </clipPath>
        </defs>

        {/* the HUD: phases reached so far, and the counter */}
        <text x={40} y={26} className="fill-muted-foreground text-micro font-semibold uppercase">
          Phases
        </text>
        {stages.map((s, i) => (
          <rect
            key={s.label}
            x={44 + i * 14}
            y={36}
            width={7}
            height={7}
            transform={`rotate(45 ${47.5 + i * 14} 39.5)`}
            className={cn(
              s.state === 'failed'
                ? 'fill-destructive'
                : finished(s)
                  ? 'fill-foreground'
                  : s.state === 'active'
                    ? 'fill-terracotta motion-safe:animate-pulse'
                    : 'fill-none stroke-foreground/40 [stroke-width:1]',
            )}
          />
        ))}
        <text
          x={W - 40}
          y={40}
          textAnchor="end"
          className={cn('font-mono', failed ? 'fill-destructive' : 'fill-foreground')}
          fontSize={30}
          letterSpacing={-1}
        >
          {String(pct).padStart(3, '0')}
        </text>

        <motion.ellipse
          cx={CX}
          cy={BASE}
          rx={110}
          ry={14}
          fill={`url(#${haloId})`}
          initial={false}
          animate={{ opacity: failed ? 0.15 : target * 0.85 }}
        />

        {/* the ink line, a tick per phase, and the rule out to where the build has reached */}
        <line x1={40} x2={W - 40} y1={BASE} y2={BASE} className="stroke-foreground/20" />
        {[-1, 1].map((side) => (
          <motion.line
            key={side}
            x1={CX}
            y1={BASE}
            y2={BASE}
            className={failed ? 'stroke-destructive' : 'stroke-foreground'}
            strokeWidth={1.5}
            initial={false}
            animate={{ x2: CX + side * target * RULE }}
            transition={reduced ? { duration: 0 } : SPRING.windup}
          />
        ))}
        {stages.flatMap((s, i) =>
          [-1, 1].map((side) => (
            <line
              key={`${s.label}${side}`}
              x1={CX + side * tickAt(i) * RULE}
              x2={CX + side * tickAt(i) * RULE}
              y1={BASE - 4}
              y2={BASE + 4}
              className={finished(s) ? 'stroke-foreground' : 'stroke-foreground/25'}
            />
          )),
        )}

        {/* growth rings while a phase works */}
        {working &&
          !reduced &&
          [0, 1, 2].map((i) => (
            <motion.ellipse
              key={`ring-${i}`}
              cx={CX}
              cy={BASE}
              fill="none"
              className="stroke-foreground/30"
              initial={{ rx: 6, ry: 1.5, opacity: 0.6 }}
              animate={{ rx: 140, ry: 13, opacity: 0 }}
              transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: 'easeOut' }}
            />
          ))}

        <motion.g
          initial={false}
          animate={{ opacity: failed || job.status === 'cancelled' ? 0.6 : 1 }}
          transition={{ duration: 0.3 }}
        >
          <Gem shape={shape} growth={growth} flash={flash} cracked={failed} glowId={glowId} />
        </motion.g>

        {!reduced &&
          Array.from({ length: MOTES }, (_, i) => (
            <Mote key={i} i={i} clock={clock} growth={growth} stream={stream} shape={shape} />
          ))}

        {burst > 0 && <SealBurst key={`burst-${burst}`} shapes={[shape]} clip={allId} cx={CX} />}

        <text
          x={CX}
          y={BASE + 20}
          textAnchor="middle"
          className={cn(
            'text-micro font-semibold uppercase',
            failed ? 'fill-destructive' : 'fill-muted-foreground',
          )}
        >
          {sealed ? (job.dryRun ? 'Simulated' : 'Built') : (here?.label ?? '')}
        </text>
      </svg>

      <ol className="flex flex-wrap gap-x-5 gap-y-1 text-xs" aria-label="Build phases">
        {stages.map((s, i) => (
          <li
            key={s.label}
            aria-current={i === current && !sealed ? 'step' : undefined}
            className="grid min-w-0"
          >
            <span className="type-micro">
              <span className="mr-1 text-muted-foreground">({String(i + 1).padStart(2, '0')})</span>
              {s.label}
            </span>
            <span
              className={cn(
                s.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                'max-w-56 truncate',
              )}
              title={s.note}
            >
              {WORD[s.state]}
              {s.note !== '' && `: ${s.note}`}
            </span>
          </li>
        ))}
      </ol>

      {activity !== null && !log.ended && (
        <p
          className="truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground"
          title={activity}
          aria-live="off"
        >
          {activity}
        </p>
      )}
    </div>
  );
}
