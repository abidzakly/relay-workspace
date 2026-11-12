import { pieceBuilt, progressFx } from '@/core3d/progressFx';
import { shipStageFor, type ShipStage } from '@/core3d/shipStage';

/**
 * What the distant ship shows, derived from the same release progress and thresholds as CoreStage.
 * Pure, so tests pin the mapping: ring segments assemble one by one, window and engine lights come on for the finale,
 * and the complete ring sends one energy wave.
 */
export const RING_SEGMENTS = 16;

export interface ShipLook {
  stage: ShipStage;
  /** Per ring segment, 0 (missing) … 1 (in place). */
  segments: number[];
  /** Ring spin, radians per second (artificial gravity spinning up). */
  spin: number;
  /** 0..1 window light. */
  windows: number;
  /** 0..1 engine glow. */
  engines: number;
}

export function shipLook(percent: number | null | undefined): ShipLook {
  const stage = shipStageFor(percent);
  const fx = progressFx(percent);
  const known = stage !== 'unknown';
  return {
    stage,
    segments: Array.from({ length: RING_SEGMENTS }, (_, i) =>
      known ? pieceBuilt(i, RING_SEGMENTS, fx.assembly) : 0,
    ),
    spin: known ? 0.04 + fx.spin * 0.18 : 0.02,
    windows: !known
      ? 0.05
      : stage === 'complete' || stage === 'ignition'
        ? 1
        : stage === 'assembled'
          ? 0.55
          : 0.2,
    engines: !known ? 0 : stage === 'complete' ? 1 : stage === 'ignition' ? 0.85 : fx.p * 0.4,
  };
}
