import type { ObjectId } from './registry';

/** World layouts and camera poses, in metres. Pure numbers, free of three.js (the DOM side needs them too). */
export type V3 = readonly [number, number, number];

export interface Pose {
  pos: V3;
  look: V3;
  fov: number;
}

/**
 * The avatar's desk set, in the chair's frame: the chair and avatar are drawn around `SEAT_ORIGIN` and turn about it
 * together; the hands reach for the keyboard's and mouse's top centres on the desk (`scene/DeskSet.tsx`).
 */
export const SEAT_ORIGIN: V3 = [0, 0, -1.12];
export const KEYBOARD: V3 = [0, 0.77, -1.6];
export const MOUSE: V3 = [0.38, 0.77, -1.6];

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Exact at both ends, so an arrived camera sits exactly on its pose. */
const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Position and look-at point move separately, so the camera never swings through an odd roll on the way. */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    pos: lerp3(a.pos, b.pos, t),
    look: lerp3(a.look, b.look, t),
    fov: lerp(a.fov, b.fov, t),
  };
}

export const FOCUS_MS = 750;

/**
 * The visitor's own view of the world: a turn around the look-at point (yaw, radians), a tilt (pitch, radians) and a
 * distance factor (zoom). Limited so the camera never ends up behind a wall or under the floor.
 */
export interface Orbit {
  yaw: number;
  pitch: number;
  zoom: number;
}

/** Window event that sends the camera back to the wide shot (the HUD's reset button). */
export const RESET_VIEW_EVENT = 'workspace:reset-view';

export const ORBIT_HOME: Orbit = { yaw: 0, pitch: 0, zoom: 1 };

export interface OrbitLimits {
  yaw: readonly [number, number];
  /** Absolute elevation of the camera above the look-at point, radians. */
  elevation: readonly [number, number];
  zoom: readonly [number, number];
}

const clamp = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, v));

/** Applies an orbit to a pose. Keeps the pose's look-at point; the camera moves on a sphere around it. */
export function orbitPose(base: Pose, o: Orbit, limits: OrbitLimits): Pose {
  const dx = base.pos[0] - base.look[0];
  const dy = base.pos[1] - base.look[1];
  const dz = base.pos[2] - base.look[2];
  const dist = Math.hypot(dx, dy, dz);
  const azimuth = Math.atan2(dx, dz) + clamp(o.yaw, limits.yaw);
  const elevation = clamp(Math.asin(dy / dist) + o.pitch, limits.elevation);
  const r = dist * clamp(o.zoom, limits.zoom);
  const flat = r * Math.cos(elevation);
  return {
    pos: [
      base.look[0] + flat * Math.sin(azimuth),
      base.look[1] + r * Math.sin(elevation),
      base.look[2] + flat * Math.cos(azimuth),
    ],
    look: base.look,
    fov: base.fov,
  };
}

/** Keeps an orbit inside the limits (the elevation limit needs the pose, see `orbitPose`). */
export function clampOrbit(base: Pose, o: Orbit, limits: OrbitLimits): Orbit {
  const dy = base.pos[1] - base.look[1];
  const dist = Math.hypot(base.pos[0] - base.look[0], dy, base.pos[2] - base.look[2]);
  const elev = Math.asin(dy / dist);
  return {
    yaw: clamp(o.yaw, limits.yaw),
    pitch: clamp(elev + o.pitch, limits.elevation) - elev,
    zoom: clamp(o.zoom, limits.zoom),
  };
}

/**
 * Where everything sits in one environment: the wide shot, each object's anchor / hover pivot / tooltip lift /
 * close-up, and how far the visitor may look around. Every environment has one (`environment/config.ts`); the tab an
 * object opens never depends on it.
 */
/** Where an object stands in an outdoor world: its base on the ground, turned about y. */
export interface Placement {
  pos: V3;
  rotY: number;
}

export interface EnvLayout {
  /** The wide shot of the whole environment. */
  world: Pose;
  /** Portrait screens see less sideways, so the wide shot steps back. */
  worldNarrow: Pose;
  anchors: Record<ObjectId, V3>;
  pivot: Record<ObjectId, V3>;
  tipLift: Record<ObjectId, number>;
  focus: Record<ObjectId, Pose>;
  orbit: OrbitLimits;
  /** Where each object stands (its drawing is modelled about its own base; `pivot` is in that frame). */
  place: Record<ObjectId, Placement>;
  /**
   * An invisible box (width, height, depth, about the base) that takes the pointer for each object, so a small object
   * far away is still easy to hit with a finger.
   */
  hit: Record<ObjectId, V3>;
  /** Camera near / far planes (a world is hundreds of metres across). */
  clip: readonly [number, number];
  /**
   * The cinematic way into Overview. `approach` frames the observatory, `align` looks along
   * the telescope at the ship, `ship` is close to the distant ship, where the detailed CoreStage takes over.
   */
  observatory: ObservatoryPoses;
  /** The helpers' bench, the world's way to the Cockpit: a gateway, so it is placed here and not as an object. */
  bench: GatewayPlace;
}

export interface GatewayPlace {
  place: Placement;
  anchor: V3;
  tip: number;
  hit: V3;
}

export interface ObservatoryPoses {
  approach: Pose;
  align: Pose;
  ship: Pose;
  /** Where the observatory stands, its tooltip anchor and lift, its hit box (w, h, d). */
  place: Placement;
  anchor: V3;
  tip: number;
  hit: V3;
}
