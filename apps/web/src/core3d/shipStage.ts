import { ASSEMBLED_AT, FINALE_FROM, progressFx } from './progressFx';

/**
 * The ship's visible stage at any distance, read from the same release progress and the
 * same thresholds as CoreStage (`progressFx`): no second, approximate progress system. Pure.
 *
 *  - `unknown`: nothing to count yet (no cards, settings loading).
 *  - `low` / `medium` / `high`: the ring assembles (high = from 2/3 of the way to fully assembled).
 *  - `assembled`: every piece in place (from 90%), stronger lighting.
 *  - `ignition`: 98–99%, engines and window lights on.
 *  - `complete`: 100%, the complete ring and its energy wave.
 */
export type ShipStage =
  'unknown' | 'low' | 'medium' | 'high' | 'assembled' | 'ignition' | 'complete';

export function shipStageFor(percent: number | null | undefined): ShipStage {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return 'unknown';
  const fx = progressFx(percent);
  if (fx.complete) return 'complete';
  if (percent >= FINALE_FROM) return 'ignition';
  if (percent >= ASSEMBLED_AT) return 'assembled';
  if (fx.assembly >= 2 / 3) return 'high';
  if (fx.assembly >= 1 / 3) return 'medium';
  return 'low';
}

/**
 * The growth step (0..4) a living Overview object shows: the bonsai's leaves, a reactor's charge, a lighthouse's
 * brightness. Full at 90% (the ship is assembled then too); the flourish at 100% is `complete`.
 */
export function growthStep(percent: number | null | undefined): number {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return 0;
  return Math.min(4, Math.floor(progressFx(percent).assembly * 4));
}
