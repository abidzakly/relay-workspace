import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  MathUtils,
  type Group,
  type Mesh,
} from 'three';
import type { EnvId } from '../envFor';
import { noticeTexture } from '../environment/worldTextures';
import type { V3 } from '../layout';
import { useCanvasTexture } from '../scene/Interactive';
import { TONE_COLOR } from '../scene/palette';
import { Ball, Box, Panel } from '../scene/parts';
import { reviewTexture } from '../scene/textures';
import type { Dart, SceneData, Tone } from '../signals';
import { useCelebration } from '../world/useCelebration';
import { usePulse } from '../world/usePulse';
import { useWorldEvents } from '../world/useWorldEvents';
import { EVENT_COLOR, type WorldEventKind } from '../worldEvents';

/**
 * Building blocks shared by every world's objects: each turns one piece of `SceneData` into something
 * physical, the same way everywhere, so five environments never re-implement what a number means. The models around
 * them differ; the meaning does not.
 */

/** Damps a value towards a goal every frame (instant when not animating). */
export function useDamp(goal: number, k: number, animate: boolean, apply: (v: number) => void) {
  const v = useRef(goal);
  useFrame((_, dt) => {
    v.current = animate ? MathUtils.damp(v.current, goal, k, dt) : goal;
    apply(v.current);
  });
}

/** A triangle in the yz plane: foot along -z from the origin, luff up y. For sails and pennants. */
export function useTriangle(height: number, foot: number) {
  const g = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 0, height, 0, 0, 0, -foot]), 3),
    );
    geo.computeVertexNormals();
    return geo;
  }, [height, foot]);
  useEffect(() => () => g.dispose(), [g]);
  return g;
}

/** The sprint's share as a sail's height (furled when there is no sprint). */
export const sailScale = (fill: number | null): number => (fill === null ? 0.1 : 0.2 + fill * 0.8);

/** A sail that rises with the sprint (Sprint Harbor in every world with a boat). */
export function Sail({
  fill,
  animate,
  height,
  foot,
  color = '#fbf7ee',
  position,
}: {
  fill: number | null;
  animate: boolean;
  height: number;
  foot: number;
  color?: string;
  position?: V3;
}) {
  const ref = useRef<Group>(null);
  const geo = useTriangle(height, foot);
  const goal = sailScale(fill);
  useDamp(goal, 3, animate, (v) => ref.current?.scale.setY(v));
  return (
    <group ref={ref} position={position ? [...position] : undefined} scale={[1, goal, 1]}>
      <mesh geometry={geo} castShadow>
        <meshStandardMaterial color={color} side={DoubleSide} flatShading />
      </mesh>
    </group>
  );
}

/** A gentle bob and roll on water. */
export function useFloat(ref: React.RefObject<Group | null>, animate: boolean, roll = 0.04) {
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g || !animate) return;
    const t = clock.elapsedTime;
    g.rotation.z = Math.sin(t * 0.9) * roll;
    g.position.y = Math.sin(t * 1.3) * 0.03;
  });
}

/** Status lights in a tone, blinking while `running` (sync towers, antennas, beacons). */
export function StatusLights({
  tone,
  running,
  animate,
  points,
  r = 0.08,
}: {
  tone: Tone;
  running: boolean;
  animate: boolean;
  points: readonly V3[];
  r?: number;
}) {
  const ref = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (ref.current)
      ref.current.visible = !running || !animate || Math.floor(clock.elapsedTime * 2.5) % 2 === 0;
  });
  return (
    <group ref={ref}>
      {points.map((p, i) => (
        <Ball
          key={i}
          r={r}
          position={[...p]}
          color={TONE_COLOR[tone]}
          emissive={TONE_COLOR[tone]}
          emissiveIntensity={tone === 'idle' ? 0.2 : 2.2}
          shadow={false}
          noGlow
        />
      ))}
    </group>
  );
}

