import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BoxGeometry,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
  type MeshStandardMaterial,
} from 'three';
import { MODE_B_GLOW } from './glow';
import { STAGES, type ProgressSegment, type Stage } from './progressMapping';
import { RADII, SHELL_RADIUS } from './rig';

/**
 * Orbits sit midway between the rings, so a plate never crosses a ring's metal. The pins do cross these gaps, so a plate
 * can pass through a pin; the gimbal's own turning already makes that unavoidable at any radius between two rings.
 */
const ORBIT_RADIUS: Record<Stage, number> = {
  1: (RADII.outer + RADII.middle) / 2,
  2: (RADII.middle + RADII.inner) / 2,
  3: (RADII.inner + SHELL_RADIUS) / 2,
  4: SHELL_RADIUS,
};

/** Rad/s. Docked plates turn slowly with the core; the rest are in visibly separate orbits. */
const ORBIT_SPEED: Record<Stage, number> = { 1: 0.1, 2: 0.16, 3: 0.24, 4: 0.05 };

/** The same colour a stage has in Mode A. */
const MATERIAL: Record<Stage, MeshStandardMaterial> = {
  1: MODE_B_GLOW.outer,
  2: MODE_B_GLOW.middle,
  3: MODE_B_GLOW.inner,
  4: MODE_B_GLOW.shell,
};

/** Where a card that was not on screen arrives from: the dust's radius, since a promoted card comes from there. */
const ENTRY_RADIUS = 3.45;
/** How quickly a plate closes on its place, per second. */
const FOLLOW = 2.5;
const MAX_FRAME_SECONDS = 0.1;

/** Share of its patch of the shell that a docked plate covers, with limits so few cards still read as plates. */
const PLATE_FILL = 0.9;
const MIN_PLATE = 0.05;
const MAX_PLATE = 0.36;
export const PLATE_THICKNESS = 0.25;

const GEOMETRY = new BoxGeometry(1, 1, PLATE_THICKNESS);

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const FACING = new Vector3(0, 0, 1);
const ORBIT_AXIS = new Vector3(0, 1, 0);

/** Evenly spread points on a sphere, so plate i of N has a home that makes a whole shell once all have docked. */
function homeDirection(i: number, n: number, out: Vector3): Vector3 {
  const y = 1 - ((i + 0.5) / n) * 2;
  const around = i * GOLDEN_ANGLE;
  const flat = Math.sqrt(1 - y * y);
  return out.set(flat * Math.cos(around), y, flat * Math.sin(around));
}

function plateSize(n: number): number {
  const patch = SHELL_RADIUS * Math.sqrt((4 * Math.PI) / Math.max(n, 1));
  return Math.min(MAX_PLATE, Math.max(MIN_PLATE, patch * PLATE_FILL));
}

function shortestTurn(from: number, to: number): number {
  const gap = (to - from) % (Math.PI * 2);
  if (gap > Math.PI) return gap - Math.PI * 2;
  if (gap < -Math.PI) return gap + Math.PI * 2;
  return gap;
}

interface Block {
  stage: Stage;
  /** Current values, which ease towards the targets. */
  direction: Vector3;
  radius: number;
  angle: number;
  size: number;
  /** Target. Radius and angle come from the stage; size is shared by all. */
  home: Vector3;
}

/**
 * Where a card's plate is right now, by card id, in the same space as the plates. An instance index would not do: it
 * changes whenever a card changes stage. False when the card has no plate.
 */
export type BlockLocator = (cardId: string, out: Matrix4) => boolean;

type Meshes = Partial<Record<Stage, InstancedMesh | null>>;

const turn = new Quaternion();
const facing = new Quaternion();
const position = new Vector3();
const scale = new Vector3();
const matrix = new Matrix4();
const used: Record<Stage, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

function composeBlock(block: Block, out: Matrix4): Matrix4 {
  turn.setFromAxisAngle(ORBIT_AXIS, block.angle);
  position.copy(block.direction).multiplyScalar(block.radius).applyQuaternion(turn);
  facing.setFromUnitVectors(FACING, block.direction).premultiply(turn);
  scale.setScalar(block.size);
  return out.compose(position, facing, scale);
}

