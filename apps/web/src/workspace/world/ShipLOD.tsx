import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DoubleSide, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import { isFreshRelease } from '@/core3d/effectModel';
import { getEventStream } from '@/lib/sse';
import type { V3 } from '../layout';
import { RING_SEGMENTS, shipLook } from './shipModel';

/**
 * The CoreStage ship as a persistent distant landmark: a simplified level of detail — the main ring
 * silhouette (assembling with release progress), a central module with a few window lights, spokes, and an engine
 * glow — never the full scene's cards, dust and cracks. It turns slowly; reaching 100% (or a finished release) sends
 * one energy wave. The detailed CoreStage takes over in Overview. Not fogged: it hangs above the weather.
 */
const R = 8.5;
const WAVE_S = 2.6;

function Mat({
  color,
  emissive = '#000000',
  glow = 0,
  opacity = 1,
}: {
  color: string;
  emissive?: string;
  glow?: number;
  opacity?: number;
}) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={emissive}
      emissiveIntensity={glow}
      flatShading
      roughness={0.6}
      metalness={0.3}
      fog={false}
      transparent={opacity < 1}
      opacity={opacity}
    />
  );
}

export function ShipLOD({
  at,
  rotY,
  progress,
  animate,
}: {
  at: V3;
  rotY: number;
  progress: number | null;
  animate: boolean;
}) {
  const look = useMemo(() => shipLook(progress), [progress]);
  const ring = useRef<Group>(null);
  const body = useRef<Group>(null);
  const wave = useRef<Mesh>(null);
  const waveT = useRef<number | null>(null);
  const invalidate = useThree((s) => s.invalidate);

  // The energy wave: when the ring completes while watching, and on a finished release (server event).
  const wasComplete = useRef(look.stage === 'complete');
  useEffect(() => {
    if (look.stage === 'complete' && !wasComplete.current && animate) {
      waveT.current = 0;
      invalidate();
    }
    wasComplete.current = look.stage === 'complete';
  }, [look.stage, animate, invalidate]);
  useEffect(() => {
    if (!animate) return;
    return getEventStream().subscribe((e) => {
      if (e.type !== 'release.done' || !isFreshRelease(e)) return;
      waveT.current = 0;
      invalidate();
    });
  }, [animate, invalidate]);

  useFrame(({ clock }, dt) => {
    const step = Math.min(dt, 0.1);
    if (ring.current && animate) ring.current.rotation.z += look.spin * step;
    if (body.current && animate) body.current.position.y = Math.sin(clock.elapsedTime * 0.25) * 0.6;
    const w = wave.current;
    if (!w) return;
    if (waveT.current === null) {
      w.visible = false;
      return;
    }
    waveT.current += step;
    const k = waveT.current / WAVE_S;
    if (k >= 1) {
      waveT.current = null;
      w.visible = false;
      invalidate();
      return;
    }
    w.visible = true;
    w.scale.setScalar(1 + k * 4);
    (w.material as MeshBasicMaterial).opacity = (1 - k) * 0.7;
    invalidate();
  });

  const known = look.stage !== 'unknown';
  const hull = known ? '#d9dee6' : '#8b929c';
  return (
    <group position={[...at]} rotation={[0.18, rotY, 0]}>
      <group ref={body}>
        {/* the ring: segments in place, missing ones as faint ghosts */}
        <group ref={ring}>
          {look.segments.map((b, i) => {
            const a = (i / RING_SEGMENTS) * Math.PI * 2;
            const built = b > 0.02;
            return (
              <mesh
                key={i}
                position={[Math.cos(a) * R, Math.sin(a) * R, 0]}
                rotation={[0, 0, a + Math.PI / 2]}
                scale={built ? [1, 0.6 + 0.4 * b, 0.6 + 0.4 * b] : [1, 0.5, 0.5]}
              >
                <boxGeometry args={[(2 * Math.PI * R) / RING_SEGMENTS - 0.15, 1.3, 1.6]} />
                <Mat color={built ? hull : '#5b6270'} opacity={built ? 1 : 0.22} />
              </mesh>
            );
          })}
          {/* window lights along the ring */}
          {look.segments.map((b, i) => {
            if (b < 1 || i % 2) return null;
            const a = (i / RING_SEGMENTS) * Math.PI * 2;
            return (
              <mesh key={`w${i}`} position={[Math.cos(a) * R, Math.sin(a) * R, 0.82]}>
                <boxGeometry args={[0.9, 0.3, 0.05]} />
                <Mat color="#fff4d0" emissive="#ffc861" glow={look.windows * 2.2} />
              </mesh>
            );
          })}
          {/* spokes */}
          {[0, 1, 2, 3].map((i) => (
            <mesh key={`s${i}`} rotation={[0, 0, (i * Math.PI) / 2]}>
              <boxGeometry args={[R * 2 - 1, 0.35, 0.35]} />
              <Mat color="#aab3c0" />
            </mesh>
          ))}
        </group>
        {/* the central module */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.8, 1.8, 3.2, 10]} />
          <Mat color={hull} />
        </mesh>
        <mesh position={[0, 0, 1.7]}>
          <icosahedronGeometry args={[1.2, 0]} />
          <Mat color="#c3cad5" emissive="#bfe6ff" glow={look.windows * 0.6} />
        </mesh>
        {/* the engine block and its glow, behind */}
        <mesh position={[0, 0, -2.2]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.1, 1.5, 1.4, 8]} />
          <Mat color="#8b929c" />
        </mesh>
        <mesh position={[0, 0, -3.1]}>
          <icosahedronGeometry args={[0.9, 1]} />
          <Mat color="#bfe6ff" emissive="#7fd0ff" glow={0.2 + look.engines * 3} />
        </mesh>
        {/* the energy wave of a completed release */}
        <mesh ref={wave} visible={false}>
          <ringGeometry args={[R + 0.6, R + 1.4, 64]} />
          <meshBasicMaterial
            color="#ffd27a"
            transparent
            opacity={0}
            side={DoubleSide}
            depthWrite={false}
            toneMapped={false}
            fog={false}
          />
        </mesh>
      </group>
    </group>
  );
}
