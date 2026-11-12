import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MathUtils, type Group, type Mesh, type MeshBasicMaterial, type PointLight } from 'three';
import { growthStep, shipStageFor } from '@/core3d/shipStage';
import {
  BoardFace,
  GatewayPulse,
  Hinge,
  Mailbox,
  Papers,
  PathTrain,
  PrintRig,
  ReviewFace,
  Sail,
  shuttlePath,
  StatusLights,
  useFloat,
} from '../../objects/kit';
import type { RepresentationProps, RepresentationSet } from '../../objects/representations';
import { useCelebration } from '../../world/useCelebration';
import { Ball, Box, Cone, Cyl } from '../../scene/parts';
import { TeaCup } from '../../objects/accessories';
import { FUNICULAR } from './sickLayout';

/**
 * SICK's eleven dashboard objects and its Code Review gateway. The same data as every world,
 * told softly: warm wood, low light, nothing blinking for attention. The review cabin is there if wanted; its events
 * stay silent on a sick day (`eventStrength`), only a merge glows faintly.
 */
const WOOD = '#8a5f3f';
const WOOD_DARK = '#5a4a44';
const STONE = '#9a958c';
const LAVENDER = '#b7a6d6';

function CabinMailbox({ data, animate }: RepresentationProps) {
  return (
    <Mailbox
      data={data}
      animate={animate}
      body="#6b5a7a"
      door="#5a4a68"
      post={WOOD_DARK}
      roof={WOOD}
    />
  );
}

/**
 * Code Review: the Quiet Review Cabin — a compact reading space: a wooden desk under a big window, a
 * minimal terminal with the reviews requested of me, a warm lamp, a small document archive and a cup of tea. It never
 * calls for attention.
 */
function ReviewCabin({ data, stowed, animate, env }: RepresentationProps) {
  const lamp = useRef<PointLight>(null);
  const glow = useRef(0);
  useFrame((_, dt) => {
    glow.current = Math.max(0, glow.current - dt * 0.4);
    if (lamp.current) lamp.current.intensity = 1.0 + glow.current * 1.5;
  });
  const W = 3.2;
  const D = 2.8;
  const H = 2.4;
  return (
    <group>
      <Box size={[W, 0.14, D]} position={[0, 0.07, 0]} color="#9b7a5a" />
      <Box size={[W, H, 0.14]} position={[0, H / 2, -D / 2]} color={WOOD} />
      <Box size={[0.14, H, D]} position={[-W / 2, H / 2, 0]} color={WOOD} />
      <Box size={[0.14, H, D]} position={[W / 2, H / 2, 0]} color={WOOD} />
      {/* the big window, onto the lake */}
      <Box
        size={[1.8, 1.1, 0.05]}
        position={[0.3, 1.5, -D / 2 + 0.09]}
        color="#bcd6e6"
        emissive="#dfe8ff"
        emissiveIntensity={0.25}
        transparent
        opacity={0.7}
        noGlow
      />
      <Cone
        r={(W + 0.6) * 0.75}
        h={1.3}
        position={[0, H + 0.6, 0]}
        rotation={[0, Math.PI / 4, 0]}
        color="#6b4a3a"
        segments={4}
      />
      {/* the desk, a minimal terminal, tea */}
      <Box size={[1.6, 0.07, 0.7]} position={[0.3, 0.8, -0.6]} color="#c39b6b" />
      {[-0.4, 1.0].map((x) => (
        <Box key={x} size={[0.07, 0.76, 0.6]} position={[x, 0.4, -0.6]} color={WOOD_DARK} />
      ))}
      <group position={[0.3, 0.84, -0.7]} rotation={[-0.25, 0, 0]}>
        <Box size={[0.66, 0.46, 0.03]} position={[0, 0.27, 0]} color="#2b2f36" />
        <group position={[0, 0.27, 0.017]}>
          <ReviewFace data={data} env={env} stowed={stowed} w={0.62} h={0.42} />
        </group>
      </group>
      <group position={[0.95, 0.84, -0.45]} scale={2}>
        <TeaCup />
      </group>
      {/* the small document archive */}
      <Box size={[0.7, 1.4, 0.4]} position={[-1.1, 0.7, -0.9]} color={WOOD_DARK} />
      {[0.35, 0.75, 1.15].map((y) => (
        <Box key={y} size={[0.6, 0.18, 0.3]} position={[-1.1, y, -0.78]} color="#efe3c8" />
      ))}
      <pointLight
        ref={lamp}
        position={[0.8, 1.5, -0.3]}
        intensity={1.0}
        distance={4}
        color="#ffc98a"
      />
      <GatewayPulse
        data={data}
        env={env}
        animate={animate}
        radius={1.5}
        y={0.16}
        onEvent={(_, strength) => {
          glow.current = strength;
        }}
      />
    </group>
  );
}

