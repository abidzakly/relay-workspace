import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Euler, Quaternion, type Group } from 'three';
import type { AvatarActivity } from '../environment/config';
import { KEYBOARD, MOUSE, SEAT_ORIGIN } from '../layout';
import { Box, Cyl } from './parts';

/**
 * The seated, blocky avatar, in the chair's frame (see `SEAT_ORIGIN`; it faces -z, towards the desk). It is never
 * still: every few seconds it moves on to another activity (typing, the mouse, a stretch, a wave, a think…) and blends
 * into it, while it breathes and blinks throughout. Off duty it holds a mug; on a sick day it sits under a blanket.
 */

type V3 = [number, number, number];

/** forward swing (positive = arm forward), sideways spread (positive = towards +x), elbow bend (positive = forearm forward). */
type Arm = [forward: number, side: number, elbow: number];
interface Pose {
  /** Torso pitch (negative leans towards the desk) and yaw. */
  lean: number;
  yaw: number;
  /** Head pitch (negative looks down), yaw (negative turns to +x), roll. */
  head: V3;
  l: Arm;
  r: Arm;
  /** 1 open, 0 shut. */
  eyes: number;
  /** How far the mug is tipped towards the mouth. */
  sip: number;
  /** 1 = a mug is in the right hand (off duty all day; at home for a coffee break). */
  hold: number;
}

const UPPER = 0.24; // shoulder → elbow
const FORE = 0.3; // elbow → centre of the hand
const BODY_Y = 0.62; // the torso's pivot, in the chair's frame
const BODY_Z = 0.02;
const SHOULDER_Y = 0.42; // above the torso's pivot
const SHOULDER_X = 0.25;
const LEAN = -0.12; // at work, leaning in a little
const HAND = 0.04; // half the hand's height: the palm rests on the keys

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Two-bone reach: the forward swing and elbow bend that put the hand at (y, z) in the chair's frame, elbow down. */
function reach(y: number, z: number, lean: number): [number, number] {
  const sy = BODY_Y + SHOULDER_Y * Math.cos(lean);
  const sz = BODY_Z + SHOULDER_Y * Math.sin(lean);
  const fwd = sz - z;
  const drop = sy - y;
  const d = Math.min(Math.hypot(fwd, drop), UPPER + FORE - 1e-3);
  const inner = Math.acos(clamp((UPPER ** 2 + FORE ** 2 - d * d) / (2 * UPPER * FORE), -1, 1));
  const alpha = Math.asin(clamp((FORE * Math.sin(inner)) / d, -1, 1));
  return [Math.atan2(fwd, drop) - alpha - lean, Math.PI - inner];
}

/** The keyboard and mouse, from the world into the chair's frame. */
const KEY_Y = KEYBOARD[1] + HAND;
const KEY_Z = KEYBOARD[2] - SEAT_ORIGIN[2];
const [TYPE_A, TYPE_E] = reach(KEY_Y, KEY_Z, LEAN);
const [MOUSE_A, MOUSE_E] = reach(KEY_Y, MOUSE[2] - SEAT_ORIGIN[2], LEAN);
const MOUSE_SIDE = Math.asin(clamp((MOUSE[0] - SHOULDER_X) / (UPPER + FORE), -1, 1));

const pose = (p: Partial<Pose>): Pose => ({
  lean: LEAN,
  yaw: 0,
  head: [-0.12, 0, 0],
  l: [TYPE_A, 0.06, TYPE_E],
  r: [TYPE_A, -0.06, TYPE_E],
  eyes: 1,
  sip: 0,
  hold: 0,
  ...p,
});

/** Typing: the two hands patter out of step. */
const typing = (u: number, speed = 15): Pick<Pose, 'l' | 'r'> => ({
  l: [TYPE_A + Math.sin(u * speed) * 0.03, 0.06, TYPE_E + Math.sin(u * speed) * 0.06],
  r: [TYPE_A + Math.sin(u * speed + 1.7) * 0.03, -0.06, TYPE_E + Math.sin(u * speed + 1.7) * 0.06],
});

interface Act {
  len: [number, number];
  pose: (u: number) => Pose;
}

