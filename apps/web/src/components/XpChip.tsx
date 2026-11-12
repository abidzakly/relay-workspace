import { animate } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useGamification } from '@/lib/gamificationApi';
import { SPRING } from '@/lib/motion/presets';
import { subscribePresented } from '@/lib/reward/engine';
import { cn } from '@/lib/utils';
import { progressionSummary } from '@/overview/model';
import { useReducedMotion } from '@/workspace/useMedia';

/** Counts up to the server's number when it changes. The first value is shown as it is. */
function useCountUp(value: number | null): number | null {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (value === null || from === null || from === value || reduced) {
      setShown(value);
      return;
    }
    const controls = animate(from, value, {
      ...SPRING.settle,
      onUpdate: (v) => setShown(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, reduced]);
  return shown;
}

/**
 * Level and XP, always in view: on the world HUD, every page bar and the classic layout. `+N XP` flies into
 * `[data-xp-chip]`. Numbers are from the server report only. It shows nothing until there is a report.
 */
export function XpChip({ className }: { className?: string }) {
  const report = useGamification().data;
  const summary = report ? progressionSummary(report) : null;
  const xp = useCountUp(summary?.xp ?? null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribePresented((reward) => {
      if (reward.level === 'tick') return;
      setPulse(true);
      clearTimeout(timer);
      timer = setTimeout(() => setPulse(false), 750);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  if (!summary) return null;
  return (
    <div
      data-xp-chip
      data-pulse={pulse || undefined}
      title={`Level ${summary.level} · ${summary.xp} XP · ${summary.xpToNext} XP to level ${summary.level + 1}`}
      className={cn('xp-chip flex min-w-0 shrink-0 items-center gap-1.5', className)}
    >
      <span className="type-micro tabular-nums">
        <span aria-hidden>L{summary.level}</span>
        <span className="sr-only">Level {summary.level}</span>
      </span>
      <div
        role="progressbar"
        aria-label={`Progress to level ${summary.level + 1}`}
        aria-valuemin={0}
        aria-valuemax={summary.xpForLevel}
        aria-valuenow={summary.xpIntoLevel}
        className="h-px w-10 overflow-visible bg-foreground/20 sm:w-16"
      >
        <div
          className="xp-chip-fill relative h-full bg-foreground after:absolute after:top-1/2 after:right-0 after:size-1.5 after:translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-foreground"
          style={{ width: `${summary.fraction * 100}%` }}
        />
      </div>
      <span className="hidden type-micro text-muted-foreground tabular-nums sm:inline">
        {xp} XP
      </span>
    </div>
  );
}
