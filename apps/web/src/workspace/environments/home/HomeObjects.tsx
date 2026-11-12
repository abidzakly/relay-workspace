import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  MathUtils,
  type Group,
  type Mesh,
  type PointLight,
} from 'three';
import { growthStep, shipStageFor } from '@/core3d/shipStage';
import { archeryTexture, noticeTexture } from '../../environment/worldTextures';
import type { RepresentationProps, RepresentationSet } from '../../objects/representations';
import { useCanvasTexture } from '../../scene/Interactive';
import { Led } from '../../scene/DeskSet';
import { TONE_COLOR } from '../../scene/palette';
import { Ball, Box, Cone, Cyl, Panel } from '../../scene/parts';
import { BranchTree } from '../../objects/accessories';
import { reviewTexture } from '../../scene/textures';
import type { Dart } from '../../signals';
import { useCelebration } from '../../world/useCelebration';
import { usePulse } from '../../world/usePulse';
import { useStoryBeat, useWorldEvents } from '../../world/useWorldEvents';
import { EVENT_COLOR } from '../../worldEvents';
import { RAILWAY } from './homeLayout';

/**
 * HOME's eleven dashboard objects and its Code Review gateway. Each is modelled about its own
 * base, facing +z (the layout turns and places it), and draws only what `SceneData` says: the same data as every
 * other environment's representation of the same tab. Indicators never rely on colour alone: a raised
 * flag, a count of letters, an arrow's distance from gold, a sail's height.
 */

const WOOD = '#8a5a3b';
const WOOD_DARK = '#5b4636';
const STONE = '#a9a39a';