function WoodenBoard({ data, stowed }: RepresentationProps) {
  return (
    <group>
      {[-0.95, 0.95].map((x) => (
        <Box key={x} size={[0.12, 2.1, 0.12]} position={[x, 1.05, 0]} color={WOOD_DARK} />
      ))}
      <Box size={[1.85, 1.25, 0.08]} position={[0, 1.45, 0]} color={WOOD} />
      <group position={[0, 1.45, 0.045]}>
        <BoardFace
          data={data}
          stowed={stowed}
          w={1.7}
          h={1.1}
          style={{ backing: '#b98e62', ink: '#3b2f25', heading: '#3b2f25' }}
        />
      </group>
      <Box
        size={[2.1, 0.12, 0.3]}
        position={[0, 2.16, 0.04]}
        rotation={[0.25, 0, 0]}
        color="#6b4a3a"
      />
    </group>
  );
}

/**
 * KPI: four meditation stones on raked sand. Each cairn is stacked one stone higher per quarter of its KPI's target,
 * four stones when met; a KPI with nothing to measure keeps a single flat base stone.
 */
export const cairnHeight = (score: number | null): number =>
  score === null ? 0 : Math.max(1, Math.min(4, Math.round(score * 4)));

function MeditationStones({ data }: RepresentationProps) {
  return (
    <group>
      <Cyl r={1.9} h={0.06} position={[0, 0.03, 0]} color="#e2dccd" segments={24} />
      {[1.3, 1.6].map((r) => (
        <mesh key={r} position={[0, 0.065, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r - 0.02, r, 40]} />
          <meshStandardMaterial color="#cfc7b6" />
        </mesh>
      ))}
      {data.darts.map((d, i) => {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        const n = cairnHeight(d.score);
        return (
          <group key={d.id} position={[Math.cos(a) * 0.85, 0.06, Math.sin(a) * 0.85]}>
            <Ball r={0.26} position={[0, 0.08, 0]} scale={[1.2, 0.4, 1]} color={STONE} />
            {Array.from({ length: n }, (_, k) => (
              <Ball
                key={k}
                r={0.2 - k * 0.03}
                position={[0, 0.22 + k * 0.2, 0]}
                scale={[1.1, 0.55, 1]}
                color={['#a8a196', '#b5ada0', '#8f887d', '#c2b9ab'][k]}
              />
            ))}
          </group>
        );
      })}
    </group>
  );
}

/**
 * Overview: the ancient glowing tree. Its glow deepens with release progress (CoreStage's thresholds) and, at 100%,
 * soft golden light spreads from it into the forest.
 */
function AncientTree({ data, animate }: RepresentationProps) {
  const step = growthStep(data.progress);
  const stage = shipStageFor(data.progress);
  const light = useRef<PointLight>(null);
  const motes = useRef<Group>(null);
  // At 100% soft golden light spreads from the tree through the forest: a slow ring on the ground.
  const celebration = useCelebration(data.progress, animate);
  const halo = useRef<Mesh>(null);
  useFrame(({ clock }, dt) => {
    const party = celebration.tick(dt);
    const h = halo.current;
    if (h) {
      h.visible = party !== null;
      if (party !== null) {
        h.scale.setScalar(1 + party * 18);
        (h.material as MeshBasicMaterial).opacity = (1 - party) * 0.45;
      }
    }
    const goal = data.progress === null ? 0.2 : 0.4 + step * 0.5 + (stage === 'complete' ? 2.5 : 0);
    if (light.current) {
      light.current.intensity = MathUtils.damp(light.current.intensity, goal, 1.5, dt);
      light.current.distance = MathUtils.damp(
        light.current.distance,
        stage === 'complete' ? 22 : 9,
        1,
        dt,
      );
    }
    if (motes.current && animate)
      motes.current.children.forEach((m, i) => {
        m.position.y = 2.2 + ((clock.elapsedTime * 0.2 + i * 0.37) % 1) * 2.6;
      });
  });
  const lit = stage === 'complete' ? '#ffd27a' : '#c8f0a8';
  return (
    <group>
      <mesh ref={halo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]} visible={false}>
        <ringGeometry args={[0.8, 1.1, 48]} />
        <meshBasicMaterial
          color="#ffd27a"
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* a broad, gnarled trunk with roots */}
      <Cyl r={0.45} rBottom={0.8} h={2.4} position={[0, 1.2, 0]} color="#5a4a3a" segments={7} />
      {[0, 1, 2, 3, 4].map((i) => (
        <Box
          key={i}
          size={[0.25, 0.25, 1.4]}
          position={[Math.cos(i * 1.26) * 0.8, 0.12, Math.sin(i * 1.26) * 0.8]}
          rotation={[0, -i * 1.26 + Math.PI / 2, 0.15]}
          color="#5a4a3a"
        />
      ))}
      <Cyl
        r={0.18}
        rBottom={0.3}
        h={1.6}
        position={[-0.6, 2.8, 0]}
        rotation={[0, 0, 0.6]}
        color="#5a4a3a"
      />
      <Cyl
        r={0.18}
        rBottom={0.3}
        h={1.6}
        position={[0.6, 2.9, 0.1]}
        rotation={[0, 0, -0.55]}
        color="#5a4a3a"
      />
      {/* a canopy of glowing leaves: more lit clusters as progress grows */}
      {[
        [0, 3.9, 0],
        [-1.3, 3.5, 0.3],
        [1.3, 3.6, -0.2],
        [-0.5, 4.5, -0.5],
        [0.7, 4.4, 0.5],
        [0, 3.4, 1.0],
      ].map((p, i) => (
        <Ball
          key={i}
          r={1.0}
          detail={0}
          position={p as [number, number, number]}
          scale={[1.2, 0.7, 1.1]}
          color={i < 2 + step ? '#7aa86a' : '#5f7f5a'}
          emissive={i < 2 + step ? lit : '#000000'}
          emissiveIntensity={i < 2 + step ? 0.25 + step * 0.08 : 0}
        />
      ))}
      <group ref={motes}>
        {Array.from({ length: 2 + step * 2 }, (_, i) => (
          <Ball
            key={i}
            r={0.05}
            position={[Math.cos(i * 2.4) * 1.4, 2.5, Math.sin(i * 2.4) * 1.2]}
            color={lit}
            emissive={lit}
            emissiveIntensity={2}
            shadow={false}
            noGlow
          />
        ))}
      </group>
      <pointLight ref={light} position={[0, 3.2, 1.2]} intensity={0.4} distance={9} color={lit} />
    </group>
  );
}

