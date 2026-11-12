import { Check, Circle, CircleHelp, Ellipsis, type LucideIcon, Minus, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getEventStream } from '@/lib/sse';
import { cn } from '@/lib/utils';
import { useVisual } from '@/lib/visuals';
import { currentStage, type Stage, type StageState } from './model';
import { StarMap } from './StarMap';

/** Colour is never the only signal: every stage shows its state's mark and word. */
const LOOK: Record<StageState, { mark: LucideIcon; word: string; stop: string }> = {
  done: { mark: Check, word: 'done', stop: 'border-foreground bg-foreground text-background' },
  active: {
    mark: Play,
    word: 'in progress',
    stop: 'border-foreground bg-background text-foreground ring-4 ring-foreground/10',
  },
  waiting: { mark: Ellipsis, word: 'waiting', stop: 'border-warning bg-background text-warning' },
  failed: {
    mark: X,
    word: 'failed',
    stop: 'border-destructive bg-background text-destructive',
  },
  skipped: {
    mark: Minus,
    word: 'skipped',
    stop: 'border-dashed border-foreground/40 bg-background text-muted-foreground',
  },
  unknown: {
    mark: CircleHelp,
    word: 'cannot tell',
    stop: 'border-dashed border-warning bg-background text-warning',
  },
  idle: {
    mark: Circle,
    word: 'not reached',
    stop: 'border-foreground/25 bg-background text-muted-foreground',
  },
};

/** True from a live release finishing here until the next one starts. A dry run never fires. */
function useShipped(repoId: string, running: boolean): boolean {
  const [shipped, setShipped] = useState(false);
  useEffect(
    () =>
      getEventStream().subscribe((e) => {
        if (e.type === 'release.done' && !e.dryRun && e.repoId === repoId) setShipped(true);
      }),
    [repoId],
  );
  useEffect(() => {
    if (running) setShipped(false);
  }, [running]);
  return shipped;
}

/**
 * The release pipeline: the star map (when Page visuals has it on) above the stage list. The list says every stage's
 * state in words, so the picture is never the only signal.
 */
export function PipelineStrip({ stages, repoId }: { stages: Stage[]; repoId: string }) {
  const here = currentStage(stages);
  const running = stages[here]?.state === 'active';
  const shipped = useShipped(repoId, running);
  const showVisual = useVisual('release');
  const allDone =
    stages.length > 0 && stages.every((s) => s.state === 'done' || s.state === 'skipped');

  return (
    <div className="grid gap-3">
      {showVisual && <StarMap stages={stages} shipped={shipped} allDone={allDone} />}

      <ol className="flex flex-col sm:flex-row" aria-label="Release pipeline">
        {stages.map((s, i) => {
          const look = LOOK[s.state];
          const atHere = i === here;
          const passed = s.state === 'done' && stages[i + 1]?.state !== 'idle';
          return (
            <li
              key={s.label}
              aria-current={atHere ? 'step' : undefined}
              className="relative flex min-w-0 gap-3 pb-3 sm:w-36 sm:shrink-0 sm:flex-col sm:gap-1.5 sm:pr-2 sm:pb-0"
            >
              {i < stages.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-4 left-4 h-full w-px sm:top-4 sm:left-4 sm:h-px sm:w-full',
                    passed ? 'bg-foreground' : 'bg-foreground/15',
                  )}
                />
              )}
              <span
                className={cn(
                  'relative grid size-8 shrink-0 place-items-center rounded-full border',
                  look.stop,
                )}
              >
                <look.mark aria-hidden className="size-3.5" />
              </span>
              <span className="grid min-w-0 text-xs">
                <span className="type-micro">
                  <span className="mr-1 text-muted-foreground">
                    ({String(i + 1).padStart(2, '0')})
                  </span>
                  {s.label}
                </span>
                <span className="text-muted-foreground">{look.word}</span>
                <span className="text-muted-foreground">{s.note}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
