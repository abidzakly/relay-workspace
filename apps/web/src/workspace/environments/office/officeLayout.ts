import { benchAt, buildWorldLayout, observatoryPoses } from '../../environment/placement';
import type { Pose, V3 } from '../../layout';

/**
 * OFFICE — the futuristic sky campus. A research campus on a deck suspended high above a
 * metropolitan skyline: connected glass buildings, rooftop gardens, holographic displays, a monorail, the central
 * energy reactor. The deck is y = 0; beyond its edge the city lies far below. The ship hangs between the two towers.
 *
 *        tower ─── ship ─── tower(+observatory dome)
 *   server room   review chamber   main building [desk]   antenna
 *   planning wall   holo terminal   REACTOR   fab lab   check-in gate
 *        radar     monorail loop        toolbox      docking bay
 */
export const DECK = { hx: 20, hz: 16, edge: 2.2 } as const;
export const DROP = -90;
export const TOWERS = [
  { x: -14, z: -13, w: 6, d: 6, h: 22 },
  { x: 14, z: -13, w: 6, d: 6, h: 18 },
] as const;
export const MAIN = { x: 2, z: -9, w: 10, d: 5, h: 7 } as const;
export const MONORAIL = { x: -6, z: 7, rx: 4.2, rz: 2.2, y: 2.2 } as const;
/** The desk in the main building's open atrium. */
export const DESK_SEAT: { pos: V3; rotY: number } = { pos: [2, 0, -4.4], rotY: 0 };
export const OFFICE_SHIP: V3 = [0, 30, -150];
/** The observatory dome on the taller tower's roof. */
export const OBSERVATORY = { x: TOWERS[0].x, z: TOWERS[0].z, y: TOWERS[0].h, radius: 2.2 } as const;
export const TELESCOPE_PIVOT: V3 = [OBSERVATORY.x, OBSERVATORY.y + 3.4, OBSERVATORY.z];

/** On the deck (a rounded rectangle) the ground is 0; beyond its edge, a long way down. */
export function onDeck(x: number, z: number): boolean {
  const qx = Math.max(Math.abs(x) - (DECK.hx - DECK.edge), 0);
  const qz = Math.max(Math.abs(z) - (DECK.hz - DECK.edge), 0);
  return Math.hypot(qx, qz) <= DECK.edge;
}
export const officeGround = (x: number, z: number): number => (onDeck(x, z) ? 0 : DROP);

const WORLD: Pose = { pos: [16, 12, 30], look: [0, 2.5, -2], fov: 50 };
const WORLD_NARROW: Pose = { pos: [21, 18, 42], look: [0, 2.2, -1], fov: 60 };

const BASE = buildWorldLayout({
  world: WORLD,
  worldNarrow: WORLD_NARROW,
  orbit: { yaw: [-1.2, 1.2], elevation: [0.12, 1.1], zoom: [0.45, 1.5] },
  ground: officeGround,
  spots: {
    // MR Inbox: the holographic control terminal.
    monitor: { at: [-3.5, 1.5], height: 1.5, tip: 0.8, focus: { dist: 3.2, up: 0.3 } },
    // Code Review: the Engineering Review Chamber.
    review: { at: [-8.0, -6.0], height: 1.6, tip: 1.6, focus: { dist: 6.5, up: 1.0 } },
    // Board: the glass planning wall.
    notes: { at: [-13.5, -1.0], height: 1.6, tip: 1.0, focus: { dist: 4.0, up: 0.2 } },
    // KPI: the radar target system.
    kpi: { at: [-14.0, 6.0], height: 1.0, tip: 0.7, focus: { dist: 3.6, up: 1.2 } },
    // Overview: the central energy reactor.
    plant: { at: [3.0, 1.5], height: 2.2, tip: 2.2, focus: { dist: 7.5, up: 1.4 } },
    // Sync Health: the rooftop antenna.
    router: { at: [15.0, -4.0], height: 3.0, tip: 3.2, focus: { dist: 9.5, up: 1.4, fov: 44 } },
    // Release Train: the automated monorail.
    train: {
      at: [MONORAIL.x, MONORAIL.z],
      rotY: 0,
      height: 2.4,
      tip: 0.8,
      focus: { dist: 9, up: 2.8 },
    },
    // Builds: the robotic fabrication lab.
    printer: { at: [9.5, 0.5], height: 1.2, tip: 1.0, focus: { dist: 3.6, up: 0.6 } },
    // Sprint Harbor: the spacecraft docking bay.
    ship: { at: [12.5, 9.0], height: 1.4, tip: 1.6, focus: { dist: 8, up: 2.2 } },
    // Settings: the maintenance toolbox (a tool cart).
    toolbox: { at: [6.0, 8.0], height: 0.5, tip: 0.5, focus: { dist: 2.4, up: 0.9 } },
    // Audit: the server archive room.
    cabinet: { at: [-14.5, -8.0], height: 1.2, tip: 1.2, focus: { dist: 4.0, up: 0.4 } },
  },
});

export const OFFICE_LAYOUT = {
  ...BASE,
  bench: benchAt(officeGround, -0.5, 6.0),
  observatory: {
    ...observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: OFFICE_SHIP, world: WORLD }),
    place: { pos: [OBSERVATORY.x, OBSERVATORY.y, OBSERVATORY.z] as V3, rotY: 0 },
    anchor: [OBSERVATORY.x, OBSERVATORY.y + 2.2, OBSERVATORY.z] as V3,
    tip: 2.2,
    hit: [5, 5, 5] as V3,
  },
};

/** For the shared world checks: the "water" here is the drop beyond the deck. */
export const OFFICE_GEO = {
  layout: OFFICE_LAYOUT,
  ground: officeGround,
  isWater: (x: number, z: number) => !onDeck(x, z),
  floating: [] as const,
};
