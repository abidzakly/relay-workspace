import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  Vignette,
} from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { useMemo } from 'react';
import { Vector2 } from 'three';

/**
 * Lens and film: bloom catches the glass's brightest glints, a light vignette and a whisper of grain give it the feel
 * of a photograph; chromatic aberration only kicks in for the 98-100% finale.
 */
export function PostFx({ finale, dark }: { finale: number; dark: boolean }) {
  const offset = useMemo(
    () => new Vector2(0.0004 + finale * 0.0025, 0.0004 + finale * 0.0025),
    [finale],
  );
  return (
    <EffectComposer multisampling={4}>
      <Bloom
        mipmapBlur
        intensity={(dark ? 0.6 : 0.25) + finale * 1.4}
        luminanceThreshold={dark ? 0.7 : 0.92}
        luminanceSmoothing={0.2}
      />
      <ChromaticAberration offset={offset} radialModulation modulationOffset={0.4} />
      <Noise opacity={0.02} blendFunction={BlendFunction.OVERLAY} />
      <Vignette eskil={false} offset={0.3} darkness={dark ? 0.6 : 0.15} />
    </EffectComposer>
  );
}
