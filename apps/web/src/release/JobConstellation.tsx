import type { ReleaseJobView } from '@relay/shared';
import { BuildCrystal } from '@/builds/BuildCrystal';
import { useBuildLog } from '@/builds/useBuildLog';
import { useBuilds } from '@/lib/buildApi';
import { cn } from '@/lib/utils';
import { currentStage, jobStepStages, stateText, STEP_LABEL, stepOf } from './model';
import { StarMap } from './StarMap';
import { useJobLogTail } from './useJobLogTail';

/** The build the release's BUILD step started, as a crystal, while it runs. */
function ReleaseBuild({ buildJobId }: { buildJobId: string }) {
  const builds = useBuilds();
  const log = useBuildLog(buildJobId);
  const job = builds.data?.items.find((v) => v.job.id === buildJobId)?.job ?? null;
  if (job === null) return null;
  return <BuildCrystal job={job} log={log} />;
}

/**
 * The running release as a star map of its own steps: a star per step, joined as each one finishes, the working one
 * twinkling, a failed one breaking the line. Under it, the step in words and its newest lines as they are written.
 * While the BUILD step runs, the build it started grows as a crystal below.
 */
export function JobConstellation({ view }: { view: ReleaseJobView }) {
  const { job } = view;
  const stages = jobStepStages(view);
  const tail = useJobLogTail(job.id);
  const here = currentStage(stages);
  const stage = stages[here];
  const allDone = job.status === 'succeeded';
  const buildJobId = stateText(view, 'buildJobId');
  const buildRunning = stepOf(view, 'BUILD')?.status === 'running';
  const tailStep = tail.step !== null ? STEP_LABEL[tail.step] : null;
  // Only lines from the step the picture is on, so a finished step's last words do not linger.
  const lines = tailStep === stage?.label ? tail.lines : [];

  return (
    <div className="grid gap-3">
      <StarMap stages={stages} shipped={false} allDone={allDone} />
      {stage && (
        <p className="text-sm" aria-live="polite">
          <span className="type-micro mr-2 text-muted-foreground">
            ({String(here + 1).padStart(2, '0')}/{String(stages.length).padStart(2, '0')})
          </span>
          <span className={cn(stage.state === 'failed' && 'text-destructive')}>{stage.label}</span>
          {stage.note !== '' && <span className="text-muted-foreground">: {stage.note}</span>}
        </p>
      )}
      {lines.length > 0 && (
        <div className="grid rounded-md bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground">
          {lines.map((line, i) => (
            <span
              key={`${tail.lines.length}-${i}`}
              title={line}
              className={cn('truncate', i === lines.length - 1 && 'text-foreground')}
            >
              {line}
            </span>
          ))}
        </div>
      )}
      {buildRunning && buildJobId !== null && <ReleaseBuild buildJobId={buildJobId} />}
    </div>
  );
}