/** A printer's moving head and growing print, on any base (Builds). */
export function PrintRig({
  data,
  animate,
  color = '#f2a531',
  scale = 1,
}: {
  data: SceneData;
  animate: boolean;
  color?: string;
  scale?: number;
}) {
  const head = useRef<Group>(null);
  const print = useRef<Mesh>(null);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const running = data.buildRunning && animate;
    if (head.current) {
      head.current.position.x = running ? Math.sin(t * 2.2) * 0.13 : 0;
      head.current.position.z = running ? Math.cos(t * 1.7) * 0.1 : 0;
    }
    if (print.current) {
      const goal = data.buildRunning ? 0.4 + ((t * 0.05) % 0.6) : 0.2;
      print.current.scale.y = running ? goal : MathUtils.damp(print.current.scale.y, 0.2, 2, dt);
    }
  });
  return (
    <group scale={scale}>
      <Box size={[0.55, 0.06, 0.5]} position={[0, 0.03, 0]} color="#2b2f36" />
      {[-0.25, 0.25].map((x) => (
        <Box key={x} size={[0.04, 0.55, 0.04]} position={[x, 0.3, -0.2]} color="#7b7f86" />
      ))}
      <Box size={[0.55, 0.04, 0.04]} position={[0, 0.56, -0.2]} color="#7b7f86" />
      <mesh ref={print} position={[0, 0.06, 0]} scale={[1, 0.2, 1]}>
        <boxGeometry args={[0.14, 0.3, 0.14]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      <group ref={head} position={[0, 0.42, 0]}>
        <Box size={[0.1, 0.08, 0.1]} color="#d9d4cc" />
        <Ball
          r={0.018}
          position={[0, -0.05, 0]}
          color="#ff8a3d"
          emissive="#ff6a1a"
          emissiveIntensity={data.buildRunning ? 2.5 : 0}
          noGlow
        />
      </group>
    </group>
  );
}

/** Slides a group open along an axis while `open` (drawers, lids, doors). */
export function Slide({
  open,
  animate,
  to,
  children,
}: {
  open: boolean;
  animate: boolean;
  /** Offset when open. */
  to: V3;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  useDamp(open ? 1 : 0, 5, animate, (v) =>
    ref.current?.position.set(to[0] * v, to[1] * v, to[2] * v),
  );
  return (
    <group ref={ref} position={open ? [...to] : [0, 0, 0]}>
      {children}
    </group>
  );
}

/** Turns a group about x while `open` (a chest's lid). */
export function Hinge({
  open,
  animate,
  angle,
  position,
  children,
}: {
  open: boolean;
  animate: boolean;
  angle: number;
  position?: V3;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  useDamp(open ? angle : 0, 5, animate, (v) => ref.current?.rotation.set(v, 0, 0));
  return (
    <group
      ref={ref}
      position={position ? [...position] : undefined}
      rotation={[open ? angle : 0, 0, 0]}
    >
      {children}
    </group>
  );
}

/** Papers peeking out when there are writes that can be undone (Audit). */
export function Papers({
  count = 3,
  width = 0.5,
  depth = 0.34,
}: {
  count?: number;
  width?: number;
  depth?: number;
}) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Box
          key={i}
          size={[width, 0.02, depth]}
          position={[0, i * 0.012, i * 0.02]}
          rotation={[0, 0, (i - 1) * 0.05]}
          color="#fbf7ee"
          shadow={false}
        />
      ))}
    </>
  );
}

/** Board: the columns and first cards, on any surface (cork, glass, chalk, a departures board). */
export function BoardFace({
  data,
  stowed,
  w,
  h,
  style,
  glow = 0.55,
}: {
  data: SceneData;
  stowed: boolean;
  w: number;
  h: number;
  style: { backing: string; ink: string; heading: string };
  glow?: number;
}) {
  const key = `${stowed}|${style.backing}|${data.columns
    .map((c) => `${c.name}:${c.count}:${c.notes.map((n) => n.id).join(',')}`)
    .join('|')}`;
  const map = useCanvasTexture(() => noticeTexture(data.columns, { ...style, stowed }), key);
  return <Panel size={[w, h]} map={map} glow={glow} />;
}

