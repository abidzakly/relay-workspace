import type { ObjectId } from '../registry';
import type { EnvLayout, GatewayPlace, OrbitLimits, Placement, Pose, V3 } from '../layout';

/**
 * Builds an outdoor world's layout from a short description per object (placement is
 * per environment, the tab never is). Pure, so tests can check every world places every object sensibly.
 */
export interface ObjectSpot {
  /** Ground position (x, z), metres. */
  at: readonly [number, number];
  /** Base height; default: the terrain under `at`. */
  y?: number;
  /** Turn about y (radians). Default: facing the wide shot's camera. */
  rotY?: number;
  /** Height of the object's centre above its base: where the camera looks and the tooltip points from. */
  height: number;
  /** How far above the centre the tooltip points (its top edge). */
  tip: number;
  /** The close-up: distance in front of the object, extra height, sideways shift, field of view. */
  focus: { dist: number; up?: number; side?: number; fov?: number };
}

export interface WorldSpec {
  world: Pose;
  worldNarrow: Pose;
  orbit: OrbitLimits;
  clip?: readonly [number, number];
  ground: (x: number, z: number) => number;
  spots: Record<ObjectId, ObjectSpot>;
}

/** The turn that makes an object at (x, z) face a camera at (cx, cz) (objects face +z when unturned). */
export const faceTowards = (x: number, z: number, cx: number, cz: number): number =>
  Math.atan2(cx - x, cz - z);

/** Everything but the observatory, which each world adds from its own geography (`observatoryPoses`). */
export function buildWorldLayout(spec: WorldSpec): Omit<EnvLayout, 'observatory' | 'bench'> {
  const ids = Object.keys(spec.spots) as ObjectId[];
  const anchors = {} as Record<ObjectId, V3>;
  const pivot = {} as Record<ObjectId, V3>;
  const tipLift = {} as Record<ObjectId, number>;
  const focus = {} as Record<ObjectId, Pose>;
  const place = {} as Record<ObjectId, Placement>;
  const hit = {} as Record<ObjectId, V3>;
  const [cx, , cz] = spec.world.pos;
  for (const id of ids) {
    const s = spec.spots[id];
    const [x, z] = s.at;
    const base = s.y ?? spec.ground(x, z);
    const rotY = s.rotY ?? faceTowards(x, z, cx, cz);
    const centre: V3 = [x, base + s.height, z];
    const fx = Math.sin(rotY);
    const fz = Math.cos(rotY);
    // Sideways = the object's right hand (+x when unturned).
    const sx = Math.cos(rotY);
    const sz = -Math.sin(rotY);
    const side = s.focus.side ?? 0;
    place[id] = { pos: [x, base, z], rotY };
    anchors[id] = centre;
    pivot[id] = [0, 0, 0];
    tipLift[id] = s.tip;
    const wide = Math.min(2.6, Math.max(1.2, s.tip * 2));
    hit[id] = [wide, s.height + s.tip, wide];
    focus[id] = {
      pos: [
        x + fx * s.focus.dist + sx * side,
        centre[1] + (s.focus.up ?? 0.4),
        z + fz * s.focus.dist + sz * side,
      ],
      look: centre,
      fov: s.focus.fov ?? 40,
    };
  }
  return {
    world: spec.world,
    worldNarrow: spec.worldNarrow,
    anchors,
    pivot,
    tipLift,
    focus,
    orbit: spec.orbit,
    place,
    hit,
    clip: spec.clip ?? [0.1, 700],
  };
}

/** Smooth 0→1 between `a` and `b`. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Deterministic pseudo-random in [0, 1) for an integer seed: scenery never jumps between renders. */
export function hash01(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Stands the helpers' bench on the ground at (x, z). */
export function benchAt(
  ground: (x: number, z: number) => number,
  x: number,
  z: number,
  rotY = 0.3,
): GatewayPlace {
  const y = ground(x, z);
  return {
    place: { pos: [x, y, z], rotY },
    anchor: [x, y + 1, z],
    tip: 0.6,
    hit: [3, 2, 2.2],
  };
}

/**
 * The observatory's camera poses, from where its telescope stands and where the ship hangs:
 *  - approach: a three-quarter view of the observatory, from the village side;
 *  - align: just behind the eyepiece, looking along the telescope at the ship;
 *  - ship: on the same line, close to the ship (where the detailed CoreStage takes over).
 */
export function observatoryPoses(opts: {
  /** The telescope's pivot (world metres). */
  pivot: V3;
  ship: V3;
  /** The wide shot (the approach comes from its side). */
  world: Pose;
  /** How far from the ship the last leg stops. */
  shipDist?: number;
}): { approach: Pose; align: Pose; ship: Pose } {
  const [px, py, pz] = opts.pivot;
  const [sx, sy, sz] = opts.ship;
  const len = Math.hypot(sx - px, sy - py, sz - pz);
  const d: V3 = [(sx - px) / len, (sy - py) / len, (sz - pz) / len];
  // From the pivot towards the wide shot, flattened: the side the visitor comes from.
  const wx = opts.world.pos[0] - px;
  const wz = opts.world.pos[2] - pz;
  const wl = Math.hypot(wx, wz) || 1;
  const near = opts.shipDist ?? 34;
  return {
    approach: {
      pos: [px + (wx / wl) * 9 - d[0] * 3, py + 3.2, pz + (wz / wl) * 9 - d[2] * 3],
      look: [px, py - 0.4, pz],
      fov: 42,
    },
    align: {
      pos: [px - d[0] * 2.6, py - d[1] * 2.6 + 0.5, pz - d[2] * 2.6],
      look: [px + d[0] * 40, py + d[1] * 40, pz + d[2] * 40],
      fov: 38,
    },
    ship: {
      pos: [sx - d[0] * near, sy - d[1] * near, sz - d[2] * near],
      look: [sx, sy, sz],
      fov: 40,
    },
  };
}

/** The telescope's aim: yaw (about y) and pitch (up from level) from its pivot towards a target. */
export function aimAt(from: V3, to: V3): { yaw: number; pitch: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}
