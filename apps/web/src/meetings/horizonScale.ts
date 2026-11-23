import { DAY_MS, HOUR_MS, dayStart, monthDay, shortWeekday, weekStart } from './meetingView';

/**
 * The Horizon's time axis: now at the left edge, and time compressing as it goes. The next hours get most of the
 * width, days less, weeks the folded tail. Pure: time in, a fraction of the width (0..1) out.
 */

export type HorizonZoom = 'today' | 'week' | 'month';

interface Stop {
  /** Milliseconds after now. */
  t: number;
  /** Fraction of the width at `t`. */
  x: number;
  /** How the segment that ENDS here is drawn: straight, or log (the near part of it wider). */
  log: boolean;
}

const STOPS: Record<HorizonZoom, Stop[]> = {
  today: [
    { t: 0, x: 0, log: false },
    { t: 12 * HOUR_MS, x: 0.34, log: false },
    { t: 3 * DAY_MS, x: 0.6, log: true },
    { t: 31 * DAY_MS, x: 1, log: true },
  ],
  week: [
    { t: 0, x: 0, log: false },
    { t: DAY_MS, x: 0.14, log: false },
    { t: 7 * DAY_MS, x: 0.58, log: false },
    { t: 31 * DAY_MS, x: 1, log: true },
  ],
  month: [
    { t: 0, x: 0, log: false },
    { t: 31 * DAY_MS, x: 1, log: false },
  ],
};

/** The bend of a log segment: smaller = more of it near its start. */
const LOG_K = 6 * HOUR_MS;

function segment(a: Stop, b: Stop, t: number): number {
  const span = b.t - a.t;
  const p = b.log ? Math.log1p((t - a.t) / LOG_K) / Math.log1p(span / LOG_K) : (t - a.t) / span;
  return a.x + (b.x - a.x) * p;
}

export interface HorizonScale {
  now: number;
  end: number;
  /** Time (epoch ms) to a fraction of the width, clamped to 0..1. */
  x: (ms: number) => number;
}

/** The scale for `now`..`end`. Stops past the range are cut and the rest stretched so `end` lands on 1. */
export function horizonScale(now: number, end: number, zoom: HorizonZoom): HorizonScale {
  const range = Math.max(HOUR_MS, end - now);
  const raw = STOPS[zoom];
  const stops: Stop[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const s = raw[i]!;
    if (s.t < range) {
      stops.push(s);
      continue;
    }
    stops.push({ t: range, x: segment(raw[i - 1]!, s, range), log: s.log });
    break;
  }
  const last = stops[stops.length - 1]!;
  if (last.t < range) stops.push({ t: range, x: last.x, log: false });
  const scaleX = stops[stops.length - 1]!.x || 1;
  const norm = stops.map((s) => ({ ...s, x: s.x / scaleX }));
  return {
    now,
    end: now + range,
    x: (ms) => {
      const t = Math.min(range, Math.max(0, ms - now));
      for (let i = 1; i < norm.length; i++) {
        if (t <= norm[i]!.t) return segment(norm[i - 1]!, norm[i]!, t);
      }
      return 1;
    },
  };
}

export interface Tick {
  at: number;
  x: number;
  label: string;
  kind: 'hour' | 'day' | 'week';
}

/**
 * Ticks that fit: hours while they are far apart, then midnights, then Mondays. A tick closer than `minGapPx` to the
 * one before is dropped, a midnight beats an hour, and a Monday beats a midnight.
 */