// At work.
const TYPE: Act = {
  len: [5, 9],
  pose: (u) => pose({ head: [-0.12, Math.sin(u * 0.4) * 0.1, 0], ...typing(u) }),
};
const WORK: Act[] = [
  // On the mouse, scrolling and clicking.
  {
    len: [3, 5],
    pose: (u) =>
      pose({
        yaw: -0.05,
        head: [-0.1, -0.08, 0],
        r: [MOUSE_A + Math.sin(u * 2.3) * 0.03, MOUSE_SIDE + Math.sin(u * 1.3) * 0.04, MOUSE_E],
      }),
  },
  // Chin in hand, looking up, thinking.
  {
    len: [3, 5],
    pose: (u) =>
      pose({
        lean: 0.04,
        head: [0.18, 0.15, 0.12 + Math.sin(u * 0.8) * 0.04],
        l: [TYPE_A * 0.85, 0.08, TYPE_E],
        r: [0.35, -0.45, 2.55],
      }),
  },
  // A big stretch, arms overhead.
  {
    len: [2.5, 3],
    pose: (u) =>
      pose({
        lean: 0.16,
        head: [0.3, 0, 0],
        l: [0, -2.8 + Math.sin(u * 2) * 0.08, 0.15],
        r: [0, 2.8 + Math.sin(u * 2) * 0.08, 0.15],
        eyes: 0,
      }),
  },
  // Looking round, hands resting on the keys.
  {
    len: [3, 4.5],
    pose: (u) => pose({ lean: -0.04, head: [0.05, Math.sin(u * 0.9) * 0.7, 0] }),
  },
  // A wave over the shoulder, towards the camera.
  {
    len: [2.2, 2.8],
    pose: (u) =>
      pose({
        yaw: -0.25,
        head: [0.08, -0.7, 0],
        r: [0.15, 2.3 + Math.sin(u * 9) * 0.3, 0.5 + Math.sin(u * 9) * 0.2],
      }),
  },
  // Nodding along to music while typing slowly.
  {
    len: [4, 6],
    pose: (u) =>
      pose({
        yaw: Math.sin(u * Math.PI * 1.8) * 0.06,
        head: [-0.05 - Math.abs(Math.sin(u * Math.PI * 1.8)) * 0.14, 0, 0],
        ...typing(u, 7),
      }),
  },
];

// Off duty, with a mug.
const holding = (p: Partial<Pose>): Pose =>
  pose({
    lean: 0.08,
    head: [0, 0, 0],
    l: [0.55, 0.35, 1.2],
    r: [0.55, -0.35, 1.2],
    hold: 1,
    ...p,
  });
const HOLD: Act = {
  len: [4, 7],
  pose: (u) => holding({ head: [-0.05, Math.sin(u * 0.35) * 0.15, 0] }),
};
const LEAVE: Act[] = [
  // A sip: the mug comes up to the mouth and tips.
  {
    len: [3.5, 4],
    pose: (u) => {
      const up = u > 0.6 && u < 2.8;
      return holding({
        head: up ? [0.15, 0, 0] : [0, 0, 0],
        l: [0.3, 0.2, 0.8],
        r: up ? [0.4, -0.55, 2.3] : [0.55, -0.35, 1.2],
        eyes: up ? 0.2 : 1,
        sip: up ? 0.6 : 0,
      });
    },
  },
  {
    len: [3, 4.5],
    pose: (u) => holding({ head: [0.08, Math.sin(u * 0.9) * 0.7, 0] }),
  },
  {
    len: [2.2, 2.8],
    pose: (u) =>
      holding({
        yaw: -0.2,
        head: [0.08, -0.6, 0],
        l: [0.15, -2.3 - Math.sin(u * 9) * 0.3, 0.5 + Math.sin(u * 9) * 0.2],
      }),
  },
  // Dozing off, then a start.
  {
    len: [4, 5],
    pose: (u) =>
      holding({
        lean: 0.14,
        head: u < 3.4 ? [-0.35 + Math.sin(u * 1.2) * 0.05, 0, 0.15] : [0.1, 0, 0],
        eyes: u < 3.4 ? 0.05 : 1,
      }),
  },
];

// Sick, under a blanket: the arms hug the body, only the head and shoulders move.
const wrapped = (p: Partial<Pose>): Pose =>
  pose({
    lean: 0.1,
    head: [-0.08, 0, 0.06],
    l: [0.4, 0.45, 1.4],
    r: [0.4, -0.45, 1.4],
    eyes: 0.6,
    ...p,
  });
const REST: Act = {
  len: [5, 8],
  pose: (u) => wrapped({ head: [-0.08, Math.sin(u * 0.3) * 0.12, 0.06] }),
};
const SICK: Act[] = [
  {
    len: [4, 6],
    pose: (u) =>
      wrapped({ lean: 0.15, head: [-0.4 + Math.sin(u * 1.1) * 0.05, 0, 0.2], eyes: 0.05 }),
  },
  // A shiver.
  {
    len: [2, 2.5],
    pose: (u) => wrapped({ yaw: Math.sin(u * 40) * 0.05 * (u < 1.5 ? 1 : 0), eyes: 0.3 }),
  },
  // A sniffle: the head jerks back twice.
  {
    len: [2.5, 3],
    pose: (u) => wrapped({ head: [u % 1.1 < 0.25 ? 0.2 : -0.1, 0, 0.06], eyes: 0.4 }),
  },
  {
    len: [3, 4],
    pose: (u) => wrapped({ head: [0, Math.sin(u * 0.7) * 0.5, 0], eyes: 0.6 }),
  },
];

