import { useEffect } from 'react';
import { getEventStream } from '@/lib/sse';
import { emit } from './engine';

/**
 * Shipping is the event, wherever the user is. A dry run earns nothing: its job says "Rehearsal finished" in place. The
 * stored claim on `jobId` keeps a resumed job, which emits `release.done` again, from playing it twice.
 */
export function useReleaseReward(): void {
  useEffect(
    () =>
      getEventStream().subscribe((e) => {
        if (e.type !== 'release.done' || e.dryRun) return;
        emit({
          level: 'event',
          key: `release:${e.jobId}`,
          persist: true,
          title: 'Release shipped',
          ...(e.version ? { detail: e.version } : {}),
        });
      }),
    [],
  );
}
