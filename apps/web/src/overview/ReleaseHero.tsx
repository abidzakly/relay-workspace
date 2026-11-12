import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProgressModel } from '@/core3d/progressMapping';
import { describeError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { releaseSummary } from './model';
import { Panel, ToneBadge } from './Panel';
import { UnknownReposAlert } from './ProgressSummary';

/**
 * The release numbers: percent, state, and the four counts. Readable without the 3D stage (the stage
 * repeats the story, it never carries it alone).
 */
export function ReleaseFigures({
  model,
  error,
  className,
}: {
  model: ProgressModel | null;
  error: unknown;
  className?: string;
}) {
  if (!model) {
    return (
      <div className={className}>
        <div className="text-4xl font-semibold tabular-nums">—</div>
        <p className="text-xs text-muted-foreground">
          {error ? `Could not load the cards: ${describeError(error)}` : 'Loading…'}
        </p>
      </div>
    );
  }
  const s = releaseSummary(model);
  const fill = s.percent === null ? 0 : Math.min(100, Math.max(0, s.percent));
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <span
          className="ov-poster text-7xl leading-none font-semibold tracking-[-0.05em] tabular-nums"
          aria-label={`Release progress ${s.percentText === '—' ? 'unknown' : s.percentText}`}
        >
          {s.percent === null ? '—' : s.percent}
          {s.percent !== null && <span className="align-top text-3xl">%</span>}
        </span>
        <ToneBadge
          tone={s.tone}
          label={
            s.tone === 'nodata'
              ? 'No data'
              : s.partial
                ? 'Partial'
                : s.tone === 'good'
                  ? 'Ready to Test'
                  : 'In progress'
          }
        />
      </div>
      {/* the cycle as a ruler: ink up to the share that is Ready to Test */}
      <div className="grid gap-1" aria-hidden>
        <div className="relative h-0.5 bg-foreground/12">
          <div
            className="absolute inset-y-0 left-0 bg-foreground transition-[width] duration-700 ease-[var(--ease-editorial)]"
            style={{ width: `${fill}%` }}
          />
          <span
            className="absolute -top-1 size-2.5 -translate-x-1/2 rotate-45 bg-foreground transition-[left] duration-700 ease-[var(--ease-editorial)]"
            style={{ left: `${fill}%` }}
          />
        </div>
        <div className="flex justify-between font-mono text-2xs text-muted-foreground">
          <span>0</span>
          <span>
            Ready to <span className="type-accent text-xs">test</span>
          </span>
          <span>100</span>
        </div>
      </div>
      {s.gapText && <p className="text-xs text-muted-foreground">{s.gapText}</p>}
      <dl className="ov-facts grid grid-cols-2 gap-x-4 sm:grid-cols-4" aria-label="Cards">
        {s.facts.map((f) => (
          <div
            key={f.key}
            className="flex min-w-0 flex-col-reverse gap-0.5 border-t border-hairline py-2"
          >
            <dt className="type-micro text-muted-foreground">{f.label}</dt>
            <dd className="font-mono text-2xl leading-tight tabular-nums">{f.value}</dd>
          </div>
        ))}
      </dl>
      <UnknownReposAlert model={model} />
    </div>
  );
}

/**
 * Release hero: one story for the percent, the counts and the CoreStage. `stage` is the stage
 * itself in Classic; in the Living Workspace the ship is the scene, so the hero carries the Backlog instead.
 */
export function ReleaseHero({
  model,
  error,
  scopeLabel,
  controls,
  stage,
  className,
}: {
  model: ProgressModel | null;
  error: unknown;
  scopeLabel: string;
  /** The stage view switch, near the stage it changes. */
  controls?: ReactNode;
  stage?: ReactNode;
  className?: string;
}) {
  return (
    <Panel
      n={1}
      title="Release"
      context={`${scopeLabel} · cards Ready to Test over cards in the flow`}
      actions={
        <Link
          to="/release"
          className="text-xs text-primary-ink underline-offset-4 hover:underline focus-visible:underline"
        >
          Open Release
        </Link>
      }
      className={className}
    >
      <ReleaseFigures model={model} error={error} />
      {controls}
      {stage}
    </Panel>
  );
}
