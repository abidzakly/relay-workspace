/**
 * Progress → how the scene behaves (Improvement 4). Pure.
 *  - below 100% the structure is broken and assembles as progress rises; at 90% it is complete
 *  - spin speeds up with progress (artificial gravity spinning up)
 *  - 98-100% plays the finale
 */
export interface ProgressFx {
  /** 0..1, the fraction of the structure in place (1 from 90% on). */
  assembly: number;
  /** 0..1, progress itself. */
  p: number;
  /** Spin multiplier: barely turning when empty, full speed when done. */
  spin: number;
  /** 0 below 98%, rising to 1 at 100%. */
  finale: number;
  /** Exactly done. */
  complete: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const ASSEMBLED_AT = 90;
export const FINALE_FROM = 98;

export function progressFx(percent: number | null | undefined): ProgressFx {
  const pc = percent ?? 0;
  const p = clamp01(pc / 100);
  return {
    assembly: clamp01(pc / ASSEMBLED_AT),
    p,
    spin: 0.12 + 0.88 * p * p,
    finale: clamp01((pc - FINALE_FROM) / (100 - FINALE_FROM)),
    complete: pc >= 100,
  };
}

/** Piece `i` of `n` is in place once assembly passes its slot (pieces arrive one by one, in order). */
export function pieceBuilt(i: number, n: number, assembly: number): number {
  // A short ramp per piece, so it snaps in rather than popping.
  const start = i / n;
  const end = (i + 1) / n;
  return clamp01((assembly - start) / (end - start));
}

/** Deterministic pseudo-random in [0,1) per integer seed (layout of debris must not jump between renders). */
export function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Dev/demo override: `?coreProgress=95` shows the scene at 95% (does not touch any data). */
export function progressOverride(): number | null {
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('coreProgress');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}