export function horizonTicks(s: HorizonScale, widthPx: number, minGapPx = 64): Tick[] {
  const cands: Tick[] = [];
  for (let t = Math.ceil(s.now / (3 * HOUR_MS)) * 3 * HOUR_MS; t < s.end; t += 3 * HOUR_MS) {
    if (dayStart(t) === t) continue;
    const d = new Date(t);
    cands.push({
      at: t,
      x: s.x(t),
      label: `${String(d.getHours()).padStart(2, '0')}:00`,
      kind: 'hour',
    });
  }
  for (let t = dayStart(s.now) + DAY_MS; t < s.end; t = dayStart(t + DAY_MS + HOUR_MS)) {
    const monday = weekStart(t) === t;
    cands.push({
      at: t,
      x: s.x(t),
      label: monday ? monthDay(t) : `${shortWeekday(t)} ${new Date(t).getDate()}`,
      kind: monday ? 'week' : 'day',
    });
  }
  const rank = { week: 3, day: 2, hour: 1 } as const;
  cands.sort((a, b) => rank[b.kind] - rank[a.kind] || a.at - b.at);
  const kept: Tick[] = [];
  for (const c of cands) {
    if (c.x * widthPx < 40) continue; // leave room for the NOW label
    if (kept.every((k) => Math.abs(k.x - c.x) * widthPx >= minGapPx)) kept.push(c);
  }
  return kept.sort((a, b) => a.at - b.at);
}

/** Night spans (19:00 to 07:00) inside the range, as fractions, for the soft night bands. */
export function nightBands(s: HorizonScale): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let d = dayStart(s.now) - DAY_MS; d < s.end; d = dayStart(d + DAY_MS + HOUR_MS)) {
    const a = d + 19 * HOUR_MS;
    const b = d + DAY_MS + 7 * HOUR_MS;
    if (b <= s.now || a >= s.end) continue;
    out.push({ from: s.x(Math.max(a, s.now)), to: s.x(Math.min(b, s.end)) });
  }
  return out;
}

/** A folded Key label: just its diamond. */
export const COMPACT_W = 28;

/**
 * Label lanes so chips never overlap. Each chip hangs from its bead: to the right of it when there is room, else to
 * the left. It takes the lowest lane where either side is free. Labels that fit nowhere get `null` (shown on hover
 * only), except `force`d ones (Key), which take the side and lane that overlap least.
 */
export function assignLanes(
  items: { id: string; anchor: number; width: number; force: boolean }[],
  lanes: number,
  bounds: { min: number; max: number },
  gap = 8,
): Map<string, { lane: number; left: number; compact: boolean } | null> {
  const taken: { l: number; r: number }[][] = Array.from({ length: lanes }, () => []);
  const out = new Map<string, { lane: number; left: number; compact: boolean } | null>();
  const clamp = (l: number, w: number) => Math.min(bounds.max - w, Math.max(bounds.min, l));
  const overlap = (lane: number, l: number, w: number) =>
    taken[lane]!.reduce(
      (sum, t) => sum + Math.max(0, Math.min(t.r + gap, l + w) - Math.max(t.l - gap, l)),
      0,
    );
  const order = [...items].sort((a, b) => Number(b.force) - Number(a.force) || a.anchor - b.anchor);
  const place = (anchor: number, width: number) => {
    const sides = [clamp(anchor - 12, width), clamp(anchor - width + 12, width)];
    let best: { lane: number; left: number; cost: number } | null = null;
    for (let lane = 0; lane < lanes && (!best || best.cost > 0); lane++) {
      for (const left of sides) {
        const cost = overlap(lane, left, width);
        if (!best || cost < best.cost) best = { lane, left, cost };
        if (cost === 0) break;
      }
    }
    return best;
  };
  for (const it of order) {
    let best = place(it.anchor, it.width);
    let width = it.width;
    // A Key label with no room folds to its diamond (the name shows on hover), rather than covering another.
    if (best && best.cost > 0 && it.force) {
      const small = place(it.anchor, COMPACT_W);
      if (small && small.cost < best.cost) {
        best = small;
        width = COMPACT_W;
      }
    }
    if (!best || (best.cost > 0 && !it.force)) {
      out.set(it.id, null);
      continue;
    }
    taken[best.lane]!.push({ l: best.left, r: best.left + width });
    out.set(it.id, { lane: best.lane, left: best.left, compact: width === COMPACT_W });
  }
  return out;
}
