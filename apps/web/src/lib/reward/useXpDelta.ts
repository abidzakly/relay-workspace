import { useEffect, useRef, useState } from 'react';
import { BADGES } from '@/overview/badges';
import { useGamification } from '@/lib/gamificationApi';
import { emit } from './engine';
import { baselineOf, diffReports, readBaseline, writeBaseline, type XpDelta } from './xpDelta';

/**
 * Turns server reports into rewards. What was gained while the app was closed comes back as `away`, for a quiet recap
 * with no effects. What is gained while watching is emitted. The first report ever only sets the baseline.
 */
export function useXpDelta(): { away: XpDelta | null; dismissAway: () => void } {
  const report = useGamification().data;
  const [away, setAway] = useState<XpDelta | null>(null);
  const firstReport = useRef(true);

  useEffect(() => {
    if (!report) return;
    const isFirst = firstReport.current;
    firstReport.current = false;
    const prev = readBaseline();
    writeBaseline(baselineOf(report));
    if (!prev) return;
    const delta = diffReports(prev, report);
    if (!delta) return;
    if (isFirst) {
      setAway(delta);
      return;
    }
    if (delta.xp > 0) {
      emit({ level: 'pop', key: `xp:${report.xp}`, xp: delta.xp, title: `+${delta.xp} XP` });
    }
    if (delta.level !== null) {
      emit({ level: 'burst', key: `level:${delta.level}`, title: `Level ${delta.level}` });
    }
    for (const badge of delta.badges) {
      emit({
        level: 'burst',
        key: `badge:${badge.id}:${badge.count}`,
        title: BADGES[badge.id].name,
        detail: BADGES[badge.id].rule,
      });
    }
  }, [report]);

  return { away, dismissAway: () => setAway(null) };
}
