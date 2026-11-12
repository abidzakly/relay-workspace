import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  MathUtils,
  Vector3,
  type AmbientLight,
  type DirectionalLight,
  type HemisphereLight,
} from 'three';
import type { SkyPhase } from '@/lib/daypart';
import type { EnvId } from '../envFor';
import { PALETTES, PHASES, STUDIO } from '../scene/palette';

/** Daylight from the world's open sky, eased between phases and environments; lamps take over in the evening. */
export function Lights({
  env,
  phase,
  shadows,
  scale = 4,
  bounds = 24,
}: {
  env: EnvId;
  phase: SkyPhase;
  shadows: boolean;
  /** How far the sun stands (its phase direction is scaled by this). */
  scale?: number;
  /** Half-size of the area that receives sharp shadows. */
  bounds?: number;
}) {
  const sun = useRef<DirectionalLight>(null);
  const amb = useRef<AmbientLight>(null);
  const hemi = useRef<HemisphereLight>(null);
  const goal = useMemo(() => {
    const p = PHASES[phase];
    const pal = PALETTES[env];
    return {
      sun: new Color(p.sun),
      sunI: p.sunIntensity * pal.daylight,
      sunPos: new Vector3(...p.sunPos).multiplyScalar(scale),
      amb: new Color(p.ambient),
      ambI: p.ambientIntensity * (0.6 + pal.daylight * 0.4),
      sky: new Color(p.skyTop),
      ground: new Color(pal.ground),
    };
  }, [env, phase, scale]);
  useFrame((_, dt) => {
    const k = 1 - Math.exp(-2.5 * dt);
    if (sun.current) {
      sun.current.color.lerp(goal.sun, k);
      sun.current.intensity = MathUtils.lerp(sun.current.intensity, goal.sunI, k);
      sun.current.position.lerp(goal.sunPos, k);
    }
    if (amb.current) {
      amb.current.color.lerp(goal.amb, k);
      amb.current.intensity = MathUtils.lerp(amb.current.intensity, goal.ambI * 0.55, k);
    }
    if (hemi.current) {
      hemi.current.color.lerp(goal.sky, k);
      hemi.current.groundColor.lerp(goal.ground, k);
    }
  });
  return (
    <>
      <ambientLight ref={amb} intensity={0.5} />
      <hemisphereLight ref={hemi} args={[STUDIO.oat, '#8a6a50', 0.55]} />
      <directionalLight
        ref={sun}
        position={[-6, 7, 3]}
        intensity={2}
        castShadow={shadows}
        shadow-mapSize={bounds > 5 ? [2048, 2048] : [1024, 1024]}
        shadow-camera-left={-bounds}
        shadow-camera-right={bounds}
        shadow-camera-top={bounds}
        shadow-camera-bottom={-bounds}
        shadow-camera-near={1}
        shadow-camera-far={20 * scale + bounds * 2}
        shadow-bias={-0.0008}
        shadow-normalBias={0.02}
      />
      {/* a soft fill from the open side of the diorama, so the far corner never goes black */}
      <directionalLight position={[5, 4, 6]} intensity={0.45} color={STUDIO.oat} />
    </>
  );
}
