import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  TorusGeometry,
  type Group,
  type Mesh,
} from 'three';
import { pieceBuilt, rand, type ProgressFx } from './progressFx';

/**
 * Ship mode (Improvement 4): an Endurance-style ring station that spins for artificial gravity. The work builds it:
 * below 90% its pieces drift broken and tumbling, each one docking as progress rises; spin (gravity) grows with
 * progress; from 98% the engines light, the windows chase, and at 100% a shock ring rolls out.
 */

const N = 12;
const R = 2.55;
const SPOKES = 4;
/** Build order: spokes first (the skeleton), then each module followed by the truss to its neighbour. */
const PIECES = SPOKES + N * 2;

const GEO = {
  module: new BoxGeometry(0.62, 1.05, 0.62),
  window: new BoxGeometry(0.05, 0.8, 0.16),
  truss: new CylinderGeometry(0.05, 0.05, 1, 8),
  spoke: new CylinderGeometry(0.06, 0.06, R - 0.45, 10),
  hub: new CylinderGeometry(0.42, 0.42, 0.9, 32),
  hubRing: new TorusGeometry(0.5, 0.06, 12, 48),
  spine: new CylinderGeometry(0.12, 0.12, 4.2, 16),
  engine: new CylinderGeometry(0.22, 0.3, 0.5, 20),
  flame: new ConeGeometry(0.26, 1.4, 20, 1, true),
  shock: new TorusGeometry(1, 0.03, 8, 96),
};