function HilltopTower({ data, animate }: RepresentationProps) {
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
          size={[0.1, H, 0.1]}
          position={[x! * 0.6, H / 2, z! * 0.6]}
          rotation={[z! * 0.1, 0, -x! * 0.1]}
          color={WOOD_DARK}
        />
      ))}
      {[1.5, 3, 4.5].map((y) => (
        <Box
          key={y}
          size={[0.9 - y * 0.08, 0.06, 0.9 - y * 0.08]}
          position={[0, y, 0]}
          color={WOOD}
        />
      ))}
      <Cyl r={0.03} h={1.3} position={[0, H + 0.65, 0]} color="#d9d4cc" />
      {/* soft lights only: no blinking urgency here, the tone and the tooltip carry the state */}
      <StatusLights
        tone={data.syncTone}
        running={data.syncRunning}
        animate={animate}
        points={[
          [0, H - 0.1, 0.12],
          [0, H + 1.25, 0],
        ]}
        r={0.07}
      />
    </group>
  );
}

/** Release Train: the mountain funicular. Its cars climb and descend the slope only while releases are pending. */
function Funicular({ data, animate }: RepresentationProps) {
  const [mx, mz] = FUNICULAR.mid;
  const a = FUNICULAR.a;
  const b = FUNICULAR.b;
  // The object stands at the line's middle (on the ground there): draw the line relative to it.
  const midY = (a[1] + b[1]) / 2;
  const la: [number, number, number] = [a[0] - mx, a[1] - midY, a[2] - mz];
  const lb: [number, number, number] = [b[0] - mx, b[1] - midY, b[2] - mz];
  const path = shuttlePath(la, lb);
  const len = Math.hypot(lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]);
  const yaw = Math.atan2(lb[0] - la[0], lb[2] - la[2]);
  const pitch = Math.atan2(lb[1] - la[1], Math.hypot(lb[0] - la[0], lb[2] - la[2]));
  return (
    <group>
      <group
        position={[(la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2, (la[2] + lb[2]) / 2]}
        rotation={[0, yaw, 0]}
      >
        <group rotation={[-pitch, 0, 0]}>
          <Box size={[1.0, 0.1, len]} color="#7a6a55" />
          {[-0.35, 0.35].map((x) => (
            <Box
              key={x}
              size={[0.06, 0.08, len]}
              position={[x, 0.08, 0]}
              color="#7b7f86"
              metalness={0.5}
            />
          ))}
        </group>
      </group>
      {/* stations at both ends */}
      {[la, lb].map((p, i) => (
        <group key={i} position={p}>
          <Box size={[1.8, 1.6, 1.4]} position={[0, 0.5, 0]} color={WOOD} />
          <Cone
            r={1.4}
            h={0.8}
            position={[0, 1.7, 0]}
            rotation={[0, Math.PI / 4, 0]}
            color="#6b4a3a"
            segments={4}
          />
        </group>
      ))}
      <PathTrain
        wagons={data.wagons}
        progress={data.progress}
        animate={animate}
        path={(t) => {
          const p = path(t);
          return { ...p, y: p.y + 0.45 };
        }}
        spacing={0.12}
        start={0}
        head={
          <group rotation={[-pitch, 0, 0]}>
            <Box size={[0.8, 0.6, 1.0]} color="#d6453d" />
            <Box size={[0.82, 0.2, 1.02]} position={[0, 0.2, 0]} color="#efe3c8" />
          </group>
        }
        car={() => (
          <group rotation={[-pitch, 0, 0]}>
            <Box size={[0.8, 0.55, 0.9]} color="#b8352e" />
          </group>
        )}
      />
    </group>
  );
}

