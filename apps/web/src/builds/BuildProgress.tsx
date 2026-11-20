import type { Job } from '@relay/shared';
import { ModeSwitch } from '@/components/ModeSwitch';
import { useLogView } from '@/lib/visuals';
import type { LogViewPage } from '@/store/ui';
import { BuildCrystal } from './BuildCrystal';
import { LogViewer } from './LogViewer';
import { useBuildLog } from './useBuildLog';

/**
 * One build's progress: the growing crystal, or the plain log, with a switch between them. The log is streamed once
 * here, so switching never reconnects or loses lines. Mount with `key={jobId}`. Without the job (not in the list yet),
 * only the log shows.
 */
export function BuildProgress({
  jobId,
  job,
  page = 'builds',
}: {
  jobId: string;
  job: Job | null;
  /** Whose switch setting it follows. */
  page?: LogViewPage;
}) {
  const log = useBuildLog(jobId);
  const { view, canSwitch, options, setView } = useLogView(page);
  const visual = view === 'visual' && job !== null;

  return (
    <div className="grid gap-3">
      {canSwitch && job !== null && (
        <ModeSwitch
          label="Build log view"
          options={options}
          value={view}
          onChange={setView}
          className="justify-self-end"
        />
      )}
      {visual ? <BuildCrystal job={job} log={log} /> : <LogViewer log={log} />}
    </div>
  );
}
