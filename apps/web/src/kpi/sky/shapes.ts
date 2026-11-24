import type { BodyKey, SkyBody } from './model';

/** A constellation: its stars in a unit box (0..1), traced in order. */
export interface Shape {
  name: string;
  stars: readonly (readonly [number, number])[];
  /** Extra lines that close a figure, by star index. */
  close?: readonly (readonly [number, number])[];
}

/** Task completion: the cut gem of the Release trigger, traced from its tip around the crown. */
const GEM: Shape = {
  name: 'The Gem',
  stars: [
    [0.5, 0.98],
    [0.12, 0.42],
    [0.26, 0.2],
    [0.42, 0.08],
    [0.58, 0.08],
    [0.74, 0.2],
    [0.88, 0.42],
    [0.66, 0.58],
    [0.34, 0.58],
  ],
  close: [
    [6, 0],
    [1, 8],
  ],
};

/** The SLA hit-rate: the Arrow, flying up and to the right, on time. */
const ARROW: Shape = {
  name: 'The Arrow',
  stars: [
    [0.08, 0.94],
    [0.2, 0.8],
    [0.33, 0.66],
    [0.46, 0.52],
    [0.58, 0.39],
    [0.7, 0.27],
    [0.86, 0.1],
    [0.6, 0.12],
    [0.84, 0.36],
  ],
  close: [[6, 8]],
};

/** The bug ratio: the Lantern. Its ring is the limit, its cloud is the ratio. */
const LANTERN: Shape = {
  name: 'The Lantern',
  stars: [
    [0.5, 0.04],
    [0.5, 0.2],
    [0.28, 0.34],
    [0.2, 0.6],
    [0.32, 0.84],
    [0.68, 0.84],
    [0.8, 0.6],
    [0.72, 0.34],
  ],
  close: [[7, 1]],
};

/** The research quota: the Crown, one star per paper the month owes (at least five, so a quota of one still reads). */
function crown(n: number): Shape {
  const k = Math.max(5, Math.min(10, n));
  const stars = Array.from({ length: k }, (_, i) => {
    const a = Math.PI * (1 - i / (k - 1));
    const peak = i % 2 === 0 ? 0 : 0.12;
    return [0.5 + Math.cos(a) * 0.44, 0.78 - Math.sin(a) * 0.5 - peak] as const;
  });
  return { name: 'The Crown', stars };
}

export function shapeOf(key: BodyKey, researchRequired: number): Shape {
  if (key === 'completion') return GEM;
  if (key === 'sla') return ARROW;
  if (key === 'bug') return LANTERN;
  return crown(researchRequired);
}

/** How many of a shape's stars are lit, and which one wears the target's halo. */
export function litOf(body: SkyBody, n: number): { lit: number; targetStar: number | null } {
  if (body.inverse) return { lit: n, targetStar: null };
  const lit = body.fraction === null ? 0 : Math.round(body.fraction * n);
  const targetStar =
    body.target === null || body.key === 'research'
      ? null
      : Math.max(0, Math.min(n - 1, Math.ceil(body.target * n) - 1));
  return { lit, targetStar };
}