const hull = new MeshPhysicalMaterial({
  color: 0xd8cbb8,
  metalness: 0.75,
  roughness: 0.32,
  clearcoat: 0.6,
  clearcoatRoughness: 0.25,
});
const darkMetal = new MeshPhysicalMaterial({ color: 0x3d302a, metalness: 0.9, roughness: 0.4 });
const flameMat = new MeshBasicMaterial({
  color: 0xf7b500,
  transparent: true,
  opacity: 0,
  blending: AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
const shockMat = new MeshBasicMaterial({
  color: 0xf5ebdc,
  transparent: true,
  opacity: 0,
  blending: AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});

const WARM = new Color(0xffc477);
const BROKEN = new Color(0xff5a2a);
const CRACK = new Color(0xff2040);
const FINALE = new Color(0xffe6a8);

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

interface Piece {
  /** Home transform. */
  pos: [number, number, number];
  rot: [number, number, number];
  /** Where it drifts while broken. */
  debris: [number, number, number];
  tumble: [number, number, number];
}

function homePieces(): Piece[] {
  const out: Piece[] = [];
  const debrisOf = (i: number, base: [number, number, number]): [number, number, number] => {
    const k = 1.6 + rand(i) * 2.4;
    const len = Math.hypot(base[0], base[1]) || 1;
    return [
      base[0] + (base[0] / len) * k + (rand(i + 5) - 0.5) * 1.5,
      base[1] + (base[1] / len) * k + (rand(i + 6) - 0.5) * 1.5,
      (rand(i + 7) - 0.5) * 3.5,
    ];
  };
  const tumble = (i: number): [number, number, number] => [
    (rand(i + 11) - 0.5) * 1.6,
    (rand(i + 12) - 0.5) * 1.6,
    (rand(i + 13) - 0.5) * 1.6,
  ];
  for (let s = 0; s < SPOKES; s++) {
    const a = (s / SPOKES) * Math.PI * 2 + Math.PI / N;
    const mid = (R + 0.45) / 2;
    const pos: [number, number, number] = [Math.cos(a) * mid, Math.sin(a) * mid, 0];
    out.push({
      pos,
      rot: [0, 0, a - Math.PI / 2],
      debris: debrisOf(s * 31, pos),
      tumble: tumble(s * 31),
    });
  }
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const pos: [number, number, number] = [Math.cos(a) * R, Math.sin(a) * R, 0];
    out.push({ pos, rot: [0, 0, a], debris: debrisOf(100 + i, pos), tumble: tumble(100 + i) });
    const b = a + Math.PI / N;
    const tr = R * Math.cos(Math.PI / N);
    const tpos: [number, number, number] = [Math.cos(b) * tr, Math.sin(b) * tr, 0];
    out.push({
      pos: tpos,
      rot: [0, 0, b],
      debris: debrisOf(200 + i, tpos),
      tumble: tumble(200 + i),
    });
  }
  return out;
}

export function ShipMode({
  fx,
  animate,
  cracks,
}: {
  fx: ProgressFx;
  animate: boolean;
  /** Issues cards: that many modules flicker red. */
  cracks: number;
}) {
  const pieces = useMemo(homePieces, []);
  const refs = useRef<(Group | null)[]>([]);
  const shown = useRef<number[]>(pieces.map(() => 0));
  const spinner = useRef<Group>(null);
  const shock = useRef<Mesh>(null);
  const time = useRef(0);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const windows = useMemo(
    () =>
      Array.from(
        { length: N },
        () =>
          new MeshPhysicalMaterial({
            color: 0x111111,
            emissive: WARM.clone(),
            emissiveIntensity: 0,
            toneMapped: false,
          }),
      ),
    [],
  );
  const trussLen = 2 * R * Math.sin(Math.PI / N) - 0.6;

  useEffect(() => {
    const z0 = camera.position.z;
    return () => {
      camera.position.z = z0;
      for (const m of windows) m.dispose();
    };
  }, [camera, windows]);

  // Static pose (reduced motion / paused): everything sits where progress puts it, no tumbling.
  useEffect(() => {
    if (animate) return;
    pieces.forEach((p, i) => {
      const g = refs.current[i];
      const b = pieceBuilt(i, PIECES, fx.assembly);
      shown.current[i] = b;
      if (!g) return;
      const e = ease(b);
      g.position.set(
        p.debris[0] + (p.pos[0] - p.debris[0]) * e,
        p.debris[1] + (p.pos[1] - p.debris[1]) * e,
        p.debris[2] + (p.pos[2] - p.debris[2]) * e,
      );
      g.rotation.set(
        p.rot[0] + p.tumble[0] * (1 - e),
        p.rot[1] + p.tumble[1] * (1 - e),
        p.rot[2] + p.tumble[2] * (1 - e),
      );
    });
    windows.forEach((m, i) => {
      const built = pieceBuilt(SPOKES + i * 2, PIECES, fx.assembly) >= 1;
      m.emissive.copy(fx.finale > 0 ? FINALE : WARM);
      m.emissiveIntensity = built ? 1.2 + fx.finale * 2 : 0.05;
    });
    flameMat.opacity = fx.finale * 0.9;
    invalidate();
  }, [animate, fx, pieces, windows, invalidate]);

  useFrame((_, delta) => {
    if (!animate) return;
    const dt = Math.min(delta, 0.1);
    time.current += dt;
    const t = time.current;

    if (spinner.current) spinner.current.rotation.z += dt * 0.7 * fx.spin;

    pieces.forEach((p, i) => {
      const target = pieceBuilt(i, PIECES, fx.assembly);
      const cur = shown.current[i]!;
      // Docking is a little slower than undocking looks, so a rise in progress is something to watch.
      const next = cur + (target - cur) * Math.min(1, dt * 1.2);
      shown.current[i] = next;
      const g = refs.current[i];
      if (!g) return;
      const e = ease(next);
      const drift = (1 - e) * 0.25;
      g.position.set(
        p.debris[0] + (p.pos[0] - p.debris[0]) * e + Math.sin(t * 0.3 + i) * drift,
        p.debris[1] + (p.pos[1] - p.debris[1]) * e + Math.cos(t * 0.27 + i) * drift,
        p.debris[2] + (p.pos[2] - p.debris[2]) * e,
      );
      const spin = (1 - e) * t;
      g.rotation.set(
        p.rot[0] + p.tumble[0] * spin,
        p.rot[1] + p.tumble[1] * spin,
        p.rot[2] + p.tumble[2] * spin,
      );
    });

    windows.forEach((m, i) => {
      const b = shown.current[SPOKES + i * 2]!;
      const built = b > 0.98;
      const cracked = built && cracks > 0 && i >= N - Math.min(cracks, N);
      if (!built) {
        // broken: sparking, failing power
        m.emissive.copy(BROKEN);
        m.emissiveIntensity = rand(Math.floor(t * 14) + i * 7) > 0.82 ? 3 : 0.05;
      } else if (cracked) {
        m.emissive.copy(CRACK);
        m.emissiveIntensity = 0.6 + Math.abs(Math.sin(t * 6 + i)) * 1.8;
      } else if (fx.finale > 0) {
        // running lights chase round the ring
        const chase = Math.max(0, Math.cos(t * 3 - (i / N) * Math.PI * 2));
        m.emissive.copy(WARM).lerp(FINALE, fx.finale);
        m.emissiveIntensity = 1.2 + fx.finale * (1 + chase * 4);
      } else {
        m.emissive.copy(WARM);
        m.emissiveIntensity = 0.9 + fx.p * 0.8 + Math.sin(t * 0.8 + i) * 0.08;
      }
    });

    flameMat.opacity = fx.finale * (0.65 + Math.sin(t * 40) * 0.12 + Math.sin(t * 23) * 0.1);

    if (shock.current) {
      if (fx.complete) {
        const cycle = (t % 3.2) / 3.2;
        shock.current.scale.setScalar(0.5 + cycle * 7);
        shockMat.opacity = (1 - cycle) * 0.8;
      } else {
        shockMat.opacity = 0;
      }
    }

    // a slow dolly in for the finale
    const wantZ = 9 - fx.finale * 1.6;
    camera.position.z += (wantZ - camera.position.z) * Math.min(1, dt * 0.8);
  });

  return (
    <group rotation={[0.62, -0.42, 0.1]}>
      {/* spine and engines stay still while the ring turns */}
      <mesh
        geometry={GEO.spine}
        material={darkMetal}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, 0, -1.2]}
      />
      {[-1, 1].map((s) => (
        <group key={s} position={[s * 0.32, 0, -3.3]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh geometry={GEO.engine} material={darkMetal} />
          <mesh
            geometry={GEO.flame}
            material={flameMat}
            position={[0, -0.95, 0]}
            rotation={[Math.PI, 0, 0]}
          />
        </group>
      ))}
      <group ref={spinner}>
        <mesh geometry={GEO.hub} material={hull} rotation={[Math.PI / 2, 0, 0]} />
        <mesh geometry={GEO.hubRing} material={darkMetal} />
        {pieces.map((p, i) => {
          const isSpoke = i < SPOKES;
          const isModule = !isSpoke && (i - SPOKES) % 2 === 0;
          const m = Math.floor((i - SPOKES) / 2);
          return (
            <group
              key={i}
              ref={(g) => void (refs.current[i] = g)}
              position={p.debris}
              rotation={p.rot}
            >
              {isSpoke && <mesh geometry={GEO.spoke} material={darkMetal} />}
              {isModule && (
                <>
                  <mesh geometry={GEO.module} material={hull} castShadow receiveShadow />
                  <mesh geometry={GEO.window} material={windows[m]} position={[0.32, 0, 0]} />
                  <mesh
                    geometry={GEO.window}
                    material={windows[m]}
                    position={[0, 0, 0.32]}
                    rotation={[0, Math.PI / 2, 0]}
                  />
                </>
              )}
              {!isSpoke && !isModule && (
                <mesh geometry={GEO.truss} material={darkMetal} scale={[1, trussLen, 1]} />
              )}
            </group>
          );
        })}
      </group>
      <mesh ref={shock} geometry={GEO.shock} material={shockMat} />
    </group>
  );
}