/** MR Inbox: the mailbox by the gate. Letters = my open MRs (up to 4); the flag rises while something waits on me. */
function Mailbox({ data, animate, env }: RepresentationProps) {
  const sig = data.signals.monitor;
  const letters = Math.min(4, data.mrTitles.length);
  const flagUp = (sig.badge ?? 0) > 0;
  const flag = useRef<Group>(null);
  // A new review request makes the flag flutter for a moment.
  const flutter = useRef(0);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'mailbox-flag',
    onBeat: () => {
      flutter.current = 1.6;
    },
  });
  useFrame(({ clock }, dt) => {
    const f = flag.current;
    if (!f) return;
    const goal = flagUp ? 0 : -Math.PI / 2;
    flutter.current = Math.max(0, flutter.current - dt);
    const wiggle =
      flutter.current > 0 ? Math.sin(clock.elapsedTime * 18) * 0.25 * flutter.current : 0;
    f.rotation.z = animate ? MathUtils.damp(f.rotation.z, goal, 6, dt) : goal;
    f.rotation.x = wiggle;
  });
  return (
    <group>
      <Cyl r={0.06} h={1.0} position={[0, 0.5, 0]} color={WOOD_DARK} />
      <group position={[0, 1.05, 0]}>
        <Box size={[0.36, 0.3, 0.56]} position={[0, 0.0, 0]} color="#3f6b8a" />
        <Cyl
          r={0.18}
          h={0.56}
          position={[0, 0.15, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          color="#3f6b8a"
          segments={10}
        />
        {/* the door, at the front */}
        <Box size={[0.34, 0.34, 0.02]} position={[0, 0.05, 0.29]} color="#335a75" />
        {Array.from({ length: letters }, (_, i) => (
          <Box
            key={i}
            size={[0.22, 0.01, 0.14]}
            position={[-0.05 + i * 0.035, 0.12 + i * 0.012, 0.3 + i * 0.01]}
            rotation={[0.5, 0, 0.12 * (i - 1.5)]}
            color="#fbf7ee"
            shadow={false}
          />
        ))}
        {/* the flag, on the side */}
        <group
          ref={flag}
          position={[0.19, 0.05, -0.12]}
          rotation={[0, 0, flagUp ? 0 : -Math.PI / 2]}
        >
          <Box size={[0.02, 0.36, 0.02]} position={[0, 0.18, 0]} color="#d9d4cc" />
          <Box size={[0.02, 0.12, 0.14]} position={[0, 0.3, 0.07]} color="#d6453d" />
        </group>
        <Led position={[0, 0.36, 0.2]} color={TONE_COLOR[sig.tone]} on={sig.tone !== 'idle'} />
      </group>
    </group>
  );
}

/**
 * Code Review: the Developer's Workshop. An open wooden shed beside the cottage: an illuminated terminal
 * showing the reviews requested of me, a floating code display, a branching tree (one lit node per review waiting),
 * and a desk lamp that brightens for a moment on real review events. It opens the one canonical Code Review route.
 */
function Workshop({ data, stowed, animate, env }: RepresentationProps) {
  const r = data.reviews;
  const tone = data.signals.review.tone;
  const key = `${env}|${stowed}|${r.count}|${r.titles.join('\u0000')}|${tone}`;
  const map = useCanvasTexture(() => reviewTexture(data, env, stowed), key);
  const pulse = usePulse(2.2);
  const lamp = useRef<PointLight>(null);
  const boost = useRef(0);
  const display = useRef<Group>(null);
  const bell = useRef<Group>(null);
  const ring = useRef(0);
  useWorldEvents({
    env,
    animate,
    reviewKeys: r.keys,
    onEvent: (kind, strength) => {
      pulse.fire(EVENT_COLOR[kind], strength);
      boost.current = strength;
      // A merge rings the workshop bell.
      if (kind === 'mr.merged') ring.current = 2.4;
    },
  });
  useFrame(({ clock }, dt) => {
    boost.current = Math.max(0, boost.current - dt * 0.6);
    if (lamp.current) lamp.current.intensity = 1.2 + boost.current * 4;
    const d = display.current;
    if (d && animate) d.position.y = 1.95 + Math.sin(clock.elapsedTime * 1.1) * 0.04;
    ring.current = Math.max(0, ring.current - dt);
    if (bell.current)
      bell.current.rotation.x = Math.sin(clock.elapsedTime * 9) * 0.5 * (ring.current / 2.4);
  });
  const W = 3.2;
  const D = 3.0;
  const H = 2.5;
  return (
    <group>
      {/* floor, back and side walls, a slanted roof; open towards the village */}
      <Box size={[W, 0.12, D]} position={[0, 0.06, 0]} color="#9b7a5a" />
      <Box size={[W, H, 0.14]} position={[0, H / 2, -D / 2]} color={WOOD} />
      <Box size={[0.14, H, D]} position={[-W / 2, H / 2, 0]} color={WOOD} />
      <Box size={[0.14, H, D]} position={[W / 2, H / 2, 0]} color={WOOD} />
      <Box
        size={[W + 0.5, 0.12, D + 0.6]}
        position={[0, H + 0.2, 0.15]}
        rotation={[0.16, 0, 0]}
        color="#6b3b2b"
      />
      {/* desk with the terminal */}
      <Box size={[1.8, 0.08, 0.8]} position={[0, 0.88, 0.2]} color="#c39b6b" />
      {[-0.8, 0.8].map((x) => (
        <Box key={x} size={[0.08, 0.84, 0.7]} position={[x, 0.44, 0.2]} color={WOOD_DARK} />
      ))}
      <group position={[0, 0.92, 0.15]} rotation={[-0.2, 0, 0]}>
        <Box size={[0.96, 0.66, 0.05]} position={[0, 0.4, 0]} color="#2b2f36" />
        <Panel size={[0.9, 0.6]} map={map} position={[0, 0.4, 0.027]} glow={stowed ? 0.25 : 0.95} />
        <Box size={[0.1, 0.12, 0.08]} position={[0, 0.04, -0.04]} color="#2b2f36" />
      </group>
      <Led
        position={[0.75, 0.94, 0.5]}
        color={TONE_COLOR[tone]}
        on={tone === 'warn' || tone === 'bad'}
      />
      {/* the floating code display: restrained lines of "code", cyan on glass */}
      <group ref={display} position={[0.95, 1.95, -0.6]}>
        <Box size={[0.9, 0.6, 0.02]} color="#bfe6ff" transparent opacity={0.25} shadow={false} />
        {[0.18, 0.1, 0.02, -0.06, -0.14].map((y, i) => (
          <Box
            key={y}
            size={[0.25 + ((i * 37) % 5) * 0.08, 0.025, 0.005]}
            position={[-0.3 + (0.12 + ((i * 37) % 5) * 0.04), y, 0.015]}
            color={i === 2 ? '#7fe3a8' : '#9fd8ff'}
            emissive={i === 2 ? '#34c77b' : '#43a9ff'}
            emissiveIntensity={stowed ? 0.2 : 1.1}
            shadow={false}
            noGlow
          />
        ))}
      </group>
      {/* the branching tree: one lit node per review waiting */}
      <group position={[-1.05, 0.92, 0.25]} scale={3.2}>
        <BranchTree lit={stowed ? 0 : Math.min(3, r.count)} />
      </group>
      {/* small illuminated review documents pinned to the back wall */}
      {[-0.9, -0.45, 0, 0.45].map((x, i) => (
        <Box
          key={x}
          size={[0.32, 0.42, 0.01]}
          position={[x - 0.2, 1.75 + (i % 2) * 0.12, -D / 2 + 0.08]}
          rotation={[0, 0, (i - 1.5) * 0.05]}
          color="#fbf7ee"
          emissive="#fff2c8"
          emissiveIntensity={i < r.count && !stowed ? 0.45 : 0}
          shadow={false}
        />
      ))}
      {/* the workshop bell over the open front: it rings for a merge */}
      <Box size={[0.08, 0.3, 0.08]} position={[1.3, H - 0.15, D / 2 - 0.1]} color={WOOD_DARK} />
      <group ref={bell} position={[1.3, H - 0.3, D / 2 - 0.1]}>
        <Cone r={0.13} h={0.2} position={[0, -0.12, 0]} color="#c9a227" metalness={0.6} />
      </group>
      {/* the desk lamp, reacting to review activity */}
      <group position={[0.65, 0.92, -0.05]}>
        <Cyl r={0.07} h={0.03} position={[0, 0.015, 0]} color="#2b2f36" />
        <Cyl r={0.012} h={0.42} position={[0, 0.22, 0]} rotation={[0, 0, 0.25]} color="#2b2f36" />
        <Cone
          r={0.09}
          h={0.12}
          position={[-0.06, 0.44, 0]}
          rotation={[0, 0, Math.PI - 0.6]}
          color="#c96a3a"
        />
        <pointLight
          ref={lamp}
          position={[-0.1, 0.36, 0.05]}
          intensity={1.2}
          distance={3}
          color="#ffd9a0"
        />
      </group>
      {/* event pulse spreading over the workshop floor */}
      <mesh
        ref={pulse.ref}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.14, 0.4]}
        visible={false}
      >
        <ringGeometry args={[0.7, 0.85, 48]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          side={DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** Board: the wooden notice board, its columns and first cards pinned up. Off duty a "Back soon" sign covers it. */
function NoticeBoard({ data, stowed }: RepresentationProps) {
  const key = `${stowed}|${data.columns.map((c) => `${c.name}:${c.count}:${c.notes.map((n) => n.id).join(',')}`).join('|')}`;
  const map = useCanvasTexture(
    () =>
      noticeTexture(data.columns, {
        backing: '#c79a63',
        ink: '#3b2f25',
        heading: '#3b2f25',
        stowed,
      }),
    key,
  );
  return (
    <group>
      {[-0.95, 0.95].map((x) => (
        <Box key={x} size={[0.12, 2.1, 0.12]} position={[x, 1.05, 0]} color={WOOD_DARK} />
      ))}
      <Box size={[1.85, 1.25, 0.08]} position={[0, 1.45, 0]} color={WOOD} />
      <Panel size={[1.7, 1.1]} map={map} position={[0, 1.45, 0.045]} glow={0.55} />
      <Box
        size={[2.1, 0.12, 0.3]}
        position={[0, 2.16, 0.04]}
        rotation={[0.25, 0, 0]}
        color="#6b3b2b"
      />
    </group>
  );
}

/** Where an arrow lands for a dart score: gold at 1, the outer rings as it falls; null = still in the quiver. */
export function arrowSpot(d: Dart, i: number, radius: number): [number, number] | null {
  if (d.score === null) return null;
  const a = Math.PI / 4 + (i * Math.PI) / 2;
  const r = (1 - d.score) * radius * 0.92;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** KPI: the garden archery target. One arrow per KPI, nearer the gold the nearer its target. */
function ArcheryTarget({ data }: RepresentationProps) {
  const face = useCanvasTexture(archeryTexture, 'archery');
  const R = 0.75;
  const quiver = data.darts.filter((d) => d.score === null).length;
  return (
    <group>
      {/* stand: two legs in front, one behind */}
      <Box
        size={[0.08, 1.9, 0.08]}
        position={[-0.5, 0.9, 0.15]}
        rotation={[0.12, 0, 0.18]}
        color={WOOD}
      />
      <Box
        size={[0.08, 1.9, 0.08]}
        position={[0.5, 0.9, 0.15]}
        rotation={[0.12, 0, -0.18]}
        color={WOOD}
      />
      <Box
        size={[0.08, 1.9, 0.08]}
        position={[0, 0.85, -0.45]}
        rotation={[-0.4, 0, 0]}
        color={WOOD}
      />
      <group position={[0, 1.15, 0.12]} rotation={[-0.1, 0, 0]}>
        <Cyl r={R + 0.04} h={0.16} rotation={[Math.PI / 2, 0, 0]} color="#d8c48f" segments={24} />
        <mesh position={[0, 0, 0.081]}>
          <circleGeometry args={[R, 40]} />
          <meshStandardMaterial map={face} roughness={0.9} userData={{ noGlow: true }} />
        </mesh>
        {data.darts.map((d, i) => {
          const at = arrowSpot(d, i, R);
          if (!at) return null;
          return (
            <group key={d.id} position={[at[0], at[1], 0.08]} rotation={[0.25, -0.15, 0]}>
              <Cyl
                r={0.012}
                h={0.7}
                position={[0, 0, 0.35]}
                rotation={[Math.PI / 2, 0, 0]}
                color="#5b4636"
              />
              <Box
                size={[0.08, 0.005, 0.12]}
                position={[0, 0, 0.66]}
                color="#d6453d"
                shadow={false}
              />
              <Box
                size={[0.005, 0.08, 0.12]}
                position={[0, 0, 0.66]}
                color="#f4f1ea"
                shadow={false}
              />
            </group>
          );
        })}
      </group>
      {/* the quiver: arrows still waiting for something to measure */}
      <group position={[0.8, 0, 0.35]}>
        <Cyl r={0.1} h={0.55} position={[0, 0.28, 0]} rotation={[0.15, 0, 0]} color="#7a4a2a" />
        {Array.from({ length: quiver }, (_, i) => (
          <Cyl
            key={i}
            r={0.01}
            h={0.4}
            position={[(i - 1) * 0.04, 0.68, 0.05]}
            rotation={[0.15, 0, 0]}
            color="#5b4636"
          />
        ))}
      </group>
    </group>
  );
}

const LEAF_PADS: [number, number, number][] = [
  [0, 1.85, 0],
  [-0.55, 1.6, 0.15],
  [0.6, 1.7, -0.1],
  [0.15, 2.25, 0.2],
  [-0.3, 2.15, -0.3],
  [0.55, 2.2, 0.3],
];

/**
 * Overview: the large bonsai in its stone planter. It grows with release progress (CoreStage's thresholds, full at
 * 90%), glows gold while the release is about to land (98–99%) and blossoms at 100%.
 */
function BigBonsai({ data, animate }: RepresentationProps) {
  const step = growthStep(data.progress);
  const stage = shipStageFor(data.progress);
  const crown = useRef<Group>(null);
  const glow = useRef<PointLight>(null);
  useFrame(({ clock }, dt) => {
    const g = crown.current;
    if (g) {
      g.scale.setScalar(MathUtils.damp(g.scale.x, 0.75 + step * 0.08, 3, dt));
      if (animate) g.rotation.z = Math.sin(clock.elapsedTime * 0.7) * 0.02;
    }
    if (glow.current) {
      const goal = stage === 'ignition' ? 2 : stage === 'complete' ? 3 : 0.6;
      glow.current.intensity = MathUtils.damp(glow.current.intensity, goal, 2, dt);
    }
  });
  const unknown = data.progress === null;
  return (
    <group>
      <Box size={[1.5, 0.6, 1.1]} position={[0, 0.3, 0]} color={STONE} />
      <Box size={[1.36, 0.06, 0.96]} position={[0, 0.6, 0]} color="#4a3426" />
      <Cyl
        r={0.12}
        rBottom={0.2}
        h={0.9}
        position={[0.05, 1.05, 0]}
        rotation={[0, 0, -0.25]}
        color="#6b4a33"
      />
      <Cyl
        r={0.08}
        rBottom={0.12}
        h={0.7}
        position={[-0.25, 1.5, 0.05]}
        rotation={[0, 0, 0.6]}
        color="#6b4a33"
      />
      <Cyl
        r={0.07}
        rBottom={0.1}
        h={0.6}
        position={[0.35, 1.55, 0]}
        rotation={[0, 0, -0.7]}
        color="#6b4a33"
      />
      <group ref={crown}>
        {LEAF_PADS.slice(0, 2 + step).map((p, i) => (
          <Ball
            key={i}
            r={0.42}
            detail={0}
            position={p}
            scale={[1.2, 0.6, 1]}
            color={unknown ? '#a8b49a' : '#5d9c4c'}
          />
        ))}
        {stage === 'complete' &&
          LEAF_PADS.flatMap((p, i) =>
            [0, 1, 2].map((j) => (
              <Ball
                key={`${i}-${j}`}
                r={0.07}
                position={[
                  p[0] + Math.cos(i + j * 2.1) * 0.35,
                  p[1] + 0.22,
                  p[2] + Math.sin(i * 1.3 + j * 2.1) * 0.25,
                ]}
                color="#f59ab8"
                emissive="#f07aa0"
                emissiveIntensity={0.4}
                shadow={false}
              />
            )),
          )}
      </group>
      <pointLight
        ref={glow}
        position={[0, 2.6, 0.8]}
        intensity={0.6}
        distance={5}
        color="#ffe2b0"
      />
    </group>
  );
}

/** Sync Health: the communication tower. Three status lights in the sync tone, blinking while a sync runs. */
function CommTower({ data, animate }: RepresentationProps) {
  const leds = useRef<Group>(null);
  useFrame(({ clock }) => {
    const g = leds.current;
    if (!g) return;
    const on = !data.syncRunning || !animate || Math.floor(clock.elapsedTime * 2.5) % 2 === 0;
    g.visible = on;
  });
  const H = 6;
  const tone = data.syncTone;
  return (
    <group>
      {[
        [-0.6, -0.6],
        [0.6, -0.6],
        [-0.6, 0.6],
        [0.6, 0.6],
      ].map(([x, z]) => (
        <Box
          key={`${x}${z}`}
          size={[0.08, H, 0.08]}
          position={[x! * 0.6, H / 2, z! * 0.6]}
          rotation={[z! * 0.1, 0, -x! * 0.1]}
          color="#9aa3ad"
          metalness={0.4}
        />
      ))}
      {[1, 2, 3, 4, 5].map((y) => (
        <Box
          key={y}
          size={[0.9 - y * 0.1, 0.05, 0.9 - y * 0.1]}
          position={[0, y * 1.05, 0]}
          color="#c4c9d0"
          metalness={0.4}
        />
      ))}
      <Cyl r={0.03} h={1.4} position={[0, H + 0.7, 0]} color="#d9d4cc" />
      <group position={[0.25, H - 0.6, 0.2]} rotation={[0.3, 0.6, 0]}>
        <Cyl
          r={0.4}
          rBottom={0.05}
          h={0.18}
          rotation={[Math.PI / 2, 0, 0]}
          color="#e8e4dc"
          segments={12}
        />
      </group>
      <group ref={leds}>
        {[H - 0.2, H + 0.4, H + 1.35].map((y, i) => (
          <Ball
            key={y}
            r={0.08}
            position={[0, y, i === 2 ? 0 : 0.12]}
            color={TONE_COLOR[tone]}
            emissive={TONE_COLOR[tone]}
            emissiveIntensity={tone === 'idle' ? 0.2 : 2.2}
            shadow={false}
            noGlow
          />
        ))}
      </group>
    </group>
  );
}

/** A point on the railway's oval, and its heading. */
function railAt(t: number): { x: number; z: number; yaw: number } {
  const x = Math.cos(t) * RAILWAY.rx;
  const z = Math.sin(t) * RAILWAY.rz;
  const dx = -Math.sin(t) * RAILWAY.rx;
  const dz = Math.cos(t) * RAILWAY.rz;
  return { x, z, yaw: Math.atan2(dx, dz) };
}

/**
 * Release Train: the miniature railway. No pending release: the train waits at the platform; pending
 * releases: it runs slowly, one carriage per repo awaiting release (max 6).
 */
function Railway({ data, animate }: RepresentationProps) {
  const train = useRef<Group>(null);
  const t = useRef(Math.PI / 2);
  const wagons = data.wagons;
  // A completed release sends the train on a quick completion lap.
  const celebration = useCelebration(data.progress, animate);
  useFrame((_, dt) => {
    if (animate && wagons > 0) t.current += Math.min(dt, 0.1) * (0.18 + wagons * 0.02);
    if (animate && celebration.tick(dt) !== null) t.current += Math.min(dt, 0.1) * 1.4;
    const g = train.current;
    if (!g) return;
    g.children.forEach((c, i) => {
      const p = railAt(t.current - i * 0.34);
      c.position.set(p.x, 0.16, p.z);
      c.rotation.y = p.yaw;
    });
  });
  const sleepers = useMemo(
    () => Array.from({ length: 36 }, (_, i) => railAt((i / 36) * Math.PI * 2)),
    [],
  );
  return (
    <group>
      {/* ballast bed and sleepers */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
        scale={[RAILWAY.rx, RAILWAY.rz, 1]}
      >
        <ringGeometry args={[0.88, 1.12, 48]} />
        <meshStandardMaterial color="#b9ab95" flatShading />
      </mesh>
      {sleepers.map((p, i) => (
        <Box
          key={i}
          size={[0.42, 0.04, 0.08]}
          position={[p.x, 0.05, p.z]}
          rotation={[0, p.yaw + Math.PI / 2, 0]}
          color={WOOD_DARK}
          shadow={false}
        />
      ))}
      {[0.93, 1.07].map((k) => (
        <mesh
          key={k}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.08, 0]}
          scale={[RAILWAY.rx * k, RAILWAY.rz * k, 1]}
        >
          <ringGeometry args={[0.995, 1.005, 64]} />
          <meshStandardMaterial color="#7b7f86" metalness={0.6} side={DoubleSide} />
        </mesh>
      ))}
      {/* the platform */}
      <Box size={[1.2, 0.18, 0.5]} position={[0, 0.09, RAILWAY.rz + 0.45]} color={STONE} />
      <group ref={train}>
        <group>
          <Box size={[0.22, 0.2, 0.42]} position={[0, 0.1, 0]} color="#2f6a4f" />
          <Cyl
            r={0.08}
            h={0.3}
            position={[0, 0.14, 0.15]}
            rotation={[Math.PI / 2, 0, 0]}
            color="#2b2f36"
          />
          <Cyl r={0.03} h={0.14} position={[0, 0.3, 0.22]} color="#2b2f36" />
          <Box size={[0.2, 0.16, 0.14]} position={[0, 0.26, -0.12]} color="#d6453d" />
        </group>
        {Array.from({ length: wagons }, (_, i) => (
          <group key={i}>
            <Box
              size={[0.2, 0.16, 0.34]}
              position={[0, 0.09, 0]}
              color={['#d6453d', '#f2a531', '#3f7ad9'][i % 3]}
            />
            <Box size={[0.16, 0.06, 0.28]} position={[0, 0.2, 0]} color="#d9d4cc" />
          </group>
        ))}
      </group>
    </group>
  );
}

/** Builds: the workshop's 3D printer on its bench. The head moves and the print grows while a build runs. */
function WorkshopPrinter({ data, animate }: RepresentationProps) {
  const head = useRef<Group>(null);
  const print = useRef<Mesh>(null);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const running = data.buildRunning && animate;
    if (head.current) {
      head.current.position.x = running ? Math.sin(t * 2.2) * 0.13 : 0;
      head.current.position.z = running ? Math.cos(t * 1.7) * 0.1 : 0;
    }
    if (print.current) {
      const goal = data.buildRunning ? 0.4 + ((t * 0.05) % 0.6) : 0.2;
      print.current.scale.y = running ? goal : MathUtils.damp(print.current.scale.y, 0.2, 2, dt);
    }
  });
  return (
    <group>
      <Box size={[1.3, 0.08, 0.75]} position={[0, 0.82, 0]} color="#c39b6b" />
      {[-0.58, 0.58].map((x) => (
        <Box key={x} size={[0.08, 0.8, 0.65]} position={[x, 0.4, 0]} color={WOOD_DARK} />
      ))}
      <group position={[0, 0.86, 0]}>
        <Box size={[0.55, 0.06, 0.5]} position={[0, 0.03, 0]} color="#2b2f36" />
        {[-0.25, 0.25].map((x) => (
          <Box key={x} size={[0.04, 0.55, 0.04]} position={[x, 0.3, -0.2]} color="#7b7f86" />
        ))}
        <Box size={[0.55, 0.04, 0.04]} position={[0, 0.56, -0.2]} color="#7b7f86" />
        <mesh ref={print} position={[0, 0.06, 0]} scale={[1, 0.2, 1]}>
          <boxGeometry args={[0.14, 0.3, 0.14]} />
          <meshStandardMaterial color="#f2a531" flatShading />
        </mesh>
        <group ref={head} position={[0, 0.42, 0]}>
          <Box size={[0.1, 0.08, 0.1]} color="#d9d4cc" />
          <Ball
            r={0.018}
            position={[0, -0.05, 0]}
            color="#ff8a3d"
            emissive="#ff6a1a"
            emissiveIntensity={data.buildRunning ? 2.5 : 0}
            noGlow
          />
        </group>
      </group>
    </group>
  );
}

/** A triangular sail in the yz plane: foot along the boom (z), luff up the mast (y). Base at y = 0. */
export function useSailGeometry(height: number, foot: number) {
  const g = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 0, height, 0, 0, 0, -foot]), 3),
    );
    geo.computeVertexNormals();
    return geo;
  }, [height, foot]);
  useEffect(() => () => g.dispose(), [g]);
  return g;
}

