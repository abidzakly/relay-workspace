import {
  buildWorldLayout,
  benchAt,
  observatoryPoses,
  smoothstep,
} from '../../environment/placement';
import type { Pose, V3 } from '../../layout';

/**
 * HOME — the cozy hillside village. Pure geography and placement; the drawing lives in
 * `HomeWorld.tsx`. Metres; +z faces the wide shot, the mountains (and the ship above them) lie towards -z.
 *
 *            mountains · ship
 *     observatory hill        tower
 *          cottage [porch]  workshop  printer
 *   target  board          mailbox     bonsai
 *              railway loop
 *   ~~~~~~~~~ river ~~~~~~~~~~ boat ~~~~~~
 */

/** The river's centre line (z for a given x): it bends across the front of the village. */
export const riverZ = (x: number): number => 10.5 + Math.sin(x * 0.12) * 1.6;
export const RIVER_HALF_WIDTH = 1.5;
export const WATER_Y = -0.32;

/** The observatory hill, the highest point near the village. */
export const OBSERVATORY_HILL = { x: -15, z: -13, height: 5.2, radius: 8 } as const;

/** Rolling hills outside a flat yard, the observatory hill, and the river's channel. */
export function homeGround(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const rolling =
    smoothstep(12, 26, r) * (1.6 + Math.sin(x * 0.13) * 1.1 + Math.cos(z * 0.11 + 1.3) * 0.9);
  const hd = Math.hypot(x - OBSERVATORY_HILL.x, z - OBSERVATORY_HILL.z);
  const hill = OBSERVATORY_HILL.height * (1 - smoothstep(0, OBSERVATORY_HILL.radius, hd));
  const fromRiver = Math.abs(z - riverZ(x));
  const channel =
    (1 - smoothstep(RIVER_HALF_WIDTH * 0.6, RIVER_HALF_WIDTH * 1.6, fromRiver)) * 0.75;
  return Math.max(rolling, hill) - channel;
}

/** The cottage: footprint centre, size (x, z), and its porch in front (+z). */
export const COTTAGE = { x: -3.4, z: -5.2, w: 5.6, d: 4.2, porchDepth: 2.3, porchY: 0.3 } as const;
/** The porch desk set (desk, chair, avatar), as a frame (`scene/DeskSet.tsx`), on the porch. */
export const PORCH_DESK: { pos: V3; rotY: number } = {
  pos: [-3.6, COTTAGE.porchY, -0.85],
  rotY: 0,
};
/** The workshop beside the cottage, open towards the village. */
export const WORKSHOP = { x: 1.6, z: -5.0, w: 3.2, d: 3.0 } as const;
/** Where the railway loop lies (centre, radii). */
export const RAILWAY = { x: -1.5, z: 5.4, rx: 2.4, rz: 1.25 } as const;
/** Where the ship hangs: high above the mountains, far behind the village. */
export const HOME_SHIP: V3 = [6, 26, -135];
/** Lantern posts along the village path (lit at dusk). */
export const LANTERNS: readonly (readonly [number, number])[] = [
  [-0.4, 0.2],
  [1.2, 2.4],
  [-3.2, 2.6],
  [4.2, 0.8],
  [-6.4, -1.0],
  [3.4, -1.6],
];

const WORLD: Pose = { pos: [13, 9.5, 22], look: [-0.5, 2.4, -2], fov: 50 };
const WORLD_NARROW: Pose = { pos: [17, 15, 33], look: [-0.5, 2.0, -1], fov: 60 };

/** The observatory on the hill's summit, and its telescope's pivot ("hilltop wooden observatory"). */
export const OBSERVATORY = {
  x: OBSERVATORY_HILL.x,
  z: OBSERVATORY_HILL.z,
  y: OBSERVATORY_HILL.height,
  radius: 2.1,
} as const;
export const TELESCOPE_PIVOT: V3 = [OBSERVATORY.x, OBSERVATORY.y + 3.4, OBSERVATORY.z];

const BASE_LAYOUT = buildWorldLayout({
  world: WORLD,
  worldNarrow: WORLD_NARROW,
  // A wide valley: turn far, never under the hills.
  orbit: { yaw: [-1.25, 1.25], elevation: [0.12, 1.1], zoom: [0.45, 1.5] },
  ground: homeGround,
  spots: {
    // MR Inbox: the mailbox by the garden gate.
    monitor: { at: [2.2, 3.4], height: 1.0, tip: 0.45, focus: { dist: 2.6, up: 0.5 } },
    // Code Review: the Developer's Workshop beside the cottage.
    review: {
      at: [WORKSHOP.x, WORKSHOP.z],
      rotY: 0,
      height: 1.4,
      tip: 1.6,
      focus: { dist: 5.2, up: 0.9 },
    },
    // Board: the wooden notice board.
    notes: { at: [-6.2, 1.0], height: 1.45, tip: 0.75, focus: { dist: 3.3, up: 0.2 } },
    // KPI: the garden archery target.
    kpi: { at: [-8.4, -3.0], height: 1.15, tip: 0.85, focus: { dist: 3.4, up: 0.3 } },
    // Overview: the large bonsai.
    plant: { at: [6.4, 0.8], height: 1.7, tip: 1.3, focus: { dist: 5.0, up: 0.9 } },
    // Sync Health: the communication tower.
    router: { at: [8.8, -7.0], height: 3.0, tip: 3.3, focus: { dist: 10, up: 1.4, fov: 44 } },
    // Release Train: the miniature railway.
    train: {
      at: [RAILWAY.x, RAILWAY.z],
      rotY: 0,
      height: 0.3,
      tip: 0.5,
      focus: { dist: 5.4, up: 2.6 },
    },
    // Builds: the workshop printer on its bench.
    printer: { at: [5.0, -3.3], height: 1.05, tip: 0.5, focus: { dist: 2.5, up: 0.4 } },
    // Sprint Harbor: the sailing boat on the river.
    ship: {
      at: [5.6, riverZ(5.6)],
      y: WATER_Y,
      rotY: 0.35,
      height: 1.1,
      tip: 1.4,
      focus: { dist: 6.0, up: 1.6 },
    },
    // Settings: the toolbox by the workshop.
    toolbox: { at: [4.0, -2.0], height: 0.25, tip: 0.35, focus: { dist: 2.0, up: 0.9 } },
    // Audit: the archive cabinet on the porch.
    cabinet: {
      at: [COTTAGE.x - COTTAGE.w / 2 + 0.6, COTTAGE.z + COTTAGE.d / 2 + 0.55],
      y: COTTAGE.porchY,
      rotY: 0.4,
      height: 0.65,
      tip: 0.6,
      focus: { dist: 2.8, up: 0.3 },
    },
  },
});

export const HOME_LAYOUT = {
  ...BASE_LAYOUT,
  bench: benchAt(homeGround, -2.5, 2.2),
  observatory: {
    ...observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: HOME_SHIP, world: WORLD }),
    place: { pos: [OBSERVATORY.x, OBSERVATORY.y, OBSERVATORY.z] as V3, rotY: 0 },
    anchor: [OBSERVATORY.x, OBSERVATORY.y + 2.4, OBSERVATORY.z] as V3,
    tip: 2.4,
    hit: [5, 5.5, 5] as V3,
  },
};

/** For the shared world checks (`environments/worlds.test.ts`). */
export const HOME_GEO = {
  layout: HOME_LAYOUT,
  ground: homeGround,
  isWater: (x: number, z: number) => Math.abs(z - riverZ(x)) < RIVER_HALF_WIDTH,
  floating: ['ship'] as const,
};
