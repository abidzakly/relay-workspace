import type { GamificationBadge, GamificationReport } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { describeError } from '@/lib/api';
import { useGamification } from '@/lib/gamificationApi';
import { cn } from '@/lib/utils';
import { BADGES } from './badges';
import { progressionSummary } from './model';
import { Panel } from './Panel';

function BadgeTile({ badge }: { badge: GamificationBadge }) {
  const info = BADGES[badge.id];
  const Icon = info.icon;
  const earned = badge.count > 0;
  return (
    <li
      title={info.rule}
      className={cn(
        'flex items-start gap-2 border-t border-hairline py-2 text-xs',
        !earned && 'text-muted-foreground',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', earned && 'text-primary-ink')} aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium break-words">
          {info.name}
          {badge.count > 1 && ` ×${badge.count}`}
        </span>
        <span className="block text-muted-foreground">
          {badge.lastEarnedAt !== null
            ? new Date(badge.lastEarnedAt).toLocaleDateString()
            : info.rule}
        </span>
      </span>
    </li>
  );
}

function Streak({ label, current, best }: { label: string; current: number; best: number }) {
  return (
    <div className="min-w-0 border-t border-hairline pt-2">
      <dt className="type-micro text-muted-foreground">{label}</dt>
      <dd className="font-mono text-2xl leading-tight tabular-nums">
        {current} <span className="text-xs text-muted-foreground">best {best}</span>
      </dd>
    </div>
  );
}

function Summary({ report, compact }: { report: GamificationReport; compact: boolean }) {
  const p = progressionSummary(report);
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="flex items-end justify-between gap-2">
          <span className="flex items-baseline gap-2">
            <span className="type-micro text-muted-foreground">Level</span>
            <span className="text-6xl leading-none font-semibold tracking-[-0.05em] tabular-nums">
              {p.level}
            </span>
          </span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{p.xp} XP</span>
        </p>
        <div
          role="progressbar"
          aria-label={`Progress to level ${p.level + 1}`}
          aria-valuemin={0}
          aria-valuemax={p.xpForLevel}
          aria-valuenow={p.xpIntoLevel}
          className="relative mt-2 h-1 bg-foreground/12"
        >
          <div
            className="absolute inset-y-0 left-0 bg-foreground transition-[width] duration-700 ease-[var(--ease-editorial)]"
            style={{ width: `${p.fraction * 100}%` }}
          />
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {p.xpToNext} XP to level {p.level + 1}
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-3">
        <Streak label="Clean releases" {...p.releases} />
        <Streak label="SLA-met days" {...p.slaDays} />
        <Streak label="Review days" {...p.reviewDays} />
      </dl>
      <details className="text-sm">
        <summary className="flex min-h-8 cursor-pointer items-center text-muted-foreground">
          Achievements · {p.badgesEarned} of {p.badgesTotal} earned
          {report.releases.length > 0 && ` · ${report.releases.length} releases`}
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          <ul className={cn('grid gap-x-4', !compact && 'sm:grid-cols-2')} aria-label="Badges">
            {report.badges.map((b) => (
              <BadgeTile key={b.id} badge={b} />
            ))}
          </ul>
          {report.releases.length > 0 && (
            <section aria-label="Release history">
              <h3 className="text-xs font-medium text-muted-foreground">Release history</h3>
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {report.releases.map((r) => (
                  <li key={r.jobId} className="flex flex-wrap justify-between gap-x-2">
                    <span className="min-w-0 break-words">
                      {r.repoId} {r.version ?? '(no version)'} · {r.mode}
                    </span>
                    <span className="text-muted-foreground">
                      +{r.xpEarned} XP · {r.mismatches} mismatch{r.mismatches === 1 ? '' : 'es'} ·
                      streak {r.streak} · {new Date(r.at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </details>
    </>
  );
}

/**
 * Progression: level, XP and streaks at a glance; achievements and release history
 * open on demand, so gamification never outweighs the work above it. Every award is decided on the server.
 */
export function ProgressionPanel({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const query = useGamification();
  return (
    <Panel n={6} title="Progression" context="Level and milestones" className={className}>
      {query.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load your level</AlertTitle>
          <AlertDescription>{describeError(query.error)}</AlertDescription>
        </Alert>
      )}
      {query.data && <Summary report={query.data} compact={compact} />}
    </Panel>
  );
}