/** Sprint Harbor: the river sailing boat. The sail rises with the sprint's progress; furled when there is no sprint. */
function RiverBoat({ data, animate }: RepresentationProps) {
  const boat = useRef<Group>(null);
  const sail = useRef<Group>(null);
  const fill = data.sprintFill;
  const sailGeo = useSailGeometry(2.2, 1.1);
  const goal = fill === null ? 0.1 : 0.2 + fill * 0.8;
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (boat.current && animate) {
      boat.current.rotation.z = Math.sin(t * 0.9) * 0.04;
      boat.current.position.y = Math.sin(t * 1.3) * 0.03;
    }
    if (sail.current) sail.current.scale.y = MathUtils.damp(sail.current.scale.y, goal, 3, dt);
  });
  return (
    <group ref={boat}>
      <Box size={[0.9, 0.35, 2.2]} position={[0, 0.12, 0]} color="#f4f1ea" />
      <Box size={[0.8, 0.05, 2.0]} position={[0, 0.31, 0]} color="#c39b6b" />
      <Cone
        r={0.45}
        h={0.6}
        position={[0, 0.12, 1.38]}
        rotation={[Math.PI / 2, 0, 0]}
        color="#f4f1ea"
        segments={4}
      />
      <Box size={[0.92, 0.06, 2.22]} position={[0, -0.03, 0]} color="#3f6b8a" />
      <Cyl r={0.04} h={2.6} position={[0, 1.6, 0.1]} color={WOOD_DARK} />
      <Box size={[0.03, 0.03, 1.1]} position={[0, 0.65, -0.45]} color={WOOD_DARK} />
      {/* the sail, anchored at the boom so it rises up the mast */}
      <group ref={sail} position={[0.03, 0.67, 0.08]} scale={[1, goal, 1]}>
        <mesh geometry={sailGeo} castShadow>
          <meshStandardMaterial color="#fbf7ee" side={DoubleSide} flatShading />
        </mesh>
      </group>
    </group>
  );
}

