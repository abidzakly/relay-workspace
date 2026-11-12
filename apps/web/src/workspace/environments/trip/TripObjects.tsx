import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  DoubleSide,
  MathUtils,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type PointLight,
} from 'three';
import { growthStep, shipStageFor } from '@/core3d/shipStage';
import {
  BoardFace,
  GatewayPulse,
  PathTrain,
  PrintRig,
  ReviewFace,
  Sail,
  scoreRadius,
  shuttlePath,
  Slide,
  StatusLights,
  useFloat,
  Papers,
} from '../../objects/kit';
import type { RepresentationProps, RepresentationSet } from '../../objects/representations';
import { useStoryBeat } from '../../world/useWorldEvents';
import { useCelebration } from '../../world/useCelebration';
import { useCanvasTexture } from '../../scene/Interactive';
import { Led } from '../../scene/DeskSet';
import { TONE_COLOR } from '../../scene/palette';
import { Ball, Box, Cone, Cyl, Panel } from '../../scene/parts';
import { screenTexture } from '../../scene/textures';
import { SHUTTLE } from './tripLayout';

/**
 * TRIP's eleven dashboard objects and its Code Review gateway: an airport-and-harbour island
 * telling the same data as every other world.
 */
const STEEL = '#9aa3ad';
const NAVY = '#22303f';
const CORAL = '#f2683c';

/** MR Inbox: the airport information terminal, its screen a miniature MR Inbox. */
function InfoTerminal({ data, stowed }: RepresentationProps) {
  const map = useCanvasTexture(
    () => screenTexture(data, stowed),
    `${stowed}|${data.mrTitles.join('\u0000')}|${data.signals.monitor.badge}`,
  );
  const sig = data.signals.monitor;
  return (
    <group>
      <Box size={[0.9, 0.12, 0.6]} position={[0, 0.06, 0]} color={STEEL} />
      <Box size={[0.5, 1.2, 0.35]} position={[0, 0.72, -0.05]} color={NAVY} />
      <group position={[0, 1.45, 0]} rotation={[-0.15, 0, 0]}>
        <Box size={[0.98, 0.66, 0.08]} color={NAVY} />
        <Panel size={[0.9, 0.58]} map={map} position={[0, 0, 0.045]} glow={stowed ? 0.25 : 0.95} />
      </group>
      <Box size={[0.98, 0.16, 0.1]} position={[0, 1.88, -0.03]} color="#2fa5b8" />
      <Led position={[0.42, 1.88, 0.03]} color={TONE_COLOR[sig.tone]} on={sig.tone !== 'idle'} />
    </group>
  );
}

/**
 * Code Review: the Engineering Dispatch Terminal. A flight-style board of the reviews requested of me,
 * departure gates, and a small conveyor that carries change packages while reviews are waiting.
 */
function DispatchTerminal({ data, stowed, animate, env }: RepresentationProps) {
  const belt = useRef<Group>(null);
  const waiting = data.reviews.count > 0 && !stowed;
  useFrame((_, dt) => {
    const g = belt.current;
    if (!g || !animate || !waiting) return;
    g.children.forEach((c) => {
      c.position.x += Math.min(dt, 0.1) * 0.45;
      if (c.position.x > 1.3) c.position.x = -1.3;
    });
  });
  return (
    <group>
      <Box size={[3.2, 0.15, 2.0]} position={[0, 0.075, 0]} color="#c9c1b3" />
      {/* the departure board */}
      {[-1.4, 1.4].map((x) => (
        <Box key={x} size={[0.12, 2.9, 0.12]} position={[x, 1.45, -0.6]} color={STEEL} />
      ))}
      <Box size={[2.9, 1.5, 0.12]} position={[0, 2.25, -0.6]} color={NAVY} />
      <group position={[0, 2.25, -0.53]}>
        <ReviewFace data={data} env={env} stowed={stowed} w={2.7} h={1.3} />
      </group>
      {/* gates, as review stages: arrival, boarding, departure */}
      {['ARR', 'BRD', 'DEP'].map((g, i) => (
        <group key={g} position={[-1.0 + i, 0.15, 0.6]}>
          <Box size={[0.1, 1.1, 0.1]} position={[-0.3, 0.55, 0]} color={STEEL} />
          <Box size={[0.1, 1.1, 0.1]} position={[0.3, 0.55, 0]} color={STEEL} />
          <Box
            size={[0.7, 0.18, 0.1]}
            position={[0, 1.15, 0]}
            color={i === 1 && waiting ? '#ffd36b' : '#2b2f36'}
            emissive={i === 1 && waiting ? '#ffb000' : '#000000'}
            emissiveIntensity={i === 1 && waiting ? 1.2 : 0}
            noGlow
          />
        </group>
      ))}
      {/* the conveyor of change packages */}
      <Box size={[2.8, 0.1, 0.5]} position={[0, 0.55, 0.05]} color="#3b3f46" />
      <group ref={belt} position={[0, 0.66, 0.05]}>
        {Array.from({ length: Math.min(4, data.reviews.count) }, (_, i) => (
          <Box
            key={i}
            size={[0.24, 0.16, 0.24]}
            position={[-1.2 + i * 0.7, 0, 0]}
            color={['#c39b6b', '#d6b98a', '#a8825c'][i % 3]}
          />
        ))}
      </group>
      <GatewayPulse data={data} env={env} animate={animate} radius={1.8} y={0.17} />
    </group>
  );
}

