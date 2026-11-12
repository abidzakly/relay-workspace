import { useMemo, useRef } from 'react';
import type { CoreMode } from '@/store/ui';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { useCrystalAssets } from '@/workspace/crystal/assets';
import { Crystal } from '@/workspace/crystal/Crystal';
import type { QualityTier } from '@/workspace/environment/quality';
import type { CoreMarks } from './effectModel';
import { rand, type ProgressFx } from './progressFx';

const SHARDS = 9;

/**
 * Overview's core (Paper & Ink): one big generated crystal with the studio mark inside. Release progress gathers it:
 * below 90% its shards drift loose around it and close in as the cycle fills; from 90% they sit against the body.
 * It turns faster as progress rises. Each card mark (SLA risk, crack) is a small red or amber orb on a slow orbit.
 *
 * Three views (Overview, View settings): Crystal is the above; Ring lays the shards on one tilted orbit, an ink ring
 * through them, which tightens as the cycle fills; Shatter opens the core into its fracture pieces, a study of the
 * glass, with the shards flung wider. Shards glide between the views.
 */
export function CrystalCore({
  fx,
  marks,
  dark,
  quality,
  animate,
  view = 'S',
}: {
  view?: CoreMode;
  fx: ProgressFx;
  marks: CoreMarks;
  dark: boolean;
  quality: QualityTier;
  animate: boolean;
}) {
  const assets = useCrystalAssets();
  const shards = useRef<Group>(null);
  const orbs = useRef<Group>(null);
  const layout = useMemo(
    () =>
      Array.from({ length: SHARDS }, (_, i) => ({
        a: (i / SHARDS) * Math.PI * 2 + rand(i) * 0.4,
        y: (rand(i + 50) - 0.5) * 2.2,
        far: 3 + rand(i + 9) * 1.4,
        rock: i % 2 ? ('shard-a' as const) : ('shard-b' as const),
        size: 0.28 + rand(i + 31) * 0.22,
      })),
    [],
  );
  const markList = useMemo(
    () =>
      [...marks.cards, ...marks.loose].slice(0, 24).map((m, i) => ({
        kind: m.kind,
        a: (i / Math.max(1, marks.cards.length + marks.loose.length)) * Math.PI * 2,
      })),
    [marks],
  );

  const gather = fx.assembly;
  const ringR = 3.5 - gather * 1.1;
  /** Where each shard sits in the current view. */
  const target = (s: (typeof layout)[number], i: number): [number, number, number] => {
    if (view === 'A') {
      const a = (i / SHARDS) * Math.PI * 2;
      return [Math.cos(a) * ringR, 0, Math.sin(a) * ringR];
    }
    const r = view === 'B' ? s.far + 1.2 : s.far + (1.35 - s.far) * gather;
    const y = view === 'B' ? s.y * 1.3 : s.y * (1 - gather * 0.6);
    return [Math.cos(s.a) * r, y, Math.sin(s.a) * r];
  };
  const pieces = useRef<(Group | null)[]>([]);
  const ring = useRef<Group>(null);

  useFrame((_, dt) => {
    // Glide to the view's places, even when paused, so a switch never jumps.
    const k = animate ? 1 - Math.pow(0.02, dt) : 1;
    pieces.current.forEach((g, i) => {
      const s = layout[i];
      if (!g || !s) return;
      const [x, y, z] = target(s, i);
      g.position.x += (x - g.position.x) * k;
      g.position.y += (y - g.position.y) * k;
      g.position.z += (z - g.position.z) * k;
    });
    if (ring.current) {
      const goal = view === 'A' ? 0.36 : 0;
      ring.current.rotation.x += (goal - ring.current.rotation.x) * k;
    }
    if (!animate) return;
    if (shards.current) shards.current.rotation.y += dt * (0.08 + fx.spin * 0.25);
    if (orbs.current) orbs.current.rotation.y -= dt * 0.2;
  });

  return (
    <group>
      <Crystal
        assets={assets}
        rock="rock-core"
        emblem="core"
        scale={2.6}
        centre={0}
        quality={quality}
        dark={dark}
        animate={animate}
        seed={0.31}
        spin={0.4 + fx.spin}
        state={view === 'B' ? 'broken' : 'whole'}
        spread={0.32}
      />
      <group ref={ring}>
        {view === 'A' && (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[ringR, 0.006, 6, 200]} />
            <meshBasicMaterial
              color={dark ? '#ecebe6' : '#121212'}
              transparent
              opacity={0.35}
              toneMapped={false}
            />
          </mesh>
        )}
        <group ref={shards}>
          {layout.map((s, i) => {
            return (
              <group
                key={i}
                ref={(g) => {
                  pieces.current[i] = g;
                }}
                position={target(s, i)}
              >
                <Crystal
                  assets={assets}
                  rock={s.rock}
                  scale={s.size}
                  centre={0}
                  quality={quality}
                  dark={dark}
                  animate={animate}
                  seed={rand(i + 77)}
                  spin={1.5}
                />
              </group>
            );
          })}
        </group>
      </group>
      <group ref={orbs} rotation={[0.35, 0, -0.2]}>
        {markList.map((m, i) => (
          <mesh key={i} position={[Math.cos(m.a) * 2.6, 0, Math.sin(m.a) * 2.6]}>
            <sphereGeometry args={[0.07, 20, 14]} />
            <meshBasicMaterial
              color={m.kind === 'amber' ? '#e8b23a' : '#ff4a3d'}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
