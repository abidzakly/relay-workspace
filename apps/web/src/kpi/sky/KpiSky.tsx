import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { KpiReport } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { cn } from '@/lib/utils';
import { useHidden, useReducedMotion } from '@/workspace/useMedia';
import type { GaugeTone } from '../model';
import { scrollToSection, useKpiView } from '../viz/store';
import { Constellations } from './Constellations';
import { DreamPool } from './DreamPool';
import {
  BODY_SECTION,
  SKY_THEMES,
  skyModel,
  type BodyKey,
  type KpiSkyModel,
  type SkyBody,
} from './model';
import type { SceneProps } from './parts';
import { Tide } from './Tide';
import './sky.css';

const BADGE: Record<GaugeTone, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  good: 'success',
  warning: 'warning',
  critical: 'destructive',
  neutral: 'secondary',
};

const SCENES = { pool: DreamPool, stars: Constellations, tide: Tide } as const;

/** The theme switch: three skies for the same numbers. Browser-local. */
function ThemeSwitch() {
  const theme = useKpiView((s) => s.theme);
  const setTheme = useKpiView((s) => s.setTheme);
  return (
    <div
      role="radiogroup"
      aria-label="KPI visual"
      className="inline-flex items-center gap-0.5 rounded-full border border-hairline p-1"
    >
      {SKY_THEMES.map((t) => {
        const on = theme === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={t.hint}
            onClick={() => setTheme(t.id)}
            className={cn(
              'tactile inline-flex h-7 items-center rounded-full px-3 text-xs font-medium tracking-[0.06em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/70',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** A legend row: the KPI in words, with a thin meter that repeats it. The scene is a picture of this list. */
function LegendRow({
  body,
  focused,
  onFocus,
  onPick,
}: {
  body: SkyBody;
  focused: boolean;
  onFocus: (k: BodyKey | null) => void;
  onPick: (k: BodyKey) => void;
}) {
  const { gauge } = body;
  const percent = body.fraction === null ? null : Math.round(body.fraction * 1000) / 10;
  const urgent = body.tone === 'critical' || body.tone === 'warning';
  return (
    <li>
      <button
        type="button"
        onPointerEnter={() => onFocus(body.key)}
        onPointerLeave={() => onFocus(null)}
        onFocus={() => onFocus(body.key)}
        onBlur={() => onFocus(null)}
        onClick={() => onPick(body.key)}
        className={cn(
          'tactile grid w-full gap-1.5 rounded-md border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
          focused ? 'border-foreground/40 bg-accent/60' : 'border-transparent hover:bg-accent/40',
          body.tone === 'critical' && 'border-destructive/30',
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="type-micro text-muted-foreground">{gauge.label}</span>
          <Badge variant={BADGE[body.tone]}>
            <gauge.status.icon aria-hidden />
            {gauge.status.label}
          </Badge>
        </span>
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'leading-none font-semibold tracking-[-0.03em] tabular-nums',
              urgent ? 'text-3xl' : 'text-2xl',
            )}
          >
            {gauge.valueText}
          </span>
          {gauge.threshold && (
            <span className="font-mono text-2xs text-muted-foreground">
              {gauge.threshold.label}
            </span>
          )}
        </span>
        <span
          className="relative block h-1 rounded-full bg-foreground/10"
          {...(percent === null
            ? { 'aria-hidden': true }
            : {
                role: 'meter',
                'aria-label': gauge.label,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': percent,
                'aria-valuetext': `${gauge.valueText}, ${gauge.status.label}${gauge.threshold ? `, ${gauge.threshold.label}` : ''}`,
              })}
        >
          {percent !== null && (
            <span
              className={cn(
                'absolute inset-y-0 left-0 rounded-full',
                body.tone === 'critical'
                  ? 'bg-destructive'
                  : body.tone === 'warning'
                    ? 'bg-warning'
                    : 'bg-foreground',
              )}
              style={{ width: `${Math.max(2, percent)}%` }}
            />
          )}
          {body.target !== null && body.key !== 'research' && (
            <span
              className="absolute -top-1 h-3 w-0.5 rounded-full bg-terracotta"
              style={{ left: `${body.target * 100}%` }}
            />
          )}
        </span>
        {urgent && <span className="text-xs text-muted-foreground">{gauge.detail}</span>}
      </button>
    </li>
  );
}

function Verdict({ model, live }: { model: KpiSkyModel; live: boolean }) {
  const { verdict } = model;
  return (
    <div className="grid gap-1">
      <p className="type-micro text-muted-foreground">
        {verdict.withLine > 0 ? `${verdict.onLine} of ${verdict.withLine} lines met` : 'This month'}
        {model.current && ` · ${Math.round(model.monthProgress * 100)}% of the month gone`}
      </p>
      <p
        className={cn(
          'text-2xl leading-tight font-semibold tracking-[-0.03em] sm:text-3xl',
          verdict.tone === 'critical' && 'text-destructive',
          verdict.tone === 'warning' && 'text-warning',
        )}
      >
        {live && verdict.tone === 'critical' && (
          <span
            aria-hidden
            className="mr-2 inline-block size-2.5 -translate-y-1 rounded-full bg-destructive motion-safe:animate-pulse"
          />
        )}
        {verdict.headline}
      </p>
      {verdict.sub && <p className="max-w-prose text-sm text-muted-foreground">{verdict.sub}</p>}
    </div>
  );
}

/**
 * The KPI sky: the scorecard as one picture, in the theme the user picked (Dream pool, Constellations, Tide), with the
 * same numbers in words beside it, most urgent first. Pointing at a KPI in the list lights it in the picture, and the
 * other way round; clicking opens its section. `compact` is the Overview's version: a smaller stage, no switch.
 */
export function KpiSky({
  report,
  presets,
  compact = false,
  size = 'sm',
  onPick,
}: {
  report: KpiReport;
  presets: { bugRatio: boolean; researchQuota: boolean };
  compact?: boolean;
  /** The emblem's size in compact mode: `sm` on the cover's footer, `md` beside the front page's markets. */
  size?: 'sm' | 'md';
  /** Overrides the click on a KPI (Overview opens the KPI page). */
  onPick?: (key: BodyKey) => void;
}) {
  const theme = useKpiView((s) => s.theme);
  const reduced = useReducedMotion();
  const hidden = useHidden();
  const [now] = useState(() => Date.now());
  const [focus, setFocus] = useState<BodyKey | null>(null);
  const model = useMemo(() => skyModel(report, presets, { now }), [report, presets, now]);
  const pick = onPick ?? ((k: BodyKey) => scrollToSection(BODY_SECTION[k]));
  const Scene = SCENES[theme] ?? DreamPool;
  const props: SceneProps = {
    model,
    focus,
    onFocus: setFocus,
    onPick: pick,
    onPickLate: () => (onPick ? onPick('completion') : scrollToSection('kpi-late')),
    compact,
    still: reduced || hidden,
  };
  const ordered = [...model.bodies].sort((a, b) => a.rank - b.rank);
  const alarm = model.verdict.tone === 'critical';

  if (compact) {
    // The Overview's emblem: the picture only; the cover's strip beside it says the numbers.
    return (
      <div
        className={cn(
          'shrink-0',
          size === 'md' ? (theme === 'pool' ? 'w-52' : 'w-80') : theme === 'pool' ? 'w-28' : 'w-60',
        )}
      >
        <Scene {...props} />
      </div>
    );
  }

  return (
    <section aria-label="KPI at a glance" className="relative isolate grid gap-5">
      {/* The aura: violet when calm, it warms to red and breathes when something is failing. */}
      <motion.div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-x-16 -inset-y-10 -z-10',
          alarm && !reduced && 'kpi-aura',
        )}
        style={{
          background: `radial-gradient(40% 55% at 20% 20%, color-mix(in oklch, ${alarm ? 'var(--destructive)' : 'var(--emphasis)'} ${alarm ? 14 : 10}%, transparent), transparent 70%), radial-gradient(45% 60% at 80% 80%, color-mix(in oklch, var(--terracotta) 12%, transparent), transparent 70%)`,
        }}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Verdict model={model} live={!reduced} />
        <ThemeSwitch />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-center">
        <motion.div
          key={theme}
          initial={reduced ? false : { opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <Scene {...props} />
        </motion.div>
        <ol className="grid gap-1.5" aria-label="KPIs, most urgent first">
          {ordered.map((b) => (
            <LegendRow
              key={b.key}
              body={b}
              focused={focus === b.key}
              onFocus={setFocus}
              onPick={pick}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}
