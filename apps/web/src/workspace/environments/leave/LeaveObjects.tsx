import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MathUtils, type Group, type PointLight } from 'three';
import { growthStep, shipStageFor } from '@/core3d/shipStage';
import {
  Arrow,
  BoardFace,
  ellipsePath,
  GatewayPulse,
  Hinge,
  Mailbox,
  Papers,
  PathTrain,
  PrintRig,
  ReviewFace,
  Sail,
  StatusLights,
  useFloat,
} from '../../objects/kit';
import type { RepresentationProps, RepresentationSet } from '../../objects/representations';
import { useStoryBeat } from '../../world/useWorldEvents';
import { useCelebration } from '../../world/useCelebration';
import { TONE_COLOR } from '../../scene/palette';
import { Ball, Box, Cone, Cyl } from '../../scene/parts';
import { Beacon } from '../../objects/accessories';
import { TRAM } from './leaveLayout';

/**
 * LEAVE's eleven dashboard objects and its Code Review gateway: the same data as every other
 * world, told by a tropical island. Nothing here asks for attention: the gateway's events stay quiet on leave days
 * (`eventStrength`), only a merge may glow softly.
 */
const BAMBOO = '#c9a66b';
const DRIFT = '#9b7a5a';
const THATCH = '#d8b26e';

function BungalowMailbox({ data, animate }: RepresentationProps) {
  return (
    <Mailbox
      data={data}
      animate={animate}
      body="#3fa6a0"
      door="#358f8a"
      post={BAMBOO}
      roof={THATCH}
    />
  );
}

/**
 * Code Review: the Island Signal Station — a small coastal station with an ocean-facing MR status board,
 * a signal mast and a tiny repository lighthouse. Opens the one canonical Code Review route; never a pressure surface.
 */
function SignalStation({ data, stowed, animate, env }: RepresentationProps) {
  const lamp = useRef<PointLight>(null);
  const boost = useRef(0);
  useFrame((_, dt) => {
    boost.current = Math.max(0, boost.current - dt * 0.5);
    if (lamp.current) lamp.current.intensity = 0.4 + boost.current * 3;
  });
  return (
    <group>
      <Box size={[2.6, 0.2, 2.2]} position={[0, 0.1, 0]} color="#c9c1b3" />
      <Box size={[2.4, 2.0, 2.0]} position={[0, 1.2, -0.1]} color="#f4f1ea" />
      <Box size={[2.8, 0.14, 2.4]} position={[0, 2.27, -0.1]} color="#3f6b69" />
      {/* the ocean-facing status board */}
      <Box size={[1.5, 1.0, 0.08]} position={[0, 1.35, 0.95]} color="#2b2f36" />
      <group position={[0, 1.35, 1.0]}>
        <ReviewFace data={data} env={env} stowed={stowed} w={1.4} h={0.9} />
      </group>
      {/* the signal mast */}
      <Cyl r={0.05} h={2.4} position={[0.9, 3.5, -0.6]} color="#9aa3ad" />
      <Box size={[0.9, 0.04, 0.04]} position={[0.9, 4.2, -0.6]} color="#9aa3ad" />
      <Ball
        r={0.09}
        position={[0.9, 4.72, -0.6]}
        color="#fff6d8"
        emissive="#ffd890"
        emissiveIntensity={0.6}
        noGlow
      />
      {/* the repository lighthouse on the roof corner */}
      <group position={[-0.9, 2.34, 0.6]} scale={4}>
        <Beacon />
      </group>
      <pointLight
        ref={lamp}
        position={[-0.9, 3.2, 0.6]}
        intensity={0.4}
        distance={6}
        color="#ffd890"
      />
      <GatewayPulse
        data={data}
        env={env}
        animate={animate}
        radius={1.8}
        y={0.22}
        onEvent={(_, strength) => {
          boost.current = strength;
        }}
      />
    </group>
  );
}

function BeachHutBoard({ data, stowed }: RepresentationProps) {
  return (
    <group>
      {[-0.95, 0.95].map((x) => (
        <Cyl key={x} r={0.07} h={2.2} position={[x, 1.1, 0]} color={BAMBOO} />
      ))}
      <Box size={[1.9, 1.3, 0.06]} position={[0, 1.45, 0]} color={DRIFT} />
      <group position={[0, 1.45, 0.04]}>
        <BoardFace
          data={data}
          stowed={stowed}
          w={1.75}
          h={1.15}
          style={{ backing: '#e9d6a8', ink: '#3b2f25', heading: '#3b2f25' }}
        />
      </group>
      <Cone
        r={1.45}
        h={0.6}
        position={[0, 2.45, 0]}
        rotation={[0, Math.PI / 4, 0]}
        color={THATCH}
        segments={4}
      />
    </group>
  );
}

