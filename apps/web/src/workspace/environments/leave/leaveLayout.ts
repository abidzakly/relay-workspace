import {
  buildWorldLayout,
  benchAt,
  observatoryPoses,
  smoothstep,
} from '../../environment/placement';
import type { Pose, V3 } from '../../layout';

/**
 * LEAVE — the tropical private island. Pure geography and placement. Metres; the sea is
 * at y = 0; the wide shot looks from the lagoon (+z) towards the island, with the open sea and the ship beyond.
 *
 *        cliff observatory              ship over the open sea
 *     signal station   lighthouse point
 *   board  chest  bungalow  printer  beacon
 *   targets   mailbox  palm
 *        tram loop    bonfire    pier → sailboat
 *   ~~~~~~~~~~~~~~~~~ lagoon ~~~~~~~~~~~~~~~~
 */
export const SEA_Y = 0;
export const ISLAND = { rx: 24, rz: 19, height: 1.2 } as const;
export const CLIFF = { x: -17, z: -11, height: 6.5, radius: 6.5 } as const;
export const POINT = { x: 17, z: -9 } as const;

/** Sand beach, a low grassy middle, the rocky cliff of the observatory; below the sea beyond the shore. */
export function leaveGround(x: number, z: number): number {
  const r = Math.hypot(x / ISLAND.rx, z / ISLAND.rz);
  const island = (1 - smoothstep(0.78, 1.08, r)) * (ISLAND.height + 2.2) - 2.2;
  const inland =
    (1 - smoothstep(0.1, 0.6, r)) * (0.2 + Math.sin(x * 0.3) * 0.05 + Math.cos(z * 0.4) * 0.05);
  const cd = Math.hypot(x - CLIFF.x, z - CLIFF.z);
  const cliff = CLIFF.height * (1 - smoothstep(CLIFF.radius * 0.45, CLIFF.radius, cd));
  const pd = Math.hypot(x - POINT.x, z - POINT.z);
  const point = 1.6 * (1 - smoothstep(1.5, 4, pd));
  // A bump only counts where it rises: far from it, the sea floor stays below the water.
  return Math.max(island + inland, cliff > 0 ? cliff : -Infinity, point > 0 ? point : -Infinity);
}

/** Sand by the water, grass inland, rock on the cliff. */
export function leaveColor(x: number, z: number, y: number): string | null {
  if (y < -0.2) return '#d9c8a0';
  const cd = Math.hypot(x - CLIFF.x, z - CLIFF.z);
  if (cd < CLIFF.radius && y > 1.6) return y > 5 ? '#8f8678' : '#a0968a';
  const r = Math.hypot(x / ISLAND.rx, z / ISLAND.rz);
  if (r > 0.62) return '#ecd9a8';
  return r > 0.52 ? '#c9cf8a' : '#7cbf5a';
}

/** The bungalow stands on stilts; `y` is its deck, above the island's highest sand. */
export const BUNGALOW = { x: -3.6, z: -7, w: 5.4, d: 4.4, deck: 2.4, y: 2.0 } as const;
/** The deck chair on the bungalow's deck, looking out to the lagoon. */
export const DECK_SEAT: { pos: V3; rotY: number } = {
  // The chair's frame turns half round, so the chair lands 1.12 m in front of this point, mid-deck.
  pos: [-5.2, BUNGALOW.y, -3.6 - 1.12],
  rotY: Math.PI,
};
/** The pier runs from the beach out into the lagoon, its deck above the sand. */
export const PIER = { x: 7, z0: 12, z1: 21, y: 1.3 } as const;
export const TRAM = { x: -3, z: 9, rx: 3.0, rz: 1.4 } as const;
export const BONFIRE: V3 = [1.6, 0, 6.5];
export const HAMMOCK = { a: [-11.5, 1.5] as const, b: [-8.0, 3.2] as const };
export const LEAVE_SHIP: V3 = [-26, 30, -150];

const WORLD: Pose = { pos: [15, 10, 31], look: [0, 1.8, -1], fov: 50 };
const WORLD_NARROW: Pose = { pos: [20, 16, 44], look: [0, 1.6, 0], fov: 60 };

export const OBSERVATORY = { x: CLIFF.x, z: CLIFF.z, y: CLIFF.height, radius: 2.2 } as const;
export const TELESCOPE_PIVOT: V3 = [OBSERVATORY.x, OBSERVATORY.y + 3.4, OBSERVATORY.z];

const BASE = buildWorldLayout({
  world: WORLD,
  worldNarrow: WORLD_NARROW,
  orbit: { yaw: [-1.3, 1.3], elevation: [0.1, 1.1], zoom: [0.45, 1.5] },
  ground: leaveGround,
  spots: {
    monitor: { at: [0.6, -0.8], height: 1.0, tip: 0.45, focus: { dist: 2.6, up: 0.5 } },
    review: { at: [8.5, -6.0], height: 1.6, tip: 2.2, focus: { dist: 6.0, up: 1.2 } },
    notes: { at: [-9.6, -2.6], height: 1.45, tip: 0.8, focus: { dist: 3.4, up: 0.2 } },
    kpi: { at: [-11.5, 6.0], height: 1.0, tip: 0.6, focus: { dist: 4.2, up: 0.8 } },
    plant: { at: [4.6, 0.4], height: 3.0, tip: 2.6, focus: { dist: 7.0, up: 1.2 } },
    router: { at: [13.5, -2.0], height: 2.6, tip: 2.8, focus: { dist: 8.5, up: 1.2 } },
    train: { at: [TRAM.x, TRAM.z], rotY: 0, height: 0.4, tip: 0.6, focus: { dist: 6.0, up: 2.6 } },
    printer: { at: [3.2, -5.6], height: 1.05, tip: 0.5, focus: { dist: 2.6, up: 0.5 } },
    ship: {
      at: [PIER.x + 1.9, PIER.z1 - 1.5],
      y: SEA_Y,
      rotY: 0.2,
      height: 1.2,
      tip: 1.6,
      focus: { dist: 6.5, up: 1.6 },
    },
    toolbox: { at: [1.3, -3.0], height: 0.35, tip: 0.4, focus: { dist: 2.1, up: 0.9 } },
    cabinet: { at: [-7.6, -1.6], height: 0.45, tip: 0.5, focus: { dist: 2.4, up: 0.6 } },
  },
});

export const LEAVE_LAYOUT = {
  ...BASE,
  bench: benchAt(leaveGround, -3.0, 2.5),
  observatory: {
    ...observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: LEAVE_SHIP, world: WORLD }),
    place: { pos: [OBSERVATORY.x, OBSERVATORY.y, OBSERVATORY.z] as V3, rotY: 0 },
    anchor: [OBSERVATORY.x, OBSERVATORY.y + 2.2, OBSERVATORY.z] as V3,
    tip: 2.2,
    hit: [5, 5, 5] as V3,
  },
};

/** For the shared world checks (`environments/worlds.test.ts`). */
export const LEAVE_GEO = {
  layout: LEAVE_LAYOUT,
  ground: leaveGround,
  isWater: (x: number, z: number) => leaveGround(x, z) < SEA_Y,
  floating: ['ship'] as const,
};