// At home: the work day, with a coffee break now and then. The mug comes out only for the break.
const COFFEE: Act = {
  len: [4.5, 5.5],
  pose: (u) => {
    const up = u > 0.9 && u < 3.4;
    return pose({
      lean: 0.06,
      head: up ? [0.12, 0, 0] : [-0.05, 0.1, 0],
      l: [TYPE_A * 0.9, 0.06, TYPE_E],
      r: up ? [0.4, -0.55, 2.3] : [0.55, -0.35, 1.2],
      eyes: up ? 0.3 : 1,
      sip: up ? 0.6 : 0,
      hold: 1,
    });
  },
};

const SETS = {
  work: { base: TYPE, moves: WORK },
  home: { base: TYPE, moves: [...WORK, COFFEE, COFFEE] },
  leave: { base: HOLD, moves: LEAVE },
  sick: { base: REST, moves: SICK },
};

const copy = (p: Pose): Pose => ({ ...p, head: [...p.head], l: [...p.l], r: [...p.r] });

/** The arrival's look up: how long it lasts (s) and how far the head tips back (rad). */
const GREET_S = 1.4;
const GREET_PITCH = 0.24;

export function Avatar({
  activity,
  animate,
  color,
  greet = false,
}: {
  /** The environment's activity set (`environment/config.ts`). */
  activity: AvatarActivity;
  animate: boolean;
  color: string | null;
  /** Look up once when this turns true: someone just arrived. */
  greet?: boolean;
}) {
  const sick = activity === 'sick';
  // A mug can be in hand for every set but the sick one (the blanket wraps the arms).
  const mugInHand = !sick;
  const set = SETS[activity];
  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const eyes = useRef<Group>(null);
  const shoulderL = useRef<Group>(null);
  const shoulderR = useRef<Group>(null);
  const elbowL = useRef<Group>(null);
  const elbowR = useRef<Group>(null);
  const mug = useRef<Group>(null);
  const cur = useRef<Pose>(copy(set.base.pose(0)));
  /** The activity in hand, when it began and ends; the last move (so it never repeats); the next blink. */
  const plan = useRef({
    set,
    act: set.base,
    start: 0,
    end: -1,
    last: null as Act | null,
    blink: 3,
  });

  const greetStart = useRef<number | null>(null);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const s = plan.current;
    if (greet && greetStart.current === null) greetStart.current = t;
    const sinceGreet = greetStart.current === null ? GREET_S : t - greetStart.current;
    const lookUp =
      animate && sinceGreet < GREET_S
        ? Math.sin((sinceGreet / GREET_S) * Math.PI) * GREET_PITCH
        : 0;
    // A new situation (off duty, sick) starts over from its resting activity.
    if (s.set !== set) Object.assign(s, { set, act: set.base, end: -1, last: null });
    if (s.end < 0) {
      s.start = t;
      s.end = t + rand(...s.act.len);
    }
    if (animate && t >= s.end) {
      // Base, a move, base, another move…
      if (s.act === set.base) {
        const pool = set.moves.filter((m) => m !== s.last);
        s.act = pool[Math.floor(Math.random() * pool.length)] ?? set.base;
        s.last = s.act;
      } else s.act = set.base;
      s.start = t;
      s.end = t + rand(...s.act.len);
    }

    const target = animate ? s.act.pose(t - s.start) : set.base.pose(0);
    const k = animate ? 1 - Math.exp(-7 * dt) : 1;
    const c = cur.current;
    const mix = (a: number, b: number) => a + (b - a) * k;
    c.lean = mix(c.lean, target.lean);
    c.yaw = mix(c.yaw, target.yaw);
    c.eyes = mix(c.eyes, target.eyes);
    c.sip = mix(c.sip, target.sip);
    c.hold = target.hold;
    if (mug.current) mug.current.visible = c.hold > 0.5;
    for (let i = 0; i < 3; i++) {
      c.head[i] = mix(c.head[i]!, target.head[i]! + (i === 0 ? lookUp : 0));
      c.l[i] = mix(c.l[i]!, target.l[i]!);
      c.r[i] = mix(c.r[i]!, target.r[i]!);
    }

    if (body.current) {
      body.current.rotation.set(c.lean, c.yaw, 0);
      body.current.scale.y = animate ? 1 + Math.sin(t * 1.6) * 0.012 : 1;
    }
    head.current?.rotation.set(...c.head);
    shoulderL.current?.rotation.set(c.l[0], 0, c.l[1]);
    shoulderR.current?.rotation.set(c.r[0], 0, c.r[1]);
    elbowL.current?.rotation.set(c.l[2], 0, 0);
    elbowR.current?.rotation.set(c.r[2], 0, 0);

    // A blink every few seconds.
    if (animate && t > s.blink + 0.12) s.blink = t + rand(2.5, 5);
    const blinking = animate && t > s.blink;
    if (eyes.current) eyes.current.scale.y = Math.max(0.08, blinking ? 0.08 : c.eyes);

    // The mug stays upright in the hand, whatever the arm does, and tips towards the mouth for a sip.
    if (mug.current?.parent && root.current) {
      const hand = mug.current.parent.getWorldQuaternion(new Quaternion());
      const frame = root.current.getWorldQuaternion(new Quaternion());
      mug.current.quaternion
        .copy(hand.invert().multiply(frame))
        .multiply(new Quaternion().setFromEuler(new Euler(c.sip, 0, 0)));
    }
  });

  const skin = '#e0b48f';
  const shirt = color ?? '#d9963a';
  const pants = '#2e3442';
  const sleeve = sick ? '#efe6d6' : shirt;
  const arm = (side: -1 | 1) => (
    <group ref={side < 0 ? shoulderL : shoulderR} position={[side * SHOULDER_X, SHOULDER_Y, 0]}>
      <Box size={[0.1, UPPER + 0.02, 0.1]} position={[0, -UPPER / 2, 0]} color={sleeve} />
      <group ref={side < 0 ? elbowL : elbowR} position={[0, -UPPER, 0]}>
        <Box
          size={[0.09, FORE - 0.04, 0.09]}
          position={[0, -(FORE - 0.04) / 2, 0]}
          color={sleeve}
        />
        <Box size={[0.09, HAND * 2, 0.1]} position={[0, -FORE, 0]} color={skin} />
        {side > 0 && mugInHand && (
          <group ref={mug} position={[0, -FORE, -0.02]}>
            <Cyl r={0.05} h={0.11} position={[0, 0.04, 0]} color="#f4f1ea" />
            <Cyl r={0.045} h={0.01} position={[0, 0.095, 0]} color="#8a5a35" shadow={false} />
          </group>
        )}
      </group>
    </group>
  );

  return (
    <group ref={root}>
      {/* legs: thighs forward along the seat, shins down under the desk */}
      <Box size={[0.15, 0.13, 0.42]} position={[-0.1, 0.57, -0.14]} color={pants} />
      <Box size={[0.15, 0.13, 0.42]} position={[0.1, 0.57, -0.14]} color={pants} />
      <Box size={[0.13, 0.5, 0.14]} position={[-0.1, 0.27, -0.33]} color={pants} />
      <Box size={[0.13, 0.5, 0.14]} position={[0.1, 0.27, -0.33]} color={pants} />
      <Box size={[0.14, 0.06, 0.22]} position={[-0.1, 0.03, -0.38]} color="#1f2328" />
      <Box size={[0.14, 0.06, 0.22]} position={[0.1, 0.03, -0.38]} color="#1f2328" />
      <group ref={body} position={[0, BODY_Y, BODY_Z]}>
        <Box size={[0.4, 0.48, 0.24]} position={[0, 0.24, 0]} color={shirt} />
        {sick && <Box size={[0.52, 0.42, 0.34]} position={[0, 0.25, 0.02]} color="#efe6d6" />}
        <group ref={head} position={[0, 0.6, 0]}>
          <Box size={[0.1, 0.08, 0.1]} position={[0, -0.08, 0]} color={skin} />
          <Box size={[0.27, 0.29, 0.27]} position={[0, 0.1, 0]} color={skin} />
          <Box size={[0.29, 0.1, 0.29]} position={[0, 0.26, 0.01]} color="#2b211b" />
          <Box size={[0.29, 0.2, 0.08]} position={[0, 0.16, 0.12]} color="#2b211b" />
          {/* the face looks to -z, at the desk */}
          <group ref={eyes} position={[0, 0.13, -0.137]}>
            <Box
              size={[0.045, 0.055, 0.02]}
              position={[-0.065, 0, 0]}
              color="#1f1a16"
              shadow={false}
            />
            <Box
              size={[0.045, 0.055, 0.02]}
              position={[0.065, 0, 0]}
              color="#1f1a16"
              shadow={false}
            />
          </group>
          <Box
            size={[0.08, 0.02, 0.02]}
            position={[0, 0.03, -0.137]}
            color="#9a5a48"
            shadow={false}
          />
        </group>
        {arm(-1)}
        {arm(1)}
      </group>
    </group>
  );
}