/** Settings: the toolbox by the workshop door. */
function HomeToolbox() {
  return (
    <group>
      <Box size={[0.6, 0.26, 0.3]} position={[0, 0.13, 0]} color="#d6453d" />
      <Box size={[0.62, 0.06, 0.32]} position={[0, 0.29, 0]} color="#b8352e" />
      <Box size={[0.24, 0.035, 0.035]} position={[0, 0.39, 0]} color="#2b2f36" />
      <Box size={[0.035, 0.08, 0.035]} position={[-0.1, 0.34, 0]} color="#2b2f36" />
      <Box size={[0.035, 0.08, 0.035]} position={[0.1, 0.34, 0]} color="#2b2f36" />
      <Box
        size={[0.3, 0.025, 0.025]}
        position={[0.42, 0.012, 0.2]}
        rotation={[0, 0.6, 0]}
        color="#7b7f86"
      />
    </group>
  );
}

/** Audit: the cottage's archive cabinet. The top drawer stands open while there are writes that can be undone. */
function ArchiveCabinet({ data, animate }: RepresentationProps) {
  const drawer = useRef<Group>(null);
  const open = data.undoable > 0;
  useFrame((_, dt) => {
    const d = drawer.current;
    if (!d) return;
    const goal = open ? 0.28 : 0;
    d.position.z = animate ? MathUtils.damp(d.position.z, goal, 5, dt) : goal;
  });
  return (
    <group>
      <Box size={[0.8, 1.3, 0.5]} position={[0, 0.65, 0]} color="#7a5235" />
      {[0.32, 0.72].map((y) => (
        <group key={y}>
          <Box size={[0.7, 0.34, 0.02]} position={[0, y, 0.255]} color="#8a5f3f" />
          <Box size={[0.16, 0.03, 0.03]} position={[0, y, 0.275]} color="#c9a227" metalness={0.6} />
        </group>
      ))}
      <group ref={drawer} position={[0, 0, open ? 0.28 : 0]}>
        <Box size={[0.7, 0.34, 0.5]} position={[0, 1.12, 0.0]} color="#8a5f3f" />
        <Box size={[0.16, 0.03, 0.03]} position={[0, 1.12, 0.26]} color="#c9a227" metalness={0.6} />
        {open &&
          [0, 1, 2].map((i) => (
            <Box
              key={i}
              size={[0.5, 0.02, 0.36]}
              position={[0, 1.31 + i * 0.012, -0.02 + i * 0.02]}
              rotation={[0, 0, (i - 1) * 0.05]}
              color="#fbf7ee"
              shadow={false}
            />
          ))}
      </group>
    </group>
  );
}

/** HOME's representation of every workspace object. */
export const HOME_SET: RepresentationSet = {
  monitor: Mailbox,
  review: Workshop,
  notes: NoticeBoard,
  kpi: ArcheryTarget,
  plant: BigBonsai,
  router: CommTower,
  train: Railway,
  printer: WorkshopPrinter,
  ship: RiverBoat,
  toolbox: HomeToolbox,
  cabinet: ArchiveCabinet,
};