/** KPI: four coconut targets on posts, one per KPI: an arrow nearer the centre the nearer its target. */
function CoconutTargets({ data }: RepresentationProps) {
  return (
    <group>
      {data.darts.map((d, i) => (
        <group key={d.id} position={[(i - 1.5) * 0.85, 0, 0]}>
          <Cyl r={0.05} h={1.0} position={[0, 0.5, 0]} color={BAMBOO} />
          <group position={[0, 1.05, 0.02]}>
            <Ball r={0.26} detail={1} scale={[1, 1, 0.75]} color="#7a4a2a" />
            {[0.2, 0.13, 0.06].map((r, j) => (
              <mesh key={r} position={[0, 0, 0.2 + j * 0.002]}>
                <circleGeometry args={[r, 20]} />
                <meshStandardMaterial
                  color={['#efe3c8', '#d6453d', '#f6c94a'][j]}
                  userData={{ noGlow: true }}
                />
              </mesh>
            ))}
            <group position={[0, 0, 0.2]}>
              <Arrow d={d} radius={0.2} angle={Math.PI / 4 + i} length={0.45} />
            </group>
          </group>
          {d.score === null && (
            <Cyl
              r={0.012}
              h={0.5}
              position={[0.15, 0.25, 0.15]}
              rotation={[0.2, 0, 0.3]}
              color="#5b4636"
            />
          )}
        </group>
      ))}
    </group>
  );
}

/**
 * Overview: the large palm. It grows more fronds with release progress (CoreStage's thresholds), its coconuts turn
 * gold for the finale, and the whole crown glows warm when the release lands.
 */
function BigPalm({ data, animate }: RepresentationProps) {
  const step = growthStep(data.progress);
  const stage = shipStageFor(data.progress);
  const crown = useRef<Group>(null);
  const glow = useRef<PointLight>(null);
  useFrame(({ clock }, dt) => {
    if (crown.current && animate)
      crown.current.rotation.z = Math.sin(clock.elapsedTime * 0.8) * 0.03;
    if (glow.current) {
      const goal = stage === 'complete' ? 3 : stage === 'ignition' ? 1.6 : 0.3;
      glow.current.intensity = MathUtils.damp(glow.current.intensity, goal, 2, dt);
    }
  });
  const fronds = 3 + step * 2;
  const unknown = data.progress === null;
  const finale = stage === 'ignition' || stage === 'complete';
  return (
    <group>
      {/* a gently curving trunk */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Cyl
          key={i}
          r={0.2 - i * 0.015}
          rBottom={0.22 - i * 0.015}
          h={0.9}
          position={[i * 0.08, 0.45 + i * 0.85, 0]}
          rotation={[0, 0, -0.05 - i * 0.02]}
          color="#8b6a4a"
        />
      ))}
      <group ref={crown} position={[0.5, 5.4, 0]}>
        {Array.from({ length: fronds }, (_, i) => {
          const a = (i / fronds) * Math.PI * 2;
          return (
            <group key={i} rotation={[0, a, 0]}>
              <Box
                size={[0.5, 0.06, 2.4]}
                position={[0, -0.35, 1.1]}
                rotation={[0.45, 0, 0]}
                color={unknown ? '#a8b49a' : i % 2 ? '#3f8a4a' : '#4f9c50'}
              />
            </group>
          );
        })}
        {[0, 1, 2].map((i) => (
          <Ball
            key={i}
            r={0.18}
            position={[Math.cos(i * 2.1) * 0.3, -0.35, Math.sin(i * 2.1) * 0.3]}
            color={finale ? '#f6c94a' : '#6b4a2a'}
            emissive={finale ? '#f2a531' : '#000000'}
            emissiveIntensity={finale ? 0.8 : 0}
          />
        ))}
        <pointLight
          ref={glow}
          position={[0, 0.5, 1]}
          intensity={0.3}
          distance={8}
          color="#ffcf8a"
        />
      </group>
      {/* a ring of stones round its foot */}
      {Array.from({ length: 8 }, (_, i) => (
        <Ball
          key={i}
          r={0.18}
          position={[Math.cos(i * 0.785) * 0.7, 0.08, Math.sin(i * 0.785) * 0.7]}
          color="#b9ab95"
        />
      ))}
    </group>
  );
}