/** Board: the travel itinerary board, a departures-style dark board of columns and cards. */
function ItineraryBoard({ data, stowed, animate, env }: RepresentationProps) {
  // A new request or an approval flips the board for a moment, like a departures board updating.
  const face = useRef<Group>(null);
  const flip = useRef(0);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'board-update',
    onBeat: () => {
      flip.current = 1;
    },
  });
  useFrame((_, dt) => {
    flip.current = Math.max(0, flip.current - dt * 1.5);
    if (face.current) face.current.rotation.x = Math.sin(flip.current * Math.PI) * 0.6;
  });
  return (
    <group>
      {[-1.1, 1.1].map((x) => (
        <Box key={x} size={[0.12, 2.4, 0.12]} position={[x, 1.2, 0]} color={STEEL} />
      ))}
      <Box size={[2.3, 1.5, 0.1]} position={[0, 1.6, 0]} color={NAVY} />
      <group ref={face} position={[0, 1.6, 0.06]}>
        <BoardFace
          data={data}
          stowed={stowed}
          w={2.15}
          h={1.35}
          glow={0.8}
          style={{ backing: '#1d2633', ink: '#1d2633', heading: '#ffd36b' }}
        />
      </group>
      <Box size={[2.3, 0.22, 0.12]} position={[0, 2.46, 0]} color={CORAL} />
    </group>
  );
}

/**
 * KPI: the destination compass. Four needles, one per KPI, at the four headings: a needle reaches the rim when its
 * target is met and is shorter the further off it is; a KPI with nothing to measure has no needle, just its cap.
 */
function DestinationCompass({ data }: RepresentationProps) {
  const R = 0.9;
  return (
    <group>
      <Cyl r={0.5} rBottom={0.6} h={0.7} position={[0, 0.35, 0]} color="#c9c1b3" segments={8} />
      <group position={[0, 0.78, 0]} rotation={[-0.35, 0, 0]}>
        <Cyl r={R + 0.08} h={0.1} color="#c9a227" metalness={0.5} segments={24} />
        <Cyl r={R} h={0.11} color="#f4f1ea" segments={24} />
        {/* the rose */}
        {[0, 1, 2, 3].map((i) => (
          <Box
            key={i}
            size={[0.05, 0.005, R * 2]}
            position={[0, 0.06, 0]}
            rotation={[0, (i * Math.PI) / 4, 0]}
            color="#d9d4cc"
            shadow={false}
          />
        ))}
        {data.darts.map((d, i) => {
          const r = scoreRadius(d, R);
          const len = r === null ? 0 : R * 0.92 - r;
          const a = (i * Math.PI) / 2;
          return (
            <group key={d.id} rotation={[0, -a, 0]}>
              {len > 0.02 && (
                <Box
                  size={[0.07, 0.03, len]}
                  position={[0, 0.08, -len / 2]}
                  color={['#d6453d', '#3f7ad9', '#34c77b', '#f2a531'][i]}
                  shadow={false}
                />
              )}
              <Ball r={0.05} position={[0, 0.08, -R * 0.92]} color="#2b2f36" shadow={false} />
            </group>
          );
        })}
        <Ball r={0.07} position={[0, 0.1, 0]} color="#c9a227" metalness={0.5} />
      </group>
    </group>
  );
}

