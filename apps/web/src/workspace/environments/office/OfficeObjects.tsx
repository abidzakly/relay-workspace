import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BoxGeometry,
  DoubleSide,
  MathUtils,
  type Group,
  type Mesh,
  type MeshStandardMaterial,
  type PointLight,
} from 'three';
import { progressFx } from '@/core3d/progressFx';
import { growthStep, shipStageFor } from '@/core3d/shipStage';
import {
  BoardFace,
  ellipsePath,
  GatewayPulse,
  Papers,
  PathTrain,
  PrintRig,
  ReviewFace,
  sailScale,
  scoreRadius,
  Slide,
  StatusLights,
  useDamp,
} from '../../objects/kit';
import type { RepresentationProps, RepresentationSet } from '../../objects/representations';
import { useStoryBeat } from '../../world/useWorldEvents';
import { useCelebration } from '../../world/useCelebration';
import { useCanvasTexture } from '../../scene/Interactive';
import { TONE_COLOR } from '../../scene/palette';
import { Ball, Box, Cone, Cyl, Panel } from '../../scene/parts';
import { screenTexture } from '../../scene/textures';
import { MONORAIL } from './officeLayout';

/**
 * OFFICE's eleven dashboard objects and its Code Review gateway: a research campus telling the
 * same data as every world, in glass, light and motion. The most technological representations; the meaning is
 * identical.
 */
const GLASS = '#bfe6ff';
const CYAN = '#43d1ff';
const VIOLET = '#9b7bff';
const PANEL = '#d9dee6';
const DARK = '#2b2f36';

/** A slowly turning, faintly glowing ring (holograms). */
function HoloRing({
  r,
  y,
  speed,
  animate,
  color = CYAN,
}: {
  r: number;
  y: number;
  speed: number;
  animate: boolean;
  color?: string;
}) {
  const ref = useRef<Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current && animate) ref.current.rotation.z += Math.min(dt, 0.1) * speed;
  });
  return (
    <mesh ref={ref} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[r, 0.015, 6, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.7} toneMapped={false} />
    </mesh>
  );
}

/** MR Inbox: the holographic control terminal. A floating panel of my MRs; one ring per MR waiting on me (max 3). */
function HoloTerminal({ data, stowed, animate, env }: RepresentationProps) {
  const map = useCanvasTexture(
    () => screenTexture(data, stowed),
    `${stowed}|${data.mrTitles.join('\u0000')}|${data.signals.monitor.badge}`,
  );
  const panel = useRef<Group>(null);
  // A new review request or comment makes the hologram flicker brighter for a moment.
  const flash = useRef(0);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'hologram',
    onBeat: (strength) => {
      flash.current = strength;
    },
  });
  useFrame(({ clock }, dt) => {
    flash.current = Math.max(0, flash.current - dt * 0.8);
    const g = panel.current;
    if (!g) return;
    if (animate) g.position.y = 1.55 + Math.sin(clock.elapsedTime * 1.2) * 0.04;
    g.scale.setScalar(1 + flash.current * 0.08 * Math.abs(Math.sin(clock.elapsedTime * 20)));
  });
  const waiting = Math.min(3, data.signals.monitor.badge ?? 0);
  return (
    <group>
      <Cyl r={0.45} rBottom={0.55} h={0.9} position={[0, 0.45, 0]} color={PANEL} metalness={0.4} />
      <Cyl
        r={0.4}
        h={0.04}
        position={[0, 0.92, 0]}
        color={CYAN}
        emissive={CYAN}
        emissiveIntensity={0.8}
        noGlow
      />
      <group ref={panel} position={[0, 1.55, 0]}>
        <Panel size={[1.1, 0.7]} map={map} glow={stowed ? 0.3 : 1.0} />
        <Box
          size={[1.14, 0.74, 0.01]}
          position={[0, 0, -0.01]}
          color={GLASS}
          transparent
          opacity={0.25}
          shadow={false}
        />
      </group>
      {Array.from({ length: waiting }, (_, i) => (
        <HoloRing
          key={i}
          r={0.55 + i * 0.12}
          y={1.0 + i * 0.05}
          speed={0.6 + i * 0.3}
          animate={animate}
          color={TONE_COLOR.warn}
        />
      ))}
    </group>
  );
}

/**
 * Code Review: the Engineering Review Chamber. A glass room with transparent diff walls (added and removed
 * lines as restrained bars), a holographic file tree, and a central workstation showing the reviews requested of me.
 * A real review event sends one synchronised light pulse along its edges.
 */
