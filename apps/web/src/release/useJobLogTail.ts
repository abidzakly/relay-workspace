import { useEffect, useState } from 'react';
import type { JobStepName } from '@relay/shared';
import { getEventStream } from '@/lib/sse';

export interface LogTail {
  step: JobStepName | null;
  lines: string[];
}

/**
 * The newest lines a running release job writes, live, from the `job.log` events (the step's stored log only refreshes
 * when the step changes). Starts over when the step changes.
 */
export function useJobLogTail(jobId: string, keep = 3): LogTail {
  const [tail, setTail] = useState<LogTail>({ step: null, lines: [] });
  useEffect(() => {
    setTail({ step: null, lines: [] });
    return getEventStream().subscribe((e) => {
      if (e.type !== 'job.log' || e.jobId !== jobId) return;
      setTail((prev) => ({
        step: e.step,
        lines: (prev.step === e.step ? prev.lines : []).concat(e.line).slice(-keep),
      }));
    });
  }, [jobId, keep]);
  return tail;
}
