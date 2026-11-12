import { easeInOutCubic, FOCUS_MS, lerpPose, type EnvLayout, type Pose } from '../layout';
import type { ObjectId } from '../registry';

/**
 * The camera's explicit states. Pure: the rig in `WorkspaceCanvas` samples a
 * plan every frame, so the same plan always yields the same poses (and tests can walk it without three.js).
 *
 *  - `world`: the wide shot, the visitor may look around.
 *  - `object-focus`: flying to, or framed on, a dashboard object.
 *  - `review-gateway-approach`: flying to the Code Review gateway.
 *  - `observatory-approach` → `ship-approach` → `overview`: the cinematic way into Overview.
 *  - `returning`: on the way back to the wide shot.
 */
export type CameraState =
  | 'world'
  | 'object-focus'
  | 'observatory-approach'
  | 'ship-approach'
  | 'overview'
  | 'review-gateway-approach'
  | 'returning';

/** One leg of a flight: ease from wherever the previous leg ended to `to`, over `ms`. */
export interface Segment {
  state: CameraState;
  to: Pose;
  ms: number;
}

export interface FlightPlan {
  /** The object the flight ends at; null = the wide shot. */
  id: ObjectId | null;
  segments: readonly Segment[];
  /** The state once the last leg lands. */
  arrive: CameraState;
}

/** Starting values: tuned by eye later, never hard requirements. */
export const CAMERA_MS = {
  objectFocus: FOCUS_MS,
  reviewGateway: FOCUS_MS,
  returning: FOCUS_MS,
  /** World to observatory (700–950). */
  observatory: 850,
  /** Telescope alignment (500–700). */
  align: 600,
  /** Observatory to the distant ship (900–1300). */
  ship: 1200,
  /** Overview back to the observatory, then to the world (900–1200 together with the next leg). */
  backToObservatory: 650,
  backToWorld: 900,
} as const;

/** The object whose route is Overview: its flight ends at the ship when the world has an observatory. */
const OVERVIEW: ObjectId = 'plant';

export interface FlightContext {
  /** The camera's state when the flight starts (where it comes from decides the way back). */
  from?: CameraState;
  /** Overview was asked for through the observatory (its telescope), not the Overview object. */
  via?: 'observatory' | null;
}

/**
 * The flight to `target` (an object, or null for the wide shot). `instant` lands every leg at once: a deep link
 * (the page is already open, nobody sees the camera), the first frame, or reduced motion.
 *
 * Overview is the ship: through the observatory the camera approaches it, aligns with
 * the telescope and travels to the ship; through the Overview object it frames the object, then lifts to the ship.
 * Leaving Overview passes the observatory again on the way back.
 */
export function planFlight(
  layout: EnvLayout,
  world: Pose,
  target: ObjectId | null,
  instant: boolean,
  ctx: FlightContext = {},
): FlightPlan {
  const ms = (n: number) => (instant ? 0 : n);
  const obs = layout.observatory;
  const leaving = ctx.from === 'overview';
  const back: Segment[] = leaving
    ? [{ state: 'returning', to: obs.align, ms: ms(CAMERA_MS.backToObservatory) }]
    : [];

  if (target === null) {
    return {
      id: null,
      segments: [
        ...back,
        {
          state: 'returning',
          to: world,
          ms: ms(leaving ? CAMERA_MS.backToWorld : CAMERA_MS.returning),
        },
      ],
      arrive: 'world',
    };
  }
  if (target === OVERVIEW) {
    if (ctx.from === 'overview') return { id: target, segments: [], arrive: 'overview' };
    const lead: Segment[] =
      ctx.via === 'observatory'
        ? [
            { state: 'observatory-approach', to: obs.approach, ms: ms(CAMERA_MS.observatory) },
            { state: 'observatory-approach', to: obs.align, ms: ms(CAMERA_MS.align) },
          ]
        : [{ state: 'object-focus', to: layout.focus[target], ms: ms(CAMERA_MS.objectFocus) }];
    return {
      id: target,
      segments: [...lead, { state: 'ship-approach', to: obs.ship, ms: ms(CAMERA_MS.ship) }],
      arrive: 'overview',
    };
  }
  const gateway = target === 'review';
  return {
    id: target,
    segments: [
      ...back,
      {
        state: gateway ? 'review-gateway-approach' : 'object-focus',
        to: layout.focus[target],
        ms: ms(gateway ? CAMERA_MS.reviewGateway : CAMERA_MS.objectFocus),
      },
    ],
    arrive: 'object-focus',
  };
}

/**
 * Where the arrival starts: a little further back and higher than the wide shot, so the camera settles into the room.
 * Small on purpose, because the wide shot is what a returning visitor expects to see.
 */
export function arrivalPose(world: Pose): Pose {
  const back = 0.07;
  const [x, y, z] = world.pos;
  const [lx, ly, lz] = world.look;
  return {
    ...world,
    pos: [x + (x - lx) * back, y + (y - ly) * back + 0.15, z + (z - lz) * back],
  };
}

export interface FlightSample {
  pose: Pose;
  state: CameraState;
  done: boolean;
}

/** Total length of a plan, ms. */
export const planMs = (plan: FlightPlan): number => plan.segments.reduce((n, s) => n + s.ms, 0);

/**
 * Where a flight that started at `from` is after `elapsed` ms. Each leg eases on its own, so the camera slows into
 * every intermediate pose rather than cutting corners. A flight is always started from the camera's current
 * pose, so a new target mid-flight (Back pressed halfway) just turns around: nothing snaps.
 */
export function sampleFlight(from: Pose, plan: FlightPlan, elapsed: number): FlightSample {
  let start = from;
  let t0 = 0;
  for (const seg of plan.segments) {
    if (seg.ms > 0 && elapsed < t0 + seg.ms) {
      const t = (elapsed - t0) / seg.ms;
      return {
        pose: lerpPose(start, seg.to, easeInOutCubic(Math.max(0, t))),
        state: seg.state,
        done: false,
      };
    }
    start = seg.to;
    t0 += seg.ms;
  }
  return { pose: start, state: plan.arrive, done: true };
}