function RadioBeacon({ data, animate }: RepresentationProps) {
  const H = 5;
  return (
    <group>
      <Box size={[1.4, 0.3, 1.4]} position={[0, 0.15, 0]} color="#b9ab95" />
      {[
        [-0.4, -0.4],
        [0.4, -0.4],
        [-0.4, 0.4],
        [0.4, 0.4],
      ].map(([x, z]) => (
        <Box
          key={`${x}${z}`}
          size={[0.07, H, 0.07]}
          position={[x! * 0.5, H / 2, z! * 0.5]}
          rotation={[z! * 0.08, 0, -x! * 0.08]}
          color="#f4f1ea"
        />
      ))}
      {[1.2, 2.4, 3.6].map((y) => (
        <Box
          key={y}
          size={[0.6 - y * 0.06, 0.04, 0.6 - y * 0.06]}
          position={[0, y, 0]}
          color="#d6453d"
        />
      ))}
      <Cyl r={0.03} h={1.2} position={[0, H + 0.6, 0]} color="#d9d4cc" />
      <StatusLights
        tone={data.syncTone}
        running={data.syncRunning}
        animate={animate}
        points={[
          [0, H, 0.1],
          [0, H + 1.2, 0],
        ]}
      />
    </group>
  );
}

/** Release Train: the beach tram on its loop. It waits at its stop with nothing pending. */
function BeachTram({ data, animate }: RepresentationProps) {
  const path = ellipsePath(TRAM.rx, TRAM.rz, 0.12);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} scale={[TRAM.rx, TRAM.rz, 1]}>
        <ringGeometry args={[0.9, 1.1, 48]} />
        <meshStandardMaterial color="#b9ab95" flatShading />
      </mesh>
      <Box size={[1.2, 0.12, 0.5]} position={[0, 0.06, TRAM.rz + 0.5]} color={DRIFT} />
      <Cyl r={0.04} h={1.6} position={[0.5, 0.8, TRAM.rz + 0.6]} color={BAMBOO} />
      <Box size={[0.5, 0.3, 0.04]} position={[0.5, 1.5, TRAM.rz + 0.6]} color="#3fa6a0" />
      <PathTrain
        wagons={data.wagons}
        progress={data.progress}
        animate={animate}
        path={path}
        spacing={0.42}
        start={Math.PI / 2}
        head={
          <group>
            <Box size={[0.3, 0.22, 0.5]} position={[0, 0.12, 0]} color="#f2a531" />
            <Box size={[0.34, 0.04, 0.54]} position={[0, 0.42, 0]} color="#d6453d" />
            {[-0.13, 0.13].map((x) => (
              <Box key={x} size={[0.03, 0.2, 0.03]} position={[x, 0.32, 0.2]} color="#2b2f36" />
            ))}
          </group>
        }
        car={(i) => (
          <group>
            <Box size={[0.28, 0.16, 0.42]} position={[0, 0.1, 0]} color="#f4f1ea" />
            <Box
              size={[0.32, 0.03, 0.46]}
              position={[0, 0.36, 0]}
              color={i % 2 ? '#d6453d' : '#3fa6a0'}
            />
            {[-0.12, 0.12].map((x) => (
              <Box key={x} size={[0.025, 0.18, 0.025]} position={[x, 0.27, 0]} color="#2b2f36" />
            ))}
          </group>
        )}
      />
    </group>
  );
}

function ArtisanPrinter({ data, animate }: RepresentationProps) {
  return (
    <group>
      {/* a bamboo table under a little shade */}
      <Box size={[1.4, 0.08, 0.8]} position={[0, 0.82, 0]} color={DRIFT} />
      {[-0.6, 0.6].map((x) => (
        <Cyl key={x} r={0.05} h={0.82} position={[x, 0.41, 0]} color={BAMBOO} />
      ))}
      {[-0.7, 0.7].map((x) => (
        <Cyl key={`p${x}`} r={0.04} h={2.2} position={[x, 1.1, -0.45]} color={BAMBOO} />
      ))}
      <Box
        size={[1.7, 0.08, 1.2]}
        position={[0, 2.2, -0.2]}
        rotation={[0.15, 0, 0]}
        color={THATCH}
      />
      <group position={[0, 0.86, 0]}>
        <PrintRig data={data} animate={animate} color="#3fa6a0" />
      </group>
    </group>
  );
}

