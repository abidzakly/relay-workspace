import { buildWorldLayout, observatoryPoses, type ObjectSpot } from '../environment/placement';
import type { EnvLayout, Pose, V3 } from '../layout';
import type { ObjectId } from '../registry';

/**
 * The crystal world (Paper & Ink): one shared space for every environment. The twelve crystals hang on a tilted
 * ellipse around the core, like the words on a text ring orbit a crystal. The core is the Overview gateway (it was the
 * observatory and the ship); the small crystal in front is the helpers' bench (Cockpit). Metres; +z faces the camera.
 */

/** The core's centre: Overview's destination. */
export const CORE_CENTRE: V3 = [0, 1.75, -0.9];
export const CORE_SCALE = 2.9;
/** Every crystal hangs with its centre this far above its base. */
export const CRYSTAL_CENTRE = 0.7;
export const CRYSTAL_SCALE = 1.45;

const WORLD: Pose = { pos: [0, 3.1, 11.6], look: [0, 0.9, -0.4], fov: 40 };
const WORLD_NARROW: Pose = { pos: [0, 7, 25], look: [0, 0.6, 0], fov: 52 };

/** Clockwise from the left, the order of the main nav where it can be. */
const RING: readonly ObjectId[] = [
  'monitor',
  'review',
  'notes',
  'kpi',
  'plant',
  'router',
  'train',
  'printer',
  'ship',
  'toolbox',
  'cabinet',
];

const RX = 6.1;
const RZ = 3.3;

function ringSpot(i: number): ObjectSpot {
  // Starts at the left, goes round the back to the right, then along the front.
  const a = Math.PI + (i / RING.length) * Math.PI * 2;
  const x = Math.cos(a) * RX;
  const z = -Math.sin(a) * RZ - 0.6;
  // A tilted orbit: higher at the back, lower at the front, with a little irregularity.
  const y = -z * 0.18 + Math.sin(i * 2.3) * 0.25;
  return {
    at: [x, z],
    y,
    height: CRYSTAL_CENTRE,
    tip: 0.75,
    focus: { dist: 3.4, up: 0.35, fov: 38 },
  };
}

const spots = Object.fromEntries(RING.map((id, i) => [id, ringSpot(i)])) as Record<
  ObjectId,
  ObjectSpot
>;

const BASE = buildWorldLayout({
  world: WORLD,
  worldNarrow: WORLD_NARROW,
  // Free to turn almost all the way round the core, never below the ring.
  orbit: { yaw: [-1.4, 1.4], elevation: [0.05, 0.95], zoom: [0.45, 1.6] },
  clip: [0.1, 200],
  ground: () => 0,
  spots,
});

const PIVOT: V3 = [0, 2.6, 7.5];

export const CRYSTAL_LAYOUT: EnvLayout = {
  ...BASE,
  // Bigger targets than the drawing, so a crystal far round the back is still easy to tap.
  hit: Object.fromEntries(RING.map((id) => [id, [1.6, 1.6, 1.6] as V3])) as unknown as Record<
    ObjectId,
    V3
  >,
  bench: {
    place: { pos: [0, -0.9, 4.2], rotY: 0 },
    anchor: [0, -0.9 + 0.45, 4.2],
    tip: 0.5,
    hit: [1.2, 1.1, 1.2],
  },
  observatory: {
    ...observatoryPoses({ pivot: PIVOT, ship: CORE_CENTRE, world: WORLD, shipDist: 6.5 }),
    place: { pos: [CORE_CENTRE[0], CORE_CENTRE[1] - 1.2, CORE_CENTRE[2]], rotY: 0 },
    anchor: CORE_CENTRE,
    tip: 1.5,
    hit: [3, 3, 3],
  },
};
