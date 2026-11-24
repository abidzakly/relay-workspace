import { motion } from 'motion/react';
import type { KpiReport, SlaState } from '@relay/shared';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';
import { formatPercent } from '../model';
import { Key } from './parts';
import './viz.css';
import { scrollToSection, useKpiView } from './store';

const IN_FLIGHT: readonly SlaState[] = ['not_started', 'on_track', 'over_70', 'over_90'];

type Part = 'met' | 'breached' | 'inFlight';
const PART: Record<Part, { label: string; states: readonly SlaState[]; cls: string }> = {
  met: { label: 'met', states: ['met'], cls: 'bg-foreground' },
  breached: { label: 'breached', states: ['breached'], cls: 'bg-destructive' },
  inFlight: { label: 'in flight', states: IN_FLIGHT, cls: '' },
};

/**
 * SLA by type as one stacked bar per type: met, breached, in flight. Bars share one scale, so a busy type is a long
 * bar. The hit-rate is said on the right. Click a part to see those cards in the SLA table.
 */
export function SlaTypeBars({ report }: { report: KpiReport }) {
  const reduced = useReducedMotion();
  const setFilter = useKpiView((s) => s.setFilter);
  const filter = useKpiView((s) => s.filter);
  const { byType } = report.scorecard.sla;
  if (byType.length === 0) {
    return <p className="text-sm text-muted-foreground">No cards with a timer in this month.</p>;
  }
  const most = Math.max(1, ...byType.map((t) => t.met + t.breached + t.inFlight));
  const open = (type: string, part: Part) => {
    setFilter({ type, states: PART[part].states, label: `${type} · ${PART[part].label}` });
    requestAnimationFrame(() => scrollToSection('kpi-sla-table'));
  };
  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Key swatch={<span className="h-2 w-3 rounded-sm bg-foreground" />}>met</Key>
        <Key swatch={<span className="h-2 w-3 rounded-sm bg-destructive" />}>breached</Key>
        <Key swatch={<span className="kpi-hatch h-2 w-3 rounded-sm" />}>in flight, not counted</Key>
        <span>Click a part to see its cards</span>
      </p>
      <ul className="grid gap-2.5">
        {byType.map((t, row) => {
          const total = t.met + t.breached + t.inFlight;
          return (
            <li
              key={t.type}
              className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_6.5rem] items-center gap-3 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{t.type}</span>
                <span className="font-mono text-2xs text-muted-foreground">
                  {t.ruleDays === null ? 'no rule' : `${t.ruleDays}d rule`}
                  {t.avgResolutionLabel && ` · avg ${t.avgResolutionLabel}`}
                </span>
              </span>
              <motion.div
                className="flex h-5 gap-0.5"
                style={{ width: `${(total / most) * 100}%`, originX: 0 }}
                initial={reduced ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.7, delay: row * 0.05, ease: [0.22, 1, 0.36, 1] }}
              >
                {(['met', 'breached', 'inFlight'] as const).map((p) => {
                  const n = t[p];
                  if (n === 0) return null;
                  const on =
                    filter?.type === t.type && filter.states?.join() === PART[p].states.join();
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => open(t.type, p)}
                      title={`${t.type}: ${n} ${PART[p].label}`}
                      aria-label={`${t.type}: ${n} ${PART[p].label}. Show these cards`}
                      className={cn(
                        'tactile h-full min-w-1.5 rounded-[4px] outline-none first:rounded-l-[4px] focus-visible:ring-2 focus-visible:ring-ring',
                        PART[p].cls,
                        p === 'inFlight' && 'kpi-hatch',
                        'hover:brightness-110 hover:saturate-150',
                        on && 'ring-2 ring-terracotta ring-offset-1 ring-offset-background',
                      )}
                      style={{ flexGrow: n, flexBasis: 0 }}
                    />
                  );
                })}
              </motion.div>
              <span className="text-right">
                <span
                  className={cn(
                    'block font-mono tabular-nums',
                    t.breached > 0 && 'text-destructive',
                  )}
                >
                  {t.hitRate === null ? '—' : formatPercent(t.hitRate)}
                </span>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {t.met}✓ {t.breached > 0 ? `${t.breached}✕ ` : ''}
                  {t.inFlight > 0 ? `${t.inFlight}…` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