/**
 * Overview: the lighthouse. Its lamp burns brighter with release progress (CoreStage's thresholds); from the moment
 * the ship is assembled its beam turns; at 100% the beam sweeps bright across the island.
 */
function Lighthouse({ data, animate }: RepresentationProps) {
  const beam = useRef<Group>(null);
  const lamp = useRef<PointLight>(null);
  const stage = shipStageFor(data.progress);
  const step = growthStep(data.progress);
  const turning = stage === 'assembled' || stage === 'ignition' || stage === 'complete';
  const intensity =
    data.progress === null ? 0.1 : 0.3 + step * 0.45 + (stage === 'complete' ? 1.2 : 0);
  // At 100% the beam sweeps bright and fast across the island and up to the ship.
  const celebration = useCelebration(data.progress, animate);
  useFrame((_, dt) => {
    const party = celebration.tick(dt);
    if (beam.current) {
      const speed = party !== null ? 3.2 : stage === 'complete' ? 1.4 : 0.6;
      if (animate && (turning || party !== null))
        beam.current.rotation.y += Math.min(dt, 0.1) * speed;
      beam.current.rotation.x = party !== null ? -Math.sin(party * Math.PI) * 0.35 : 0;
      beam.current.visible = turning || party !== null;
      const m = (beam.current.children[0] as Mesh | undefined)?.material as
        MeshBasicMaterial | undefined;
      if (m) m.opacity = party !== null ? 0.45 : stage === 'complete' ? 0.3 : 0.14;
    }
    if (lamp.current)
      lamp.current.intensity = MathUtils.damp(lamp.current.intensity, intensity * 2, 2, dt);
  });
  return (
    <group>
      <Cyl r={1.6} h={0.6} position={[0, 0.3, 0]} color="#a0968a" segments={10} />
      {[0, 1, 2, 3, 4].map((i) => (
        <Cyl
          key={i}
          r={1.0 - i * 0.1}
          rBottom={1.1 - i * 0.1}
          h={1.5}
          position={[0, 1.35 + i * 1.5, 0]}
          color={i % 2 ? CORAL : '#f4f1ea'}
          segments={10}
        />
      ))}
      <Cyl r={0.95} h={0.12} position={[0, 8.1, 0]} color="#2b2f36" segments={10} />
      <Cyl
        r={0.55}
        h={0.9}
        position={[0, 8.6, 0]}
        color="#fff6d8"
        emissive="#ffd890"
        emissiveIntensity={intensity}
        transparent
        opacity={0.9}
        noGlow
      />
      <Cone r={0.7} h={0.7} position={[0, 9.4, 0]} color="#2b2f36" />
      <pointLight
        ref={lamp}
        position={[0, 8.6, 0.6]}
        intensity={0.2}
        distance={14}
        color="#ffe0a0"
      />
      <group ref={beam} position={[0, 8.6, 0]} visible={turning}>
        <mesh position={[0, 0, 9]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[2, 18, 12, 1, true]} />
          <meshBasicMaterial
            color="#fff2c8"
            transparent
            opacity={0.14}
            depthWrite={false}
            side={DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

function RadioTower({ data, animate }: RepresentationProps) {
  const H = 6;
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
          color="#f4f1ea"
        />
      ))}
      {[1, 2, 3, 4, 5].map((y) => (
        <Box
          key={y}
          size={[0.9 - y * 0.1, 0.05, 0.9 - y * 0.1]}
          position={[0, y * 1.05, 0]}
          color={y % 2 ? CORAL : '#f4f1ea'}
        />
      ))}
      <group position={[0.3, H - 0.8, 0.3]} rotation={[0.4, 0.5, 0]}>
        <Cyl
          r={0.5}
          rBottom={0.06}
          h={0.2}
          rotation={[Math.PI / 2, 0, 0]}
          color="#e8e4dc"
          segments={12}
        />
      </group>
      <Cyl r={0.03} h={1.4} position={[0, H + 0.7, 0]} color="#d9d4cc" />
      <StatusLights
        tone={data.syncTone}
        running={data.syncRunning}
        animate={animate}
        points={[
          [0, H - 0.2, 0.15],
          [0, H + 0.4, 0.15],
          [0, H + 1.35, 0],
        ]}
      />
    </group>
  );
}

