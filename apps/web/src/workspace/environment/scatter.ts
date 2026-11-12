import { hash01 } from './placement';

/** A scattered thing: where it stands, how big, and a 0..1 variation (colour, shape). */
export interface Scattered {
  x: number;
  y: number;
  z: number;
  scale: number;
  turn: number;
  variant: number;
}

/**
 * Deterministic scattering in a ring around a centre (trees, rocks, tufts): the same seed always gives the same
 * world, so nothing jumps between renders or sessions. Points for which `keep` is false are skipped (paths, the
 * yard, water, objects), up to a bounded number of tries.
 */
export function scatter(opts: {
  count: number;
  seed: number;
  rMin: number;
  rMax: number;
  center?: readonly [number, number];
  scale?: readonly [number, number];
  ground: (x: number, z: number) => number;
  keep?: (x: number, z: number) => boolean;
}): Scattered[] {
  const [cx, cz] = opts.center ?? [0, 0];
  const [s0, s1] = opts.scale ?? [0.8, 1.3];
  const out: Scattered[] = [];
  for (let i = 0; out.length < opts.count && i < opts.count * 8; i++) {
    const a = hash01(opts.seed + i * 4.1) * Math.PI * 2;
    // sqrt: even density over the ring's area.
    const r = Math.sqrt(
      opts.rMin ** 2 + hash01(opts.seed + i * 7.3 + 1) * (opts.rMax ** 2 - opts.rMin ** 2),
    );
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    if (opts.keep && !opts.keep(x, z)) continue;
    const v = hash01(opts.seed + i * 13.7 + 2);
    out.push({
      x,
      z,
      y: opts.ground(x, z),
      scale: s0 + (s1 - s0) * hash01(opts.seed + i * 3.3 + 3),
      turn: v * Math.PI * 2,
      variant: v,
    });
  }
  return out;
}