function ReviewChamber({ data, stowed, animate, env }: RepresentationProps) {
  const edges = useRef<Group>(null);
  const boost = useRef(0);
  const tree = useRef<Group>(null);
  useFrame(({ clock }, dt) => {
    boost.current = Math.max(0, boost.current - dt * 0.7);
    edges.current?.children.forEach((c) => {
      const m = (c as Mesh).material as MeshStandardMaterial;
      m.emissiveIntensity = 0.6 + boost.current * 3;
    });
    if (tree.current && animate) tree.current.rotation.y = clock.elapsedTime * 0.25;
  });
  const W = 3.6;
  const D = 3.0;
  const H = 2.8;
  const files = Math.min(6, data.reviews.count * 2);
  return (
    <group>
      <Box size={[W + 0.4, 0.12, D + 0.4]} position={[0, 0.06, 0]} color={PANEL} />
      {/* glass walls (open front) and roof */}
      <Box
        size={[W, H, 0.06]}
        position={[0, H / 2, -D / 2]}
        color={GLASS}
        transparent
        opacity={0.22}
        shadow={false}
      />
      <Box
        size={[0.06, H, D]}
        position={[-W / 2, H / 2, 0]}
        color={GLASS}
        transparent
        opacity={0.22}
        shadow={false}
      />
      <Box
        size={[0.06, H, D]}
        position={[W / 2, H / 2, 0]}
        color={GLASS}
        transparent
        opacity={0.22}
        shadow={false}
      />
      <Box
        size={[W + 0.2, 0.08, D + 0.2]}
        position={[0, H, 0]}
        color={GLASS}
        transparent
        opacity={0.3}
        shadow={false}
      />
      {/* edge lights */}
      <group ref={edges}>
        {[
          [W, 0.04, 0.04, 0, H, D / 2],
          [W, 0.04, 0.04, 0, 0.14, D / 2],
          [0.04, H, 0.04, -W / 2, H / 2, D / 2],
          [0.04, H, 0.04, W / 2, H / 2, D / 2],
        ].map(([sx, sy, sz, x, y, z], i) => (
          <Box
            key={i}
            size={[sx!, sy!, sz!]}
            position={[x!, y!, z!]}
            color={CYAN}
            emissive={CYAN}
            emissiveIntensity={0.6}
            shadow={false}
            noGlow
          />
        ))}
      </group>
      {/* diff walls: added (green) and removed (red) bars on the side glass */}
      {[-1, 1].map((side) =>
        [0, 1, 2, 3, 4, 5].map((i) => (
          <Box
            key={`${side}${i}`}
            size={[0.02, 0.06, 0.5 + ((i * 7) % 4) * 0.25]}
            position={[(side * W) / 2 - side * 0.05, 1.0 + i * 0.22, -0.3 + ((i * 3) % 3) * 0.15]}
            color={(i + (side > 0 ? 1 : 0)) % 3 === 0 ? '#ef7b7b' : '#7fe3a8'}
            emissive={(i + (side > 0 ? 1 : 0)) % 3 === 0 ? '#ef4b5f' : '#34c77b'}
            emissiveIntensity={stowed ? 0.1 : 0.7}
            shadow={false}
            noGlow
          />
        )),
      )}
      {/* the workstation */}
      <Box size={[1.6, 0.9, 0.7]} position={[0, 0.55, 0.2]} color={PANEL} metalness={0.3} />
      <group position={[0, 1.45, 0.1]} rotation={[-0.12, 0, 0]}>
        <Box size={[1.3, 0.8, 0.04]} color={DARK} />
        <group position={[0, 0, 0.025]}>
          <ReviewFace data={data} env={env} stowed={stowed} w={1.22} h={0.72} />
        </group>
      </group>
      {/* the holographic file tree: one node per changed file waiting (bounded) */}
      <group ref={tree} position={[-1.1, 2.0, -0.6]}>
        <Box
          size={[0.03, 0.5, 0.03]}
          color={CYAN}
          emissive={CYAN}
          emissiveIntensity={1}
          shadow={false}
          noGlow
        />
        {Array.from({ length: files }, (_, i) => (
          <Box
            key={i}
            size={[0.16, 0.08, 0.02]}
            position={[Math.cos(i) * 0.25, 0.2 - i * 0.08, Math.sin(i) * 0.25]}
            color={GLASS}
            emissive={CYAN}
            emissiveIntensity={0.9}
            shadow={false}
            noGlow
          />
        ))}
      </group>
      <GatewayPulse
        data={data}
        env={env}
        animate={animate}
        radius={2.3}
        y={0.13}
        onEvent={(_, strength) => {
          boost.current = strength;
        }}
      />
    </group>
  );
}

