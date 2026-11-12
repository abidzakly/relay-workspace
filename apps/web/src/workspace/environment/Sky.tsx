import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Fog,
  type Mesh,
  type MeshBasicMaterial,
  type PointsMaterial,
  Vector3,
} from 'three';
import type { SkyPhase } from '@/lib/daypart';
import { PHASES, STUDIO } from '../scene/palette';
import { hash01 } from './placement';

/**
 * The outdoor sky: a gradient dome, the sun or moon on the phase's side, stars at night, and a horizon fog
 * in the sky's lower colour so distant hills fade into it. Eased between phases like the lights; free of textures and
 * HDR files (the CSP allows neither).
 */

const R = 420;
const ease = (dt: number) => 1 - Math.exp(-2.5 * dt);

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uBottom;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, -0.2, 1.0);
  float t = pow(smoothstep(-0.05, 0.6, h), 0.8);
  gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
}`;

function starGeometry(): BufferGeometry {
  const n = 420;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const az = hash01(i * 3 + 1) * Math.PI * 2;
    const el = Math.asin(0.08 + hash01(i * 3 + 2) * 0.9);
    const r = R * 0.95;
    pos[i * 3] = Math.cos(el) * Math.cos(az) * r;
    pos[i * 3 + 1] = Math.sin(el) * r;
    pos[i * 3 + 2] = Math.cos(el) * Math.sin(az) * r;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  return g;
}

const STAR_ALPHA: Record<SkyPhase, number> = { night: 0.95, dusk: 0.25, dawn: 0.1, day: 0 };

export function Sky({
  phase,
  fog = [45, 260],
}: {
  phase: SkyPhase;
  fog?: readonly [number, number];
}) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const dome = useRef<Mesh>(null);
  const sun = useRef<Mesh>(null);
  const stars = useRef<PointsMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTop: { value: new Color(PHASES[phase].skyTop) },
      uBottom: { value: new Color(PHASES[phase].skyBottom) },
    }),
    // Created once; eased afterwards.
    [],
  );
  const goal = useMemo(() => {
    const p = PHASES[phase];
    const night = phase === 'night';
    return {
      top: new Color(p.skyTop),
      bottom: new Color(p.skyBottom),
      sunDir: new Vector3(...p.sunPos).normalize(),
      sunColor: new Color(night ? STUDIO.oat : p.sun),
      sunSize: night ? 7 : 11,
      stars: STAR_ALPHA[phase],
    };
  }, [phase]);
  const starsGeo = useMemo(starGeometry, []);
  useEffect(() => () => starsGeo.dispose(), [starsGeo]);

  // Horizon fog in the sky's own colour; removed when the sky unmounts.
  useEffect(() => {
    const f = new Fog(goal.bottom.clone(), fog[0], fog[1]);
    scene.fog = f;
    return () => {
      if (scene.fog === f) scene.fog = null;
    };
  }, [scene, fog[0], fog[1]]);

  useFrame((_, dt) => {
    const k = ease(dt);
    uniforms.uTop.value.lerp(goal.top, k);
    uniforms.uBottom.value.lerp(goal.bottom, k);
    if (scene.fog instanceof Fog) scene.fog.color.lerp(goal.bottom, k);
    // The dome travels with the camera, so it is always "infinitely" far.
    dome.current?.position.copy(camera.position);
    const s = sun.current;
    if (s) {
      s.position
        .copy(goal.sunDir)
        .multiplyScalar(R * 0.9)
        .add(camera.position);
      (s.material as MeshBasicMaterial).color.lerp(goal.sunColor, k);
      s.scale.setScalar(goal.sunSize);
    }
    if (stars.current) stars.current.opacity += (goal.stars - stars.current.opacity) * k;
  });

  return (
    <group>
      <mesh ref={dome} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[R, 32, 16]} />
        <shaderMaterial
          vertexShader={SKY_VERT}
          fragmentShader={SKY_FRAG}
          uniforms={uniforms}
          side={BackSide}
          depthWrite={false}
          fog={false}
        />
      </mesh>
      <points geometry={starsGeo} frustumCulled={false} renderOrder={-9}>
        <pointsMaterial
          ref={stars}
          size={1.6}
          sizeAttenuation={false}
          color="#ffffff"
          transparent
          opacity={STAR_ALPHA[phase]}
          depthWrite={false}
          fog={false}
          blending={AdditiveBlending}
        />
      </points>
      <mesh ref={sun} renderOrder={-8} frustumCulled={false}>
        <circleGeometry args={[1, 24]} />
        <meshBasicMaterial
          color={goal.sunColor}
          fog={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <SunFacer target={sun} />
    </group>
  );
}

/** Keeps the sun disc turned towards the camera. */
function SunFacer({ target }: { target: React.RefObject<Mesh | null> }) {
  const camera = useThree((s) => s.camera);
  useFrame(() => target.current?.lookAt(camera.position));
  return null;
}
