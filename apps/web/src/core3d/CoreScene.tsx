import { Suspense } from 'react';
import type { CoreMode } from '@/store/ui';
import type { QualityTier } from '@/workspace/environment/quality';
import { CentreEffects, useEffectEngine } from './Effects';
import type { CoreMarks } from './effectModel';
import { CrystalCore } from './CrystalCore';
import { Dust } from './Dust';
import type { ProgressFx } from './progressFx';
import type { ProgressCardRef, ProgressModel } from './progressMapping';

/**
 * Overview's scene (Paper & Ink): the crystal core, the pickable card dust and the centre effects. `mode` picks the
 * core's view (Crystal, Ring, Shatter). The orbiting text ring is retired; `textRing` stays so callers are unchanged.
 */
export function CoreScene({
  model,
  marks,
  mode,
  animate,
  onDustPick,
  onDustHover,
  fx,
  dark,
  quality,
}: {
  fx: ProgressFx;
  model: ProgressModel | null;
  marks: CoreMarks;
  mode: CoreMode;
  textRing: boolean;
  animate: boolean;
  dark: boolean;
  quality: QualityTier;
  onDustPick: (card: ProgressCardRef) => void;
  onDustHover: (card: ProgressCardRef | null) => void;
}) {
  const running = useEffectEngine(animate);
  return (
    <>
      <Suspense fallback={null}>
        <CrystalCore
          view={mode}
          fx={fx}
          marks={marks}
          dark={dark}
          quality={quality}
          animate={animate}
        />
      </Suspense>
      <CentreEffects running={running} />
      {model && (
        <Dust cards={model.dust} animate={animate} onPick={onDustPick} onHover={onDustHover} />
      )}
    </>
  );
}