/** Board: the glass planning wall, its columns and cards in light. */
function PlanningWall({ data, stowed }: RepresentationProps) {
  return (
    <group>
      <Box size={[2.6, 0.12, 0.4]} position={[0, 0.06, 0]} color={PANEL} />
      <Box
        size={[2.5, 1.8, 0.05]}
        position={[0, 1.6, 0]}
        color={GLASS}
        transparent
        opacity={0.25}
        shadow={false}
      />
      <group position={[0, 1.6, 0.04]}>
        <BoardFace
          data={data}
          stowed={stowed}
          w={2.3}
          h={1.5}
          glow={0.85}
          style={{ backing: '#1b2a3a', ink: '#1b2a3a', heading: '#9fe6ff' }}
        />
      </group>
      <Box
        size={[2.5, 0.03, 0.06]}
        position={[0, 2.52, 0]}
        color={CYAN}
        emissive={CYAN}
        emissiveIntensity={0.9}
        noGlow
      />
    </group>
  );
}

/** KPI: the radar target system. Four blips, one per KPI, nearer the centre the nearer their target; a sweep turns. */
function RadarScope({ data, animate }: RepresentationProps) {
  const sweep = useRef<Group>(null);
  useFrame((_, dt) => {
    if (sweep.current && animate) sweep.current.rotation.y -= Math.min(dt, 0.1) * 1.2;
  });
  const R = 0.85;
  return (
    <group>
      <Cyl r={0.6} rBottom={0.7} h={0.7} position={[0, 0.35, 0]} color={PANEL} metalness={0.4} />
      <group position={[0, 0.78, 0]} rotation={[-0.45, 0, 0]}>
        <Cyl r={R + 0.06} h={0.08} color={DARK} segments={32} />
        <Cyl
          r={R}
          h={0.09}
          color="#0f2a2a"
          emissive="#0f3a2a"
          emissiveIntensity={0.6}
          segments={32}
        />
        {[0.33, 0.66, 1].map((k) => (
          <mesh key={k} position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[R * k - 0.01, R * k, 48]} />
            <meshBasicMaterial color="#34c77b" transparent opacity={0.5} toneMapped={false} />
          </mesh>
        ))}
        <group ref={sweep} position={[0, 0.055, 0]}>
          <Box
            size={[0.02, 0.005, R]}
            position={[0, 0, R / 2]}
            color="#7fe3a8"
            emissive="#34c77b"
            emissiveIntensity={2}
            shadow={false}
            noGlow
          />
        </group>
        {data.darts.map((d, i) => {
          const r = scoreRadius(d, R);
          if (r === null) return null;
          const a = Math.PI / 4 + (i * Math.PI) / 2;
          return (
            <Ball
              key={d.id}
              r={0.055}
              position={[Math.cos(a) * r, 0.07, Math.sin(a) * r]}
              color="#fff6d8"
              emissive={['#ef4b5f', '#43a9ff', '#34c77b', '#f2a531'][i]}
              emissiveIntensity={2}
              shadow={false}
              noGlow
            />
          );
        })}
      </group>
    </group>
  );
}

/**
 * Overview: the central energy reactor. Rings assemble around its core with release progress (CoreStage's
 * thresholds), it charges brighter and spins faster, and at 100% it sends a bright pulse across the campus.
 */