function writeBlocks(blocks: readonly Block[], meshes: Meshes) {
  for (const stage of STAGES) used[stage] = 0;
  for (const block of blocks) {
    const mesh = meshes[block.stage];
    if (!mesh) continue;
    mesh.setMatrixAt(used[block.stage]++, composeBlock(block, matrix));
  }
  for (const stage of STAGES) {
    const mesh = meshes[stage];
    if (!mesh) continue;
    mesh.count = used[stage];
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Mode B, the block-built sphere: one plate per counted card, far out at Next Up and docked into the core's
 * shell at Ready to Test. A plate belongs to one instanced mesh per stage because three's instance colours do not reach
 * the emissive term, which is most of what these materials show; the colour therefore changes at once and the radius
 * eases. Plates at one stage share one orbit's phase, so they keep their even spacing on the way to a full shell.
 *
 * Remount (by `key`) to show a new set of cards with no movement, as a scope change does.
 */
export function ModeB({
  segments,
  animate,
  locator,
}: {
  segments: readonly ProgressSegment[];
  animate: boolean;
  /** Filled with this mode's lookup while it is mounted. */
  locator?: RefObject<BlockLocator | null>;
}) {
  const n = segments.length;
  const meshes = useRef<Meshes>({});
  const blocks = useRef<Block[]>([]);
  /** Survives a change of N, so that a plate moves to its new home instead of jumping there. */
  const known = useRef(new Map<string, Block>());
  const phase = useRef<Record<Stage, number>>({ 1: 0, 2: 0, 3: 0, 4: 0 });
  const seeded = useRef(false);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => () => GEOMETRY.dispose(), []);

  useLayoutEffect(() => {
    if (!locator) return;
    locator.current = (cardId, out) => {
      const block = known.current.get(cardId);
      if (!block) return false;
      composeBlock(block, out);
      return true;
    };
    return () => {
      locator.current = null;
    };
  }, [locator]);

  useLayoutEffect(() => {
    const next = new Map<string, Block>();
    const size = plateSize(segments.length);
    const list = segments.map((segment, i) => {
      const home = homeDirection(i, segments.length, new Vector3());
      const existing = known.current.get(segment.cardId);
      // The first picture is not an advance, so it arrives already assembled. Without motion, everything is at its place.
      const arrive = !animate || (!existing && !seeded.current);
      const block: Block = existing ?? {
        stage: segment.stage,
        direction: home.clone(),
        radius: ENTRY_RADIUS,
        angle: phase.current[segment.stage],
        size: 0,
        home,
      };
      block.stage = segment.stage;
      block.home = home;
      if (arrive) {
        block.direction.copy(home);
        block.radius = ORBIT_RADIUS[segment.stage];
        block.angle = phase.current[segment.stage];
        block.size = size;
      }
      next.set(segment.cardId, block);
      return block;
    });
    seeded.current = true;
    known.current = next;
    blocks.current = list;
    writeBlocks(list, meshes.current);
    invalidate();
  }, [segments, animate, invalidate]);

  useFrame((_, delta) => {
    if (!animate) return;
    const dt = Math.min(delta, MAX_FRAME_SECONDS);
    const ease = 1 - Math.exp(-dt * FOLLOW);
    const size = plateSize(blocks.current.length);
    for (const stage of STAGES) phase.current[stage] += ORBIT_SPEED[stage] * dt;
    for (const block of blocks.current) {
      const orbit = phase.current[block.stage];
      block.direction.lerp(block.home, ease).normalize();
      block.radius += (ORBIT_RADIUS[block.stage] - block.radius) * ease;
      block.angle += shortestTurn(block.angle, orbit) * ease;
      block.size += (size - block.size) * ease;
    }
    writeBlocks(blocks.current, meshes.current);
  });

  if (n === 0) return null;
  return (
    <>
      {/* The count is fixed when an instanced mesh is created, and any one stage may need room for every card. */}
      {STAGES.map((stage) => (
        <instancedMesh
          key={`${stage}-${n}`}
          ref={(mesh) => {
            meshes.current[stage] = mesh;
          }}
          args={[GEOMETRY, MATERIAL[stage], n]}
          frustumCulled={false}
        />
      ))}
    </>
  );
}
