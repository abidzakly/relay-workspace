import { useCoarsePointer, useNarrow } from '../useMedia';

/**
 * How much scenery a device draws: desktop gets the full world, a tablet less
 * geometry, a phone the essentials (and SceneMenu stays prominent there). Functional objects are never dropped.
 */
export type QualityTier = 'high' | 'medium' | 'low';

export function qualityTier(
  narrow: boolean,
  coarse: boolean,
  cores: number | undefined,
): QualityTier {
  if (narrow) return 'low';
  if (coarse || (cores !== undefined && cores <= 4)) return 'medium';
  return 'high';
}

const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

/** The lower of what the device should manage and what it has shown it can. */
export function capTier(device: QualityTier, cap: QualityTier): QualityTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(device), TIER_ORDER.indexOf(cap))]!;
}

/** One step down from a tier. `low` is the floor. */
export function nextCap(tier: QualityTier): QualityTier {
  return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(tier) - 1)]!;
}

/** Scales a count of decorative things (trees, tufts, particles) by tier. */
export const DENSITY: Record<QualityTier, number> = { high: 1, medium: 0.6, low: 0.3 };

export function useQualityTier(): QualityTier {
  const narrow = useNarrow();
  const coarse = useCoarsePointer();
  const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
  return qualityTier(narrow, coarse, cores);
}