function CraftsWorkshop({ data, animate }: RepresentationProps) {
  return (
    <group>
      {[-0.8, 0.8].map((x) => (
        <Box key={x} size={[0.12, 2.0, 0.12]} position={[x, 1.0, -0.4]} color={WOOD_DARK} />
      ))}
      <Box
        size={[2.0, 0.1, 1.4]}
        position={[0, 2.0, -0.1]}
        rotation={[0.15, 0, 0]}
        color="#6b4a3a"
      />
      <Box size={[1.4, 0.08, 0.7]} position={[0, 0.82, 0]} color="#c39b6b" />
      {[-0.6, 0.6].map((x) => (
        <Box key={`l${x}`} size={[0.07, 0.8, 0.6]} position={[x, 0.4, 0]} color={WOOD_DARK} />
      ))}
      <group position={[0, 0.86, 0]}>
        <PrintRig data={data} animate={animate} color={LAVENDER} />
      </group>
    </group>
  );
}

/** Sprint Harbor: the wooden lake boat; its small sail rises with the sprint. */
function LakeBoat({ data, animate }: RepresentationProps) {
  const ref = useRef<Group>(null);
  useFloat(ref, animate, 0.025);
  return (
    <group ref={ref}>
      <Box size={[0.8, 0.3, 2.0]} position={[0, 0.1, 0]} color="#8a5a3b" />
      <Cone
        r={0.4}
        h={0.5}
        position={[0, 0.1, 1.25]}
        rotation={[Math.PI / 2, 0, 0]}
        color="#8a5a3b"
        segments={4}
      />
      <Box size={[0.7, 0.04, 1.8]} position={[0, 0.26, 0]} color="#c39b6b" />
      <Cyl r={0.035} h={2.0} position={[0, 1.25, 0.15]} color={WOOD_DARK} />
      <Sail
        fill={data.sprintFill}
        animate={animate}
        height={1.7}
        foot={0.9}
        color="#efe3c8"
        position={[0.03, 0.3, 0.12]}
      />
    </group>
  );
}

/** Settings: the care cabinet, a small first-aid cupboard on a post. */
function CareCabinet() {
  return (
    <group>
      <Box size={[0.12, 0.7, 0.12]} position={[0, 0.35, 0]} color={WOOD_DARK} />
      <Box size={[0.7, 0.6, 0.35]} position={[0, 1.0, 0]} color="#f4f1ea" />
      <Box size={[0.3, 0.09, 0.02]} position={[0, 1.0, 0.18]} color="#d6453d" />
      <Box size={[0.09, 0.3, 0.02]} position={[0, 1.0, 0.18]} color="#d6453d" />
      <Box size={[0.72, 0.06, 0.37]} position={[0, 1.32, 0]} color={WOOD} />
    </group>
  );
}

/** Audit: the wooden archive chest; its lid lifts while writes can be undone. */
function ArchiveChest({ data, animate }: RepresentationProps) {
  const open = data.undoable > 0;
  return (
    <group>
      <Box size={[0.8, 0.42, 0.5]} position={[0, 0.21, 0]} color="#7a5235" />
      {[-0.28, 0.28].map((x) => (
        <Box key={x} size={[0.05, 0.44, 0.52]} position={[x, 0.21, 0]} color={WOOD_DARK} />
      ))}
      {open && (
        <group position={[0, 0.4, 0.02]}>
          <Papers width={0.55} depth={0.32} />
        </group>
      )}
      <Hinge open={open} animate={animate} angle={-1.1} position={[0, 0.42, -0.25]}>
        <Box size={[0.82, 0.1, 0.52]} position={[0, 0.05, 0.26]} color="#8a5f3f" />
      </Hinge>
    </group>
  );
}

export const SICK_SET: RepresentationSet = {
  monitor: CabinMailbox,
  review: ReviewCabin,
  notes: WoodenBoard,
  kpi: MeditationStones,
  plant: AncientTree,
  router: HilltopTower,
  train: Funicular,
  printer: CraftsWorkshop,
  ship: LakeBoat,
  toolbox: CareCabinet,
  cabinet: ArchiveChest,
};