function Reactor({ data, animate, env }: RepresentationProps) {
  const step = growthStep(data.progress);
  const stage = shipStageFor(data.progress);
  const fx = progressFx(data.progress);
  const rings = useRef<Group>(null);
  const core = useRef<Mesh>(null);
  const light = useRef<PointLight>(null);
  // An approval pulses the reactor; reaching 100% sends its big release pulse.
  const kick = useRef(0);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'reactor-pulse',
    onBeat: (strength) => {
      kick.current = strength;
    },
  });
  const celebration = useCelebration(data.progress, animate);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    kick.current = Math.max(0, kick.current - dt * 0.7);
    const party = celebration.tick(dt);
    const extra = kick.current * 3 + (party === null ? 0 : Math.sin(party * Math.PI) * 6);
    if (rings.current && animate)
      rings.current.children.forEach((r, i) => {
        r.rotation.x += Math.min(dt, 0.1) * fx.spin * (0.6 + i * 0.3);
        r.rotation.y += Math.min(dt, 0.1) * fx.spin * 0.4 * (i % 2 ? 1 : -1);
      });
    const charge =
      (data.progress === null ? 0.2 : 0.5 + fx.p * 2 + (stage === 'complete' ? 1.5 : 0)) + extra;
    const pulse = animate ? 1 + Math.sin(t * (2 + fx.p * 3)) * 0.12 : 1;
    const m = core.current?.material as MeshStandardMaterial | undefined;
    if (m) m.emissiveIntensity = MathUtils.damp(m.emissiveIntensity, charge * pulse, 3, dt);
    if (light.current)
      light.current.intensity = MathUtils.damp(light.current.intensity, charge * 1.5, 3, dt);
  });
  return (
    <group>
      <Cyl
        r={1.6}
        rBottom={1.9}
        h={0.4}
        position={[0, 0.2, 0]}
        color={PANEL}
        metalness={0.4}
        segments={16}
      />
      <Cyl
        r={1.2}
        h={0.08}
        position={[0, 0.44, 0]}
        color={CYAN}
        emissive={CYAN}
        emissiveIntensity={0.6}
        segments={24}
        noGlow
      />
      {[0, 1, 2, 3].map((i) => (
        <Box
          key={i}
          size={[0.14, 3.8, 0.14]}
          position={[Math.cos(i * 1.571 + 0.785) * 1.5, 2.1, Math.sin(i * 1.571 + 0.785) * 1.5]}
          color={PANEL}
          metalness={0.4}
        />
      ))}
      <mesh ref={core} position={[0, 2.2, 0]}>
        <icosahedronGeometry args={[0.55, 1]} />
        <meshStandardMaterial color="#e6f6ff" emissive={CYAN} emissiveIntensity={0.5} flatShading />
      </mesh>
      <group ref={rings} position={[0, 2.2, 0]}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} visible={i < step} rotation={[i * 0.7, i * 0.4, 0]}>
            <torusGeometry args={[0.85 + i * 0.18, 0.04, 6, 40]} />
            <meshStandardMaterial
              color="#d9dee6"
              emissive={i === 3 && stage === 'complete' ? '#ffd27a' : VIOLET}
              emissiveIntensity={0.6}
              metalness={0.5}
              flatShading
            />
          </mesh>
        ))}
      </group>
      <Cone
        r={0.9}
        h={0.5}
        position={[0, 4.15, 0]}
        rotation={[Math.PI, 0, 0]}
        color={PANEL}
        metalness={0.4}
      />
      <pointLight
        ref={light}
        position={[0, 2.2, 1.4]}
        intensity={0.5}
        distance={12}
        color="#9fe6ff"
      />
    </group>
  );
}

function RoofAntenna({ data, animate }: RepresentationProps) {
  const H = 6;
  return (
    <group>
      <Box size={[1.6, 0.4, 1.6]} position={[0, 0.2, 0]} color={PANEL} />
      <Cyl r={0.12} rBottom={0.2} h={H} position={[0, H / 2, 0]} color="#c4c9d0" metalness={0.5} />
      {[1.6, 3.0, 4.4].map((y, i) => (
        <Box key={y} size={[1.2 - i * 0.3, 0.05, 0.05]} position={[0, y, 0]} color="#c4c9d0" />
      ))}
      <group position={[0.4, H - 1.2, 0.3]} rotation={[0.5, 0.6, 0]}>
        <Cyl
          r={0.45}
          rBottom={0.06}
          h={0.18}
          rotation={[Math.PI / 2, 0, 0]}
          color="#e8e4dc"
          segments={12}
        />
      </group>
      <StatusLights
        tone={data.syncTone}
        running={data.syncRunning}
        animate={animate}
        points={[
          [0, H, 0.2],
          [0, H + 0.1, -0.2],
          [0, 3.0, 0.2],
        ]}
      />
    </group>
  );
}

