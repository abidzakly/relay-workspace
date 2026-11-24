import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { formatHours, type KpiReport } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import { Key } from './parts';

const MAX_BEADS = 60;

function Panel({
  label,
  value,
  children,
  hint,
}: {
  label: string;
  value: string;
  children?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid content-start gap-3 rounded-lg border border-hairline bg-card/60 p-4">
      <div className="grid gap-1">
        <span className="type-micro text-muted-foreground">{label}</span>
        <span className="font-mono text-2xl leading-none tabular-nums">{value}</span>
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Effort: done hours poured into the committed hours. */
function Effort({ report }: { report: KpiReport }) {
  const reduced = useReducedMotion();
  const e = report.scorecard.effort;
  if (!e) return <Panel label="Effort (Point)" value="—" hint="Not recorded for this month" />;
  const f = e.totalHours === 0 ? 0 : Math.min(1, e.doneHours / e.totalHours);
  return (
    <Panel
      label="Effort (Point)"
      value={`${formatHours(e.doneHours)} / ${formatHours(e.totalHours)}`}
      hint={`Done of committed hours · ${e.research} research, ${e.unestimated} without a Point`}
    >
      <div
        className="relative h-3 overflow-hidden rounded-full bg-foreground/10"
        role="meter"
        aria-label="Effort done"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(f * 100)}
      >
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: 'linear-gradient(90deg, var(--terracotta), var(--emphasis))' }}
          initial={{ width: reduced ? `${f * 100}%` : 0 }}
          animate={{ width: `${f * 100}%` }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
        {Math.round(f * 100)}% done
      </span>
    </Panel>
  );
}

/** Cards: one bead each. Solid has a timer, a ring is an approximate assigned-at, hollow has no timer. */
function Cards({ report }: { report: KpiReport }) {
  const { cards, untracked, approxAssignedAt } = report.scorecard.counts;
  const shown = Math.min(MAX_BEADS, cards);
  const scale = cards === 0 ? 0 : shown / cards;
  const nUntracked = Math.round(untracked * scale);
  const nApprox = Math.min(shown - nUntracked, Math.round(approxAssignedAt * scale));
  return (
    <Panel label="Cards" value={String(cards)}>
      {cards === 0 ? (
        <p className="text-xs text-muted-foreground">No cards this month.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1" aria-hidden>
            {Array.from({ length: shown }, (_, i) => {
              const kind =
                i < shown - nUntracked - nApprox
                  ? 'timer'
                  : i < shown - nUntracked
                    ? 'approx'
                    : 'none';
              return (
                <span
                  key={i}
                  className={cn(
                    'size-2.5 rounded-full',
                    kind === 'timer' && 'bg-foreground',
                    kind === 'approx' && 'border-2 border-foreground',
                    kind === 'none' && 'border border-dashed border-foreground/50',
                  )}
                />
              );
            })}
            {cards > shown && (
              <span className="font-mono text-2xs text-muted-foreground">+{cards - shown}</span>
            )}
          </div>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <Key swatch={<span className="size-2 rounded-full bg-foreground" />}>
              {cards - untracked - approxAssignedAt} timed
            </Key>
            <Key swatch={<span className="size-2 rounded-full border-2 border-foreground" />}>
              {approxAssignedAt} approx
            </Key>
            <Key
              swatch={
                <span className="size-2 rounded-full border border-dashed border-foreground/60" />
              }
            >
              {untracked} no timer
            </Key>
          </p>
        </>
      )}
    </Panel>
  );
}

/** Flow: how long work takes. Review latency as median and mean on one line, so a long tail shows as their gap. */
function Flow({ report }: { report: KpiReport }) {
  const o = report.scorecard.sla.overall;
  const rl = report.scorecard.reviewLatency;
  const top = Math.max(rl.meanMs ?? 0, rl.medianMs ?? 0) * 1.25 || 1;
  const at = (ms: number | null) => (ms === null ? null : `${(ms / top) * 100}%`);
  return (
    <Panel
      label="Avg resolution"
      value={o.avgResolutionLabel ?? '—'}
      hint="Start clock to MR opened"
    >
      <div className="grid gap-1.5">
        <span className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Review latency</span>
          <span className="font-mono tabular-nums">{rl.meanLabel ?? '—'}</span>
        </span>
        <div className="relative h-4" aria-hidden>
          <span className="absolute inset-x-0 top-1/2 h-px bg-foreground/20" />
          {at(rl.medianMs) && (
            <span
              className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-terracotta"
              style={{ left: at(rl.medianMs)! }}
            />
          )}
          {at(rl.meanMs) && (
            <span
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground"
              style={{ left: at(rl.meanMs)! }}
            />
          )}
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Key swatch={<span className="size-2 rotate-45 bg-terracotta" />}>
            median {rl.medianLabel ?? '—'}
          </Key>
          <Key swatch={<span className="size-2 rounded-full bg-foreground" />}>mean</Key>
          <span>
            {rl.sampled} sampled, {rl.withoutResponse} without a response
          </span>
        </p>
      </div>
      <p className="flex items-center gap-2 text-xs">
        <span className="relative flex size-2">
          {o.inFlight > 0 && (
            <span className="absolute inline-flex size-full rounded-full bg-terracotta opacity-70 motion-safe:animate-ping" />
          )}
          <span className="relative inline-flex size-2 rounded-full bg-terracotta" />
        </span>
        <span className="font-mono tabular-nums">{o.inFlight}</span>
        <span className="text-muted-foreground">in flight, outside the hit-rate</span>
      </p>
    </Panel>
  );
}

/** The month in numbers, drawn: effort poured, cards as beads, how long the work flows. */
export function MonthFigures({
  report,
  pointsAsHours,
}: {
  report: KpiReport;
  pointsAsHours: boolean;
}) {
  return (
    <div className={cn('grid gap-3', pointsAsHours ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
      {pointsAsHours && <Effort report={report} />}
      <Cards report={report} />
      <Flow report={report} />
    </div>
  );
}