/** Release Train: the terminal shuttle on its elevated line; it waits at the platform with nothing pending. */
function TerminalShuttle({ data, animate, env }: RepresentationProps) {
  // A merge sends the shuttle off on one departure, even with nothing pending.
  const burst = useRef(0);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'shuttle-depart',
    onBeat: () => {
      burst.current = 6;
    },
  });
  const a = SHUTTLE.a;
  const b = SHUTTLE.b;
  // The layout places this object at the line's middle: draw the line relative to it.
  const mx = (a[0] + b[0]) / 2;
  const local = (p: readonly [number, number, number]) =>
    [p[0] - mx, 0.9, 0] as [number, number, number];
  const path = shuttlePath(local(a), local(b));
  const len = b[0] - a[0];
  return (
    <group>
      <Box size={[len + 1, 0.2, 0.8]} position={[0, 0.8, 0]} color="#c9c1b3" />
      {Array.from({ length: 6 }, (_, i) => (
        <Cyl key={i} r={0.14} h={0.8} position={[-len / 2 + (i * len) / 5, 0.4, 0]} color={STEEL} />
      ))}
      <Box size={[1.6, 0.15, 1.2]} position={[local(b)[0] - 0.5, 0.95, 0.9]} color="#d9d4cc" />
      <PathTrain
        wagons={data.wagons}
        progress={data.progress}
        animate={animate}
        path={(t) => {
          const p = path(t);
          return { ...p, y: 1.0, yaw: Math.PI / 2 };
        }}
        spacing={0.14}
        start={0}
        burst={burst}
        head={
          <group>
            <Box size={[0.5, 0.45, 1.1]} position={[0, 0.25, 0]} color="#f4f1ea" />
            <Box size={[0.52, 0.16, 1.12]} position={[0, 0.35, 0]} color="#2fa5b8" />
            <Box
              size={[0.4, 0.15, 0.05]}
              position={[0, 0.35, 0.56]}
              color="#bfe6ff"
              emissive="#7fd0ff"
              emissiveIntensity={0.4}
              noGlow
            />
          </group>
        }
        car={() => (
          <group>
            <Box size={[0.5, 0.4, 1.0]} position={[0, 0.22, 0]} color="#f4f1ea" />
            <Box size={[0.52, 0.12, 1.02]} position={[0, 0.3, 0]} color="#2fa5b8" />
          </group>
        )}
      />
    </group>
  );
}

function HangarPrinter({ data, animate }: RepresentationProps) {
  return (
    <group>
      <Box size={[1.4, 0.9, 0.8]} position={[0, 0.45, 0]} color={STEEL} />
      <Box size={[1.45, 0.06, 0.85]} position={[0, 0.92, 0]} color="#5b6068" />
      <group position={[0, 0.95, 0]}>
        <PrintRig data={data} animate={animate} color={CORAL} />
      </group>
      <Box size={[0.3, 0.3, 0.3]} position={[0.5, 1.1, 0.15]} color="#f2a531" />
    </group>
  );
}

/**
 * Sprint Harbor: the harbour ferry, rocking at its dock. A pennant climbs the mast with the sprint's progress, and
 * one cabin window lights per fifth of it.
 */