/** Release Train: the automated monorail, its pods gliding on an elevated loop only while releases are pending. */
function Monorail({ data, animate }: RepresentationProps) {
  const path = ellipsePath(MONORAIL.rx, MONORAIL.rz, MONORAIL.y);
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, MONORAIL.y - 0.12, 0]}
        scale={[MONORAIL.rx, MONORAIL.rz, 1]}
      >
        <ringGeometry args={[0.96, 1.04, 64]} />
        <meshStandardMaterial color={PANEL} side={DoubleSide} metalness={0.4} />
      </mesh>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const p = path((i / 6) * Math.PI * 2);
        return (
          <Cyl
            key={i}
            r={0.12}
            h={MONORAIL.y - 0.1}
            position={[p.x, (MONORAIL.y - 0.1) / 2, p.z]}
            color="#c4c9d0"
          />
        );
      })}
      <PathTrain
        wagons={data.wagons}
        progress={data.progress}
        animate={animate}
        path={path}
        spacing={0.3}
        start={Math.PI / 2}
        head={
          <group>
            <Box size={[0.45, 0.4, 0.8]} position={[0, 0.1, 0]} color="#f4f1ea" />
            <Cone
              r={0.25}
              h={0.4}
              position={[0, 0.1, 0.55]}
              rotation={[Math.PI / 2, 0, 0]}
              color="#f4f1ea"
              segments={6}
            />
            <Box
              size={[0.47, 0.1, 0.6]}
              position={[0, 0.2, 0]}
              color={CYAN}
              emissive={CYAN}
              emissiveIntensity={0.6}
              noGlow
            />
          </group>
        }
        car={() => (
          <group>
            <Box size={[0.45, 0.36, 0.7]} position={[0, 0.1, 0]} color="#f4f1ea" />
            <Box
              size={[0.47, 0.08, 0.6]}
              position={[0, 0.2, 0]}
              color={VIOLET}
              emissive={VIOLET}
              emissiveIntensity={0.5}
              noGlow
            />
          </group>
        )}
      />
    </group>
  );
}

/** Builds: the robotic fabrication lab. The arm works and the print grows while a build runs. */
function FabLab({ data, animate }: RepresentationProps) {
  const arm = useRef<Group>(null);
  useFrame(({ clock }) => {
    const g = arm.current;
    if (!g) return;
    const on = data.buildRunning && animate;
    g.rotation.y = on ? Math.sin(clock.elapsedTime * 0.9) * 0.8 : 0.4;
    (g.children[1] as Group).rotation.z = on
      ? -0.6 + Math.sin(clock.elapsedTime * 1.7) * 0.3
      : -0.9;
  });
  return (
    <group>
      <Box size={[2.2, 0.9, 1.2]} position={[0, 0.45, 0]} color={PANEL} metalness={0.3} />
      <group position={[-0.3, 0.9, 0]}>
        <PrintRig data={data} animate={animate} color={VIOLET} />
      </group>
      <group ref={arm} position={[0.75, 0.9, 0]}>
        <Cyl r={0.15} h={0.25} position={[0, 0.12, 0]} color={DARK} />
        <group position={[0, 0.25, 0]}>
          <Box size={[0.1, 0.8, 0.1]} position={[0, 0.4, 0]} color="#f2a531" />
          <Box
            size={[0.08, 0.6, 0.08]}
            position={[-0.25, 0.85, 0]}
            rotation={[0, 0, 1.2]}
            color="#f2a531"
          />
          <Ball
            r={0.06}
            position={[-0.52, 0.95, 0]}
            color={DARK}
            emissive="#ff6a1a"
            emissiveIntensity={data.buildRunning ? 2 : 0}
            noGlow
          />
        </group>
      </group>
    </group>
  );
}

/**
 * Sprint Harbor: the spacecraft docking bay. The craft is fuelled by the sprint: a charge column beside the pad rises
 * with the sprint's progress (furled to a sliver without a sprint), and the craft's lights follow it.
 */
