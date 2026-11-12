import type { GaugeTone } from '@/kpi/model';

/**
 * Overview 2.0 status system: one meaning in Classic and in the Living Workspace. Colour is never the
 * only signal; every state has a label. `info` is work in progress, never success; `nodata` is never zero.
 */
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'nodata';

export const TONE: Record<
  Tone,
  {
    label: string;
    badge: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';
    /** A small dot or bar next to the label. */
    dot: string;
    /** Left accent of a card or row. */
    accent: string;
  }
> = {
  good: { label: 'OK', badge: 'success', dot: 'bg-success', accent: 'border-l-success' },
  warn: {
    label: 'Needs attention',
    badge: 'warning',
    dot: 'bg-warning',
    accent: 'border-l-warning',
  },
  bad: {
    label: 'Critical',
    badge: 'destructive',
    dot: 'bg-destructive',
    accent: 'border-l-destructive',
  },
  info: { label: 'In progress', badge: 'secondary', dot: 'bg-primary', accent: 'border-l-primary' },
  nodata: {
    label: 'No data',
    badge: 'outline',
    dot: 'bg-muted-foreground/40',
    accent: 'border-l-border',
  },
};

/** The KPI gauges' tones, in the shared vocabulary. A gauge with no value is `nodata`, whatever its tone says. */
export function toneOfGauge(tone: GaugeTone, hasValue: boolean): Tone {
  if (!hasValue) return 'nodata';
  return tone === 'good'
    ? 'good'
    : tone === 'warning'
      ? 'warn'
      : tone === 'critical'
        ? 'bad'
        : 'info';
}

/** Off duty (Sick / Leave) the Overview stays calm: urgency drops to a quiet warning, nothing is hidden. */
export function calmTone(tone: Tone, offDuty: boolean): Tone {
  return offDuty && tone === 'bad' ? 'warn' : tone;
}