function Ferry({ data, animate }: RepresentationProps) {
  const ref = useRef<Group>(null);
  useFloat(ref, animate, 0.03);
  const fill = data.sprintFill;
  const lit = fill === null ? 0 : Math.round(fill * 5);
  return (
    <group ref={ref}>
      <Box size={[2.2, 0.8, 5.2]} position={[0, 0.3, 0]} color="#f4f1ea" />
      <Box size={[2.24, 0.2, 5.24]} position={[0, -0.05, 0]} color={NAVY} />
      <Cone
        r={1.1}
        h={1.2}
        position={[0, 0.3, 3.2]}
        rotation={[Math.PI / 2, 0, 0]}
        color="#f4f1ea"
        segments={4}
      />
      <Box size={[1.8, 0.9, 2.8]} position={[0, 1.15, -0.4]} color="#f4f1ea" />
      {Array.from({ length: 5 }, (_, i) => (
        <Box
          key={i}
          size={[0.02, 0.32, 0.4]}
          position={[0.91, 1.2, -1.5 + i * 0.55]}
          color={i < lit ? '#fff1c9' : '#4a5563'}
          emissive={i < lit ? '#ffc861' : '#000000'}
          emissiveIntensity={i < lit ? 1.2 : 0}
          noGlow
        />
      ))}
      <Box size={[1.4, 0.5, 1.2]} position={[0, 1.85, 0.2]} color="#2fa5b8" />
      <Cyl r={0.05} h={2.4} position={[0, 2.9, -1.2]} color={STEEL} />
      {/* the pennant: its height is the sprint */}
      <Sail
        fill={fill}
        animate={animate}
        height={1.8}
        foot={0.7}
        color={CORAL}
        position={[0.04, 1.95, -1.2]}
      />
    </group>
  );
}

/** Settings: the travel equipment kiosk (lockers, a luggage trolley). */
function EquipmentKiosk() {
  return (
    <group>
      <Box size={[1.6, 1.6, 0.9]} position={[0, 0.8, 0]} color="#2fa5b8" />
      <Box size={[1.8, 0.12, 1.1]} position={[0, 1.66, 0]} color={CORAL} />
      {[0, 1, 2].flatMap((c) =>
        [0, 1].map((r) => (
          <Box
            key={`${c}${r}`}
            size={[0.44, 0.6, 0.04]}
            position={[-0.5 + c * 0.5, 0.45 + r * 0.66, 0.46]}
            color="#f4f1ea"
          />
        )),
      )}
      <group position={[1.2, 0, 0.4]}>
        <Box size={[0.45, 0.04, 0.7]} position={[0, 0.2, 0]} color={STEEL} />
        <Box size={[0.35, 0.5, 0.5]} position={[0, 0.48, 0]} color="#d6453d" />
        <Box size={[0.03, 0.9, 0.03]} position={[0, 0.65, -0.33]} color={STEEL} />
      </group>
    </group>
  );
}

/** Audit: the customs archive office. Its archive drawer slides out while writes can be undone. */
function CustomsOffice({ data, animate }: RepresentationProps) {
  const open = data.undoable > 0;
  return (
    <group>
      <Box size={[2.2, 2.2, 1.8]} position={[0, 1.1, -0.2]} color="#e8e4dc" />
      <Box size={[2.4, 0.15, 2.0]} position={[0, 2.27, -0.2]} color={NAVY} />
      <Box
        size={[1.6, 0.6, 0.1]}
        position={[0, 1.5, 0.71]}
        color="#bfe6ff"
        transparent
        opacity={0.5}
      />
      <Box size={[0.9, 1.2, 0.5]} position={[0, 0.6, 0.65]} color="#7b7f86" />
      <Slide open={open} animate={animate} to={[0, 0, 0.35]}>
        <Box size={[0.8, 0.3, 0.46]} position={[0, 1.02, 0.67]} color="#9aa3ad" />
        {open && (
          <group position={[0, 1.2, 0.67]}>
            <Papers width={0.6} depth={0.3} />
          </group>
        )}
      </Slide>
    </group>
  );
}

export const TRIP_SET: RepresentationSet = {
  monitor: InfoTerminal,
  review: DispatchTerminal,
  notes: ItineraryBoard,
  kpi: DestinationCompass,
  plant: Lighthouse,
  router: RadioTower,
  train: TerminalShuttle,
  printer: HangarPrinter,
  ship: Ferry,
  toolbox: EquipmentKiosk,
  cabinet: CustomsOffice,
};
