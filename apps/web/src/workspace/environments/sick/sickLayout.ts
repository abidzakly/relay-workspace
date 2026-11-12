import {
  buildWorldLayout,
  benchAt,
  observatoryPoses,
  smoothstep,
} from '../../environment/placement';
import type { Pose, V3 } from '../../layout';

/**
 * SICK — the quiet mountain retreat. Pure geography and placement. A small valley:
 * a wooden cabin, a mountain lake, a hot spring, a meditation garden, pine forest climbing the slopes into the mist;
 * the forest observatory on a knoll by the lake; the ship far behind the forest and the mountain mist.
 *
 *        mist · mountains · ship
 *   funicular ↗      cabin [porch]     review cabin    tower
 *     spring   garden   board   mailbox     workshop
 *        stones          ancient tree      knoll observatory
 *                 ~~~~ lake ~~ boat ~~~~
 */
export const LAKE = { x: 3, z: 10, rx: 8, rz: 5.5, y: -0.35 } as const;
export const KNOLL = { x: 15, z: 4, height: 3.2, radius: 5 } as const;
export const CABIN = { x: -4.5, z: -6, w: 6, d: 4.6, porch: 2.2, y: 0.35 } as const;
export const SPRING = { x: -12, z: 2, r: 1.8 } as const;
/** The deck chair on the cabin's porch, looking out over the lake; the avatar rests under a blanket. */
export const PORCH_SEAT: { pos: V3; rotY: number } = {
  pos: [-6.0, CABIN.y, CABIN.z + CABIN.d / 2 + 1.0 - 1.12],
  rotY: Math.PI,
};

export function sickGround(x: number, z: number): number {
  const r = Math.hypot(x, z * 0.9);
  const slopes =
    smoothstep(13, 30, r) * (3.5 + Math.sin(x * 0.17) * 1.6 + Math.cos(z * 0.13 + 0.7) * 1.4);
  const kd = Math.hypot(x - KNOLL.x, z - KNOLL.z);
  const knoll = KNOLL.height * (1 - smoothstep(KNOLL.radius * 0.35, KNOLL.radius, kd));
  const ld = Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz);
  const basin = (1 - smoothstep(0.75, 1.15, ld)) * 1.1;
  return Math.max(slopes, knoll > 0 ? knoll : -Infinity) - basin;
}

export const inLake = (x: number, z: number): boolean =>
  Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz) < 0.92;

/** The funicular climbs from the valley floor up the western slope. */
const FUN_A: readonly [number, number] = [-12.5, -5];
const FUN_B: readonly [number, number] = [-20, -17];
export const FUNICULAR = {
  a: [FUN_A[0], sickGround(...FUN_A) + 0.3, FUN_A[1]] as V3,
  b: [FUN_B[0], sickGround(...FUN_B) + 0.3, FUN_B[1]] as V3,
  mid: [(FUN_A[0] + FUN_B[0]) / 2, (FUN_A[1] + FUN_B[1]) / 2] as const,
};
export const SICK_SHIP: V3 = [-8, 26, -150];

const WORLD: Pose = { pos: [14, 10, 29], look: [-1, 2, -1], fov: 50 };
const WORLD_NARROW: Pose = { pos: [19, 16, 41], look: [-1, 1.8, 0], fov: 60 };

export const OBSERVATORY = { x: KNOLL.x, z: KNOLL.z, y: KNOLL.height, radius: 1.9 } as const;
export const TELESCOPE_PIVOT: V3 = [OBSERVATORY.x, OBSERVATORY.y + 3.4, OBSERVATORY.z];

const BASE = buildWorldLayout({
  world: WORLD,
  worldNarrow: WORLD_NARROW,
  orbit: { yaw: [-1.25, 1.25], elevation: [0.12, 1.1], zoom: [0.45, 1.5] },
  ground: sickGround,
  spots: {
    monitor: { at: [0.5, -0.5], height: 1.0, tip: 0.45, focus: { dist: 2.6, up: 0.5 } },
    // Code Review: the Quiet Review Cabin (no pressure: it only waits to be visited).
    review: { at: [5.5, -6.5], height: 1.5, tip: 1.6, focus: { dist: 5.5, up: 0.9 } },
    notes: { at: [-3.0, 1.0], height: 1.45, tip: 0.8, focus: { dist: 3.3, up: 0.2 } },
    // KPI: four meditation stones (cairns).
    kpi: { at: [-9.0, 7.5], height: 0.5, tip: 0.6, focus: { dist: 3.4, up: 1.4 } },
    // Overview: the ancient glowing tree.
    plant: { at: [-5.0, 4.5], height: 2.6, tip: 2.8, focus: { dist: 7.5, up: 1.2 } },
    router: { at: [11.0, -10.5], height: 3.0, tip: 3.2, focus: { dist: 9.5, up: 1.4, fov: 44 } },
    train: {
      at: [FUNICULAR.mid[0], FUNICULAR.mid[1]],
      // The line's own middle height, so the drawn track meets both stations.
      y: (FUNICULAR.a[1] + FUNICULAR.b[1]) / 2,
      rotY: 0,
      height: 0.8,
      tip: 1.0,
      focus: { dist: 9, up: 2.5 },
    },
    printer: { at: [9.0, -2.0], height: 1.05, tip: 0.5, focus: { dist: 2.6, up: 0.5 } },
    ship: {
      at: [LAKE.x + 2.5, LAKE.z + 1.0],
      y: LAKE.y,
      rotY: -0.4,
      height: 1.0,
      tip: 1.2,
      focus: { dist: 5.5, up: 1.4 },
    },
    // Settings: the care cabinet (a little first-aid cupboard on a post).
    toolbox: { at: [2.0, -3.2], height: 0.9, tip: 0.5, focus: { dist: 2.3, up: 0.3 } },
    cabinet: {
      at: [CABIN.x - CABIN.w / 2 + 0.7, CABIN.z + CABIN.d / 2 + 0.6],
      y: CABIN.y,
      rotY: 0.3,
      height: 0.4,
      tip: 0.45,
      focus: { dist: 2.3, up: 0.6 },
    },
  },
});

export const SICK_LAYOUT = {
  ...BASE,
  bench: benchAt(sickGround, 4, 2.5),
  observatory: {
    ...observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: SICK_SHIP, world: WORLD }),
    place: { pos: [OBSERVATORY.x, OBSERVATORY.y, OBSERVATORY.z] as V3, rotY: 0 },
    anchor: [OBSERVATORY.x, OBSERVATORY.y + 2.2, OBSERVATORY.z] as V3,
    tip: 2.2,
    hit: [4.5, 5, 4.5] as V3,
  },
};

export const SICK_GEO = {
  layout: SICK_LAYOUT,
  ground: sickGround,
  isWater: inLake,
  floating: ['ship'] as const,
};
