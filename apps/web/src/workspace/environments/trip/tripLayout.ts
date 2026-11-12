import {
  buildWorldLayout,
  benchAt,
  observatoryPoses,
  smoothstep,
} from '../../environment/placement';
import type { Pose, V3 } from '../../layout';

/**
 * TRIP — the coastal transit island. Pure geography and placement. Sea at y = 0; a flat
 * island of terminal, runway and harbour; the lighthouse (Overview) on the east point with its observation deck on
 * the rocks beside it; the ship above the ocean horizon.
 *
 *     ═══════════════ runway ═══════════════     hangar
 *        shuttle line          terminal          tower
 *   customs  dispatch             kiosk  info       deck ▲ lighthouse
 *      itinerary   compass        bench
 *   ~~~~~~~ seaplane ~~~~ ferry dock → ferry ~~~~~~~~~~~~
 */
export const SEA_Y = 0;
export const ISLAND = { rx: 27, rz: 21, height: 1.0 } as const;
export const HEADLAND = { x: 19, z: -1, height: 4.4, radius: 5.5 } as const;
export const RUNWAY = { z: -15, x0: -22, x1: 16, w: 4 } as const;
export const TERMINAL = { x: -1, z: -8, w: 12, d: 4.4, h: 4 } as const;
export const HANGAR = { x: 12.5, z: -9.5, w: 7, d: 6, h: 4.5 } as const;
export const SHUTTLE = { a: [-13, 0.9, -11.2] as V3, b: [5, 0.9, -11.2] as V3 } as const;
export const FERRY_DOCK = { x: 5.5, z0: 13, z1: 22, y: 1.3 } as const;
export const SEAPLANE: V3 = [-11, SEA_Y, 19];
/** The café table at the terminal: a laptop between flights. */
export const CAFE_SEAT: { pos: V3; rotY: number } = { pos: [-0.8, ISLAND.height, -1.6], rotY: 0 };
export const TRIP_SHIP: V3 = [22, 27, -150];

export function tripGround(x: number, z: number): number {
  const r = Math.hypot(x / ISLAND.rx, z / ISLAND.rz);
  const island = (1 - smoothstep(0.8, 1.06, r)) * (ISLAND.height + 2.2) - 2.2;
  const hd = Math.hypot(x - HEADLAND.x, z - HEADLAND.z);
  const head = HEADLAND.height * (1 - smoothstep(HEADLAND.radius * 0.4, HEADLAND.radius, hd));
  return Math.max(island, head > 0 ? head : -Infinity);
}

/** Paved apron and runway, sand at the edge, rock on the headland. */
export function tripColor(x: number, z: number, y: number): string | null {
  if (y < -0.2) return '#d9c8a0';
  if (Math.abs(z - RUNWAY.z) < RUNWAY.w / 2 && x > RUNWAY.x0 && x < RUNWAY.x1) return '#5b6068';
  if (Math.hypot(x - HEADLAND.x, z - HEADLAND.z) < HEADLAND.radius && y > 1.4) return '#8f8678';
  const r = Math.hypot(x / ISLAND.rx, z / ISLAND.rz);
  if (r > 0.7) return '#ecd9a8';
  if (z > -12 && z < -4 && Math.abs(x) < 10) return '#c9c1b3';
  return '#86c06a';
}

const WORLD: Pose = { pos: [15, 11, 34], look: [0, 2, -2], fov: 50 };
const WORLD_NARROW: Pose = { pos: [21, 17, 47], look: [0, 1.8, -1], fov: 60 };

export const OBSERVATORY = {
  x: HEADLAND.x,
  z: HEADLAND.z,
  y: HEADLAND.height,
  radius: 2.0,
} as const;
export const TELESCOPE_PIVOT: V3 = [OBSERVATORY.x, OBSERVATORY.y + 3.4, OBSERVATORY.z];
export const LIGHTHOUSE_AT = [13, 7.5] as const;

const BASE = buildWorldLayout({
  world: WORLD,
  worldNarrow: WORLD_NARROW,
  orbit: { yaw: [-1.3, 1.3], elevation: [0.1, 1.1], zoom: [0.45, 1.5] },
  ground: tripGround,
  spots: {
    // MR Inbox: the airport information terminal.
    monitor: { at: [3.2, 1.0], height: 1.2, tip: 0.7, focus: { dist: 3.0, up: 0.3 } },
    // Code Review: the Engineering Dispatch Terminal.
    review: { at: [-8.0, 0.5], height: 1.7, tip: 1.6, focus: { dist: 6.0, up: 1.0 } },
    // Board: the travel itinerary board.
    notes: { at: [-11.5, 5.0], height: 1.6, tip: 1.0, focus: { dist: 4.0, up: 0.2 } },
    // KPI: the destination compass.
    kpi: { at: [-5.0, 6.5], height: 0.9, tip: 0.5, focus: { dist: 3.4, up: 1.6 } },
    // Overview: the lighthouse.
    plant: {
      at: [LIGHTHOUSE_AT[0], LIGHTHOUSE_AT[1]],
      height: 4.5,
      tip: 4.2,
      focus: { dist: 11, up: 1.5, fov: 44 },
    },
    // Sync Health: the coastal radio tower.
    router: { at: [8.5, -3.5], height: 3.0, tip: 3.4, focus: { dist: 10, up: 1.4, fov: 44 } },
    // Release Train: the terminal shuttle.
    train: {
      at: [(SHUTTLE.a[0] + SHUTTLE.b[0]) / 2, SHUTTLE.a[2]],
      rotY: 0,
      height: 1.0,
      tip: 0.8,
      focus: { dist: 7.5, up: 1.6 },
    },
    // Builds: the maintenance hangar printer.
    printer: { at: [11.5, -4.5], height: 1.05, tip: 0.5, focus: { dist: 2.6, up: 0.5 } },
    // Sprint Harbor: the harbour ferry.
    ship: {
      at: [FERRY_DOCK.x + 2.6, FERRY_DOCK.z1 - 2.5],
      y: SEA_Y,
      rotY: 0.15,
      height: 1.6,
      tip: 1.6,
      focus: { dist: 9, up: 2.2 },
    },
    // Settings: the travel equipment kiosk.
    toolbox: { at: [6.5, 3.5], height: 1.1, tip: 0.8, focus: { dist: 3.0, up: 0.4 } },
    // Audit: the customs archive office.
    cabinet: { at: [-13.5, -2.5], height: 1.2, tip: 1.2, focus: { dist: 4.0, up: 0.4 } },
  },
});

export const TRIP_LAYOUT = {
  ...BASE,
  bench: benchAt(tripGround, 2.5, 6.0),
  observatory: {
    ...observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: TRIP_SHIP, world: WORLD }),
    place: { pos: [OBSERVATORY.x, OBSERVATORY.y, OBSERVATORY.z] as V3, rotY: 0 },
    anchor: [OBSERVATORY.x, OBSERVATORY.y + 2.2, OBSERVATORY.z] as V3,
    tip: 2.2,
    hit: [4.5, 5, 4.5] as V3,
  },
};

/** For the shared world checks (`environments/worlds.test.ts`). */
export const TRIP_GEO = {
  layout: TRIP_LAYOUT,
  ground: tripGround,
  isWater: (x: number, z: number) => tripGround(x, z) < SEA_Y,
  floating: ['ship'] as const,
};