function DockingBay({ data, animate }: RepresentationProps) {
  const column = useRef<Mesh>(null);
  const goal = sailScale(data.sprintFill);
  useDamp(goal, 3, animate, (v) => column.current?.scale.setY(v));
  const craft = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (craft.current && animate)
      craft.current.position.y = 0.55 + Math.sin(clock.elapsedTime * 1.3) * 0.04;
  });
  const fill = data.sprintFill ?? 0;
  // Grows up from the pad: the geometry's foot sits at y = 0.
  const columnGeo = useMemo(() => new BoxGeometry(0.22, 2.2, 0.22).translate(0, 1.1, 0), []);
  useEffect(() => () => columnGeo.dispose(), [columnGeo]);
  return (
    <group>
      <Cyl r={2.0} h={0.2} position={[0, 0.1, 0]} color={PANEL} segments={8} />
      <mesh position={[0, 0.21, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.5, 1.6, 8]} />
        <meshBasicMaterial color="#ffd36b" toneMapped={false} />
      </mesh>
      <group ref={craft} position={[0, 0.55, 0]}>
        <Box size={[0.9, 0.45, 2.0]} color="#f4f1ea" />
        <Cone
          r={0.45}
          h={0.7}
          position={[0, 0, 1.3]}
          rotation={[Math.PI / 2, 0, 0]}
          color="#f4f1ea"
          segments={4}
        />
        <Box size={[2.4, 0.08, 0.7]} position={[0, -0.05, -0.3]} color={DARK} />
        <Box
          size={[0.5, 0.2, 0.5]}
          position={[0, 0.3, 0.3]}
          color={GLASS}
          transparent
          opacity={0.7}
        />
        <Ball
          r={0.18}
          position={[0, 0, -1.05]}
          color="#bfe6ff"
          emissive={CYAN}
          emissiveIntensity={0.3 + fill * 2.5}
          noGlow
        />
      </group>
      {/* the charge column */}
      <group position={[1.8, 0.2, -1.2]}>
        <Box
          size={[0.3, 2.2, 0.3]}
          position={[0, 1.1, 0]}
          color={GLASS}
          transparent
          opacity={0.25}
          shadow={false}
        />
        <mesh ref={column} scale={[1, goal, 1]} geometry={columnGeo}>
          <meshStandardMaterial color="#7fe3a8" emissive="#34c77b" emissiveIntensity={1.2} />
        </mesh>
      </group>
    </group>
  );
}

/** Settings: the maintenance toolbox, a tool cart. */
function ToolCart() {
  return (
    <group>
      <Box size={[0.9, 0.6, 0.5]} position={[0, 0.45, 0]} color="#d6453d" />
      {[0, 1, 2].map((i) => (
        <Box key={i} size={[0.8, 0.02, 0.02]} position={[0, 0.3 + i * 0.16, 0.26]} color={DARK} />
      ))}
      <Box size={[0.95, 0.04, 0.55]} position={[0, 0.77, 0]} color={PANEL} />
      {[-0.4, 0.4].flatMap((x) =>
        [-0.2, 0.2].map((z) => (
          <Ball key={`${x}${z}`} r={0.07} position={[x, 0.07, z]} color={DARK} />
        )),
      )}
      <Box
        size={[0.3, 0.05, 0.05]}
        position={[0.1, 0.82, 0]}
        rotation={[0, 0.5, 0]}
        color="#9aa3ad"
      />
    </group>
  );
}

/** Audit: the server archive room. A blade slides out of the rack while writes can be undone. */
function ServerRoom({ data, animate }: RepresentationProps) {
  const open = data.undoable > 0;
  const leds = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!leds.current || !animate) return;
    leds.current.children.forEach((c, i) => {
      c.visible = Math.floor(clock.elapsedTime * 3 + i * 1.7) % 3 !== 0;
    });
  });
  return (
    <group>
      <Box size={[2.6, 0.1, 1.8]} position={[0, 0.05, 0]} color={PANEL} />
      {[-0.7, 0.7].map((x) => (
        <Box key={x} size={[1.0, 2.2, 0.9]} position={[x, 1.15, -0.2]} color={DARK} />
      ))}
      <group ref={leds}>
        {Array.from({ length: 12 }, (_, i) => (
          <Ball
            key={i}
            r={0.025}
            position={[
              (i % 2 ? 0.7 : -0.7) + ((i % 4) - 1.5) * 0.15,
              0.4 + Math.floor(i / 2) * 0.3,
              0.26,
            ]}
            color="#7fe3a8"
            emissive="#34c77b"
            emissiveIntensity={2}
            shadow={false}
            noGlow
          />
        ))}
      </group>
      <Slide open={open} animate={animate} to={[0, 0, 0.45]}>
        <Box size={[0.9, 0.12, 0.85]} position={[-0.7, 1.4, -0.15]} color="#5b6068" />
        {open && (
          <group position={[-0.7, 1.48, 0.1]}>
            <Papers width={0.5} depth={0.3} />
          </group>
        )}
      </Slide>
    </group>
  );
}

export const OFFICE_SET: RepresentationSet = {
  monitor: HoloTerminal,
  review: ReviewChamber,
  notes: PlanningWall,
  kpi: RadarScope,
  plant: Reactor,
  router: RoofAntenna,
  train: Monorail,
  printer: FabLab,
  ship: DockingBay,
  toolbox: ToolCart,
  cabinet: ServerRoom,
};
