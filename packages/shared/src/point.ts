/**
 * Notion `Point` → estimated effort. 1=1h, 2=2h, 3=4h, 4=8h (1 day), 5=16h (2 days), 6=Research (open-ended).
 */
export type Effort = { kind: 'hours'; hours: number } | { kind: 'research' };

const HOURS: Record<number, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };

export function pointEffort(point: number | null | undefined): Effort | null {
  if (point === null || point === undefined || !Number.isFinite(point)) return null;
  const p = Math.round(point);
  if (p === 6) return { kind: 'research' };
  const h = HOURS[p];
  return h === undefined ? null : { kind: 'hours', hours: h };
}

/** Hours of a point, 0 for research/unknown. */
export function pointHours(point: number | null | undefined): number {
  const e = pointEffort(point);
  return e?.kind === 'hours' ? e.hours : 0;
}

export function formatHours(h: number): string {
  if (h >= 8 && h % 8 === 0) return `${h / 8}d`;
  return `${Math.round(h * 10) / 10}h`;
}

/** "3pt · 4h", "6pt · Research", null when no point. */
export function formatEffort(point: number | null | undefined): string | null {
  const e = pointEffort(point);
  if (!e) return null;
  const p = Math.round(point!);
  return e.kind === 'research' ? `${p}pt · Research` : `${p}pt · ${formatHours(e.hours)}`;
}

export interface EffortSum {
  hours: number;
  research: number;
  unestimated: number;
}

export function sumEffort(points: readonly (number | null | undefined)[]): EffortSum {
  const out: EffortSum = { hours: 0, research: 0, unestimated: 0 };
  for (const p of points) {
    const e = pointEffort(p);
    if (!e) out.unestimated += 1;
    else if (e.kind === 'research') out.research += 1;
    else out.hours += e.hours;
  }
  return out;
}