/** The Code Review gateway's screen: the reviews requested of me, themed per environment. */
export function ReviewFace({
  data,
  env,
  stowed,
  w,
  h,
}: {
  data: SceneData;
  env: EnvId;
  stowed: boolean;
  w: number;
  h: number;
}) {
  const r = data.reviews;
  const key = `${env}|${stowed}|${r.count}|${r.titles.join('\u0000')}|${data.signals.review.tone}`;
  const map = useCanvasTexture(() => reviewTexture(data, env, stowed), key);
  return <Panel size={[w, h]} map={map} glow={stowed ? 0.25 : 0.95} />;
}

/**
 * The gateway's reaction to real engineering events: a pulse ring of `radius` at height `y`, plus an
 * optional handler for the environment's own story (a bell, a light, a shuttle). Quiet on off-duty days.
 */
export function GatewayPulse({
  data,
  env,
  animate,
  radius,
  y = 0.02,
  onEvent,
}: {
  data: SceneData;
  env: EnvId;
  animate: boolean;
  radius: number;
  y?: number;
  onEvent?: (kind: WorldEventKind, strength: number) => void;
}) {
  const pulse = usePulse(2.2);
  useWorldEvents({
    env,
    animate,
    reviewKeys: data.reviews.keys,
    onEvent: (kind, strength) => {
      pulse.fire(EVENT_COLOR[kind], strength);
      onEvent?.(kind, strength);
    },
  });
  return (
    <mesh ref={pulse.ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} visible={false}>
      <ringGeometry args={[radius * 0.82, radius, 48]} />
      <meshBasicMaterial
        transparent
        opacity={0}
        side={DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Where an arrow (or a needle) lands for a KPI score: centre at 1, further out as it falls; null = no data. */
export function scoreRadius(d: Dart, radius: number): number | null {
  return d.score === null ? null : (1 - d.score) * radius * 0.92;
}

/**
 * A train of cars following a closed path (Release Train in every world): it waits when nothing is pending and runs
 * with one car per pending release (max 6), slowly.
 */
export function PathTrain({
  wagons,
  animate,
  path,
  spacing,
  head,
  car,
  start = 0,
  burst,
  progress = null,
}: {
  /** Release progress: a completed release sends the train on a quick completion lap. */
  progress?: number | null;
  /** Seconds left of an extra run (an event's departure), even with nothing pending. */
  burst?: { current: number };
  wagons: number;
  animate: boolean;
  /** t (radians, one lap = 2π) → position and heading. */
  path: (t: number) => { x: number; y: number; z: number; yaw: number };
  spacing: number;
  head: ReactNode;
  car: (i: number) => ReactNode;
  start?: number;
}) {
  const ref = useRef<Group>(null);
  const t = useRef(start);
  const celebration = useCelebration(progress, animate);
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.1);
    if (animate && celebration.tick(dt) !== null) t.current += step * 1.4;
    if (animate && wagons > 0) t.current += step * (0.18 + wagons * 0.02);
    else if (animate && burst && burst.current > 0) t.current += step * 0.5;
    if (burst && burst.current > 0) burst.current = Math.max(0, burst.current - step);
    const g = ref.current;
    if (!g) return;
    g.children.forEach((c, i) => {
      const p = path(t.current - i * spacing);
      c.position.set(p.x, p.y, p.z);
      c.rotation.y = p.yaw;
    });
  });
  return (
    <group ref={ref}>
      <group>{head}</group>
      {Array.from({ length: wagons }, (_, i) => (
        <group key={i}>{car(i)}</group>
      ))}
    </group>
  );
}

/** An ellipse path (centre-relative), for `PathTrain`. */
export const ellipsePath =
  (rx: number, rz: number, y = 0) =>
  (t: number) => ({
    x: Math.cos(t) * rx,
    y,
    z: Math.sin(t) * rz,
    yaw: Math.atan2(-Math.sin(t) * rx, Math.cos(t) * rz),
  });