/** Sprint Harbor: the sailboat moored at the pier; its sail rises with the sprint. */
function Sailboat({ data, animate, env }: RepresentationProps) {
  const ref = useRef<Group>(null);
  const voyage = useRef<Group>(null);
  useFloat(ref, animate, 0.05);
  // At 100% the sailboat raises its sails, sails off towards the bright horizon and comes back; a merge
  // sends it a little way out and back.
  const celebration = useCelebration(data.progress, animate);
  const outing = useRef(0);
  useStoryBeat({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    beat: 'sail-out',
    onBeat: () => {
      outing.current = 1;
    },
  });
  useFrame((_, dt) => {
    const party = celebration.tick(dt);
    outing.current = Math.max(0, outing.current - dt * 0.25);
    const out =
      party !== null ? Math.sin(party * Math.PI) * 26 : Math.sin(outing.current * Math.PI) * 6;
    voyage.current?.position.set(0, 0, out);
  });
  return (
    <group ref={voyage}>
      <group ref={ref}>
        <Box size={[1.0, 0.4, 2.6]} position={[0, 0.15, 0]} color="#f4f1ea" />
        <Cone
          r={0.5}
          h={0.7}
          position={[0, 0.15, 1.65]}
          rotation={[Math.PI / 2, 0, 0]}
          color="#f4f1ea"
          segments={4}
        />
        <Box size={[0.9, 0.05, 2.4]} position={[0, 0.37, 0]} color="#c39b6b" />
        <Box size={[1.02, 0.06, 2.62]} position={[0, -0.03, 0]} color="#d6453d" />
        <Cyl r={0.045} h={3.2} position={[0, 1.95, 0.25]} color="#5b4636" />
        <Box size={[0.035, 0.035, 1.3]} position={[0, 0.7, -0.4]} color="#5b4636" />
        <Sail
          fill={data.sprintFill}
          animate={animate}
          height={2.7}
          foot={1.3}
          position={[0.03, 0.72, 0.22]}
        />
      </group>
    </group>
  );
}

/** Settings: the equipment chest (snorkel and fins on top). */
function EquipmentChest() {
  return (
    <group>
      <Box size={[0.8, 0.4, 0.45]} position={[0, 0.2, 0]} color="#3f6b8a" />
      <Box size={[0.84, 0.06, 0.49]} position={[0, 0.42, 0]} color="#335a75" />
      {[-0.42, 0.42].map((x) => (
        <Box key={x} size={[0.04, 0.12, 0.2]} position={[x, 0.3, 0]} color={BAMBOO} />
      ))}
      <Box
        size={[0.24, 0.03, 0.12]}
        position={[-0.15, 0.47, 0]}
        rotation={[0, 0.3, 0]}
        color="#f2a531"
      />
      <Box
        size={[0.24, 0.03, 0.12]}
        position={[0.05, 0.47, 0.06]}
        rotation={[0, -0.2, 0]}
        color="#f2a531"
      />
      <Cyl
        r={0.02}
        h={0.32}
        position={[0.25, 0.5, -0.05]}
        rotation={[0, 0, Math.PI / 2]}
        color="#d6453d"
      />
    </group>
  );
}

/** Audit: the treasure archive chest; its lid opens while there are writes that can be undone. */
function TreasureChest({ data, animate }: RepresentationProps) {
  const open = data.undoable > 0;
  return (
    <group>
      <Box size={[0.9, 0.45, 0.55]} position={[0, 0.225, 0]} color="#7a4a2a" />
      {[-0.3, 0.3].map((x) => (
        <Box
          key={x}
          size={[0.06, 0.47, 0.57]}
          position={[x, 0.225, 0]}
          color="#c9a227"
          metalness={0.6}
        />
      ))}
      {open && (
        <group position={[0, 0.42, 0.02]}>
          <Papers width={0.6} depth={0.36} />
          <Ball
            r={0.05}
            position={[0.25, 0.04, 0.1]}
            color="#f6c94a"
            emissive="#f2a531"
            emissiveIntensity={0.6}
            shadow={false}
          />
        </group>
      )}
      <Hinge open={open} animate={animate} angle={-1.1} position={[0, 0.45, -0.275]}>
        <Box size={[0.92, 0.12, 0.57]} position={[0, 0.06, 0.285]} color="#8a5a3b" />
        <Box size={[0.12, 0.08, 0.04]} position={[0, 0.0, 0.57]} color="#c9a227" metalness={0.6} />
      </Hinge>
      <Ball r={0.035} position={[0, 0.33, 0.29]} color={TONE_COLOR.idle} shadow={false} />
    </group>
  );
}

export const LEAVE_SET: RepresentationSet = {
  monitor: BungalowMailbox,
  review: SignalStation,
  notes: BeachHutBoard,
  kpi: CoconutTargets,
  plant: BigPalm,
  router: RadioBeacon,
  train: BeachTram,
  printer: ArtisanPrinter,
  ship: Sailboat,
  toolbox: EquipmentChest,
  cabinet: TreasureChest,
};