/** A path back and forth on a straight line (a funicular, a shuttle), for `PathTrain`: t → position on [a, b]. */
export const shuttlePath = (a: V3, b: V3) => (t: number) => {
  const k = (1 - Math.cos(t)) / 2;
  return {
    x: a[0] + (b[0] - a[0]) * k,
    y: a[1] + (b[1] - a[1]) * k,
    z: a[2] + (b[2] - a[2]) * k,
    yaw: Math.atan2(b[0] - a[0], b[2] - a[2]),
  };
};

/**
 * MR Inbox as a mailbox: letters = my open MRs (up to 4); the flag rises while something waits on me; a light in the
 * inbox's tone. Dressed per world (`body`, `post`, `roof`).
 */
export function Mailbox({
  data,
  animate,
  body,
  door,
  post,
  roof,
}: {
  data: SceneData;
  animate: boolean;
  body: string;
  door: string;
  post: string;
  roof?: string;
}) {
  const sig = data.signals.monitor;
  const letters = Math.min(4, data.mrTitles.length);
  const flagUp = (sig.badge ?? 0) > 0;
  const flag = useRef<Group>(null);
  useDamp(flagUp ? 0 : -Math.PI / 2, 6, animate, (v) => flag.current?.rotation.set(0, 0, v));
  return (
    <group>
      <Box size={[0.12, 1.0, 0.12]} position={[0, 0.5, 0]} color={post} />
      <group position={[0, 1.05, 0]}>
        <Box size={[0.4, 0.34, 0.56]} color={body} />
        {roof && (
          <Box size={[0.5, 0.06, 0.66]} position={[0, 0.22, 0]} rotation={[0, 0, 0]} color={roof} />
        )}
        <Box size={[0.36, 0.3, 0.02]} position={[0, 0, 0.29]} color={door} />
        {Array.from({ length: letters }, (_, i) => (
          <Box
            key={i}
            size={[0.22, 0.01, 0.14]}
            position={[-0.05 + i * 0.035, 0.07 + i * 0.012, 0.3 + i * 0.01]}
            rotation={[0.5, 0, 0.12 * (i - 1.5)]}
            color="#fbf7ee"
            shadow={false}
          />
        ))}
        <group
          ref={flag}
          position={[0.21, 0.0, -0.12]}
          rotation={[0, 0, flagUp ? 0 : -Math.PI / 2]}
        >
          <Box size={[0.02, 0.36, 0.02]} position={[0, 0.18, 0]} color="#d9d4cc" />
          <Box size={[0.02, 0.12, 0.14]} position={[0, 0.3, 0.07]} color="#d6453d" />
        </group>
        <Ball
          r={0.035}
          position={[0, 0.3, 0.22]}
          color={TONE_COLOR[sig.tone]}
          emissive={TONE_COLOR[sig.tone]}
          emissiveIntensity={sig.tone === 'idle' ? 0 : 1.8}
          shadow={false}
          noGlow
        />
      </group>
    </group>
  );
}

/** One KPI's arrow, stuck in a target face of `radius` at `angle`, or nothing while it has no data. */
export function Arrow({
  d,
  radius,
  angle,
  length = 0.6,
}: {
  d: Dart;
  radius: number;
  angle: number;
  length?: number;
}) {
  const r = scoreRadius(d, radius);
  if (r === null) return null;
  return (
    <group position={[Math.cos(angle) * r, Math.sin(angle) * r, 0]} rotation={[0.25, -0.15, 0]}>
      <mesh position={[0, 0, length / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.012, 0.012, length, 5]} />
        <meshStandardMaterial color="#5b4636" flatShading />
      </mesh>
      <Box
        size={[0.08, 0.005, 0.12]}
        position={[0, 0, length - 0.04]}
        color="#d6453d"
        shadow={false}
      />
      <Box
        size={[0.005, 0.08, 0.12]}
        position={[0, 0, length - 0.04]}
        color="#f4f1ea"
        shadow={false}
      />
    </group>
  );
}
