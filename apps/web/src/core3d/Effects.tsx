import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix4,
  MeshBasicMaterial,
  PointsMaterial,
  SphereGeometry,
  TorusGeometry,
  type Group,
  type InstancedMesh,
  type Mesh,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getEventStream } from '@/lib/sse';
import { hash } from './Dust';
import {
  effectFor,
  EffectQueue,
  type CardMark,
  type CoreMarks,
  type EffectKind,
  type MarkKind,
} from './effectModel';
import { PLATE_THICKNESS, type BlockLocator } from './ModeB';
import type { ProgressSegment } from './progressMapping';
import { sliceGeometry, SLICE_FILL } from './RingSegments';
import { CORE_RADIUS, RADII, RING_ROTATION, TUBE } from './rig';

/**
 * The event-driven and data-driven effects. Under reduced motion no one-shot runs (`StaticEffectNote`
 * stands in) and marks are drawn without flicker. All of it is ordinary scene content, so Full scene ASCII shows it too.
 */

const MAX_FRAME_SECONDS = 0.1;
const DURATION: Record<EffectKind, number> = { pulse: 0.9, spark: 1.3, click: 0.45, release: 3 };

interface RunningEffect {
  kind: EffectKind;
  /** 0 to 1. */
  t: number;
  /** Where a spark starts on the ring. */
  angle: number;
}

/** Subscribes only while animating, so a hidden tab or reduced motion collects nothing to play later. */
export function useEffectEngine(animate: boolean): RefObject<RunningEffect[]> {
  const running = useRef<RunningEffect[]>([]);
  const queue = useRef(new EffectQueue());
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!animate) return;
    const waiting = queue.current;
    const list = running;
    const unsubscribe = getEventStream().subscribe((event) => {
      const kind = effectFor(event);
      if (kind) waiting.push(kind);
    });
    return () => {
      unsubscribe();
      waiting.clear();
      list.current = [];
      invalidate(); // the frame that takes anything still showing off the screen
    };
  }, [animate, invalidate]);

  useFrame((_, delta) => {
    if (!animate) return;
    const dt = Math.min(delta, MAX_FRAME_SECONDS);
    const list = running.current;
    for (const effect of list) effect.t += dt / DURATION[effect.kind];
    if (list.some((effect) => effect.t >= 1)) {
      running.current = list.filter((effect) => effect.t < 1);
    }
    const count = (kind: EffectKind) => running.current.filter((e) => e.kind === kind).length;
    const next = queue.current.next(dt, count);
    if (next) running.current.push({ kind: next, t: 0, angle: Math.random() * Math.PI * 2 });
  });

  return running;
}

const basic = (color: number, side?: typeof DoubleSide) =>
  new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
    ...(side === undefined ? {} : { side }),
  });

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/* ───────────────────────── marks: cracks and SLA risk ───────────────────────── */

/** Instances per component. More marks than this are not drawn. */
const MAX_MARKS = 128;
const SHEATH_KINDS = ['crack', 'amber', 'red'] as const satisfies readonly MarkKind[];
const SHEATH_COLOR: Record<MarkKind, number> = { crack: 0xff2a2a, amber: 0xffb020, red: 0xff3b30 };
const STATIC_OPACITY: Record<MarkKind, number> = { crack: 0.3, amber: 0.45, red: 0.6 };
const CRACK_COLOR = 0xff4040;

const CRACK_PATH = [
  [0.02, -0.5],
  [-0.14, -0.28],
  [0.12, -0.1],
  [-0.1, 0.1],
  [0.13, 0.28],
  [-0.03, 0.5],
] as const;

/** A jagged bolt along local Y. It has volume, because a flat one vanishes when its ring is seen edge-on. */
function crackGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const turn = new Matrix4();
  const at = new Matrix4();
  CRACK_PATH.slice(1).forEach(([x, y], i) => {
    const [fromX, fromY] = CRACK_PATH[i] ?? [x, y];
    const length = Math.hypot(x - fromX, y - fromY);
    const part = new BoxGeometry(0.05, length, 0.05);
    turn.makeRotationZ(Math.atan2(fromX - x, y - fromY));
    at.makeTranslation((x + fromX) / 2, (y + fromY) / 2, 0);
    part.applyMatrix4(at.multiply(turn));
    parts.push(part);
  });
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

const CRACK_GEOMETRY = crackGeometry();
/** A little larger than a plate, so it shows round the edges. Scaled by the plate's matrix. */
const PLATE_SHEATH = new BoxGeometry(1.18, 1.18, PLATE_THICKNESS * 1.5);

/** Places an instance. False when the card has nowhere to be. */
type Place = (cardId: string, out: Matrix4) => boolean;

const placed = new Matrix4();

function flicker(kind: MarkKind, t: number): number {
  switch (kind) {
    case 'amber':
      return 0.3 + 0.3 * (0.5 + 0.5 * Math.sin(t * 5));
    case 'red':
      return Math.sin(t * 11) > 0 ? 0.8 : 0.3;
    case 'crack':
      return 0.15 + 0.1 * (0.5 + 0.5 * Math.sin(t * 3));
  }
}

/** Short irregular spells, so the crack reads as a glitch and not as a steady blink. */
const glitching = (t: number) => (t * 0.37) % 1 > 0.82 || (t * 0.91) % 1 > 0.93;
const JITTER = 0.025;

function Marks({
  marks,
  sheath,
  placeSheath,
  placeCrack,
  animate,
  weight,
}: {
  marks: readonly CardMark[];
  /** None: cracks only. */
  sheath: BufferGeometry | null;
  placeSheath: Place;
  placeCrack: Place;
  animate: boolean;
  /** The mode's share of a cross-fade. */
  weight: () => number;
}) {
  const sheathMeshes = useRef<Partial<Record<MarkKind, InstancedMesh | null>>>({});
  const crackMesh = useRef<InstancedMesh>(null);
  const clock = useRef(0);
  const invalidate = useThree((s) => s.invalidate);
  // Per component, since during a cross-fade the two modes' marks have different opacities.
  const material = useMemo(
    () => ({
      crack: basic(CRACK_COLOR, DoubleSide),
      sheath: {
        crack: basic(SHEATH_COLOR.crack),
        amber: basic(SHEATH_COLOR.amber),
        red: basic(SHEATH_COLOR.red),
      },
    }),
    [],
  );
  useEffect(
    () => () => {
      material.crack.dispose();
      for (const m of Object.values(material.sheath)) m.dispose();
    },
    [material],
  );

  const write = (jitter: number) => {
    const used: Record<MarkKind, number> = { crack: 0, amber: 0, red: 0 };
    let cracks = 0;
    for (const { cardId, kind } of marks.slice(0, MAX_MARKS)) {
      const mesh = sheathMeshes.current[kind];
      if (sheath && mesh && placeSheath(cardId, placed)) mesh.setMatrixAt(used[kind]++, placed);
      if (kind === 'crack' && crackMesh.current && placeCrack(cardId, placed)) {
        if (jitter > 0) {
          placed.elements[12] += (Math.random() - 0.5) * jitter;
          placed.elements[13] += (Math.random() - 0.5) * jitter;
        }
        crackMesh.current.setMatrixAt(cracks++, placed);
      }
    }
    for (const kind of SHEATH_KINDS) {
      const mesh = sheathMeshes.current[kind];
      if (!mesh) continue;
      mesh.count = used[kind];
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (crackMesh.current) {
      crackMesh.current.count = cracks;
      crackMesh.current.instanceMatrix.needsUpdate = true;
    }
  };

  useLayoutEffect(() => {
    write(0);
    if (!animate) {
      for (const kind of SHEATH_KINDS) material.sheath[kind].opacity = STATIC_OPACITY[kind];
      material.crack.opacity = 0.9;
    }
    invalidate();
  });

  useFrame((_, delta) => {
    if (!animate) return;
    clock.current += Math.min(delta, MAX_FRAME_SECONDS);
    const t = clock.current;
    const share = weight();
    const glitch = glitching(t);
    write(glitch ? JITTER : 0);
    for (const kind of SHEATH_KINDS) {
      const boost = kind === 'crack' && glitch ? 2 : 1;
      material.sheath[kind].opacity = flicker(kind, t) * boost * share;
    }
    material.crack.opacity = (glitch && Math.random() < 0.3 ? 0.35 : 1) * share;
  });

  return (
    <>
      {sheath &&
        SHEATH_KINDS.map((kind) => (
          <instancedMesh
            key={`${kind}-${sheath.uuid}`}
            ref={(mesh) => {
              sheathMeshes.current[kind] = mesh;
            }}
            args={[sheath, material.sheath[kind], MAX_MARKS]}
            frustumCulled={false}
          />
        ))}
      <instancedMesh
        ref={crackMesh}
        args={[CRACK_GEOMETRY, material.crack, MAX_MARKS]}
        frustumCulled={false}
      />
    </>
  );
}

const CRACK_ON_RING = 0.5;
const SHEATH_TUBE = TUBE * 1.9;

const ringOffset = new Matrix4();
const crackScale = new Matrix4();

function crackOnRing(angle: number, out: Matrix4): boolean {
  out.makeRotationZ(angle);
  out.multiply(ringOffset.makeTranslation(RADII.outer, 0, 0));
  out.multiply(crackScale.makeScale(CRACK_ON_RING, CRACK_ON_RING, CRACK_ON_RING));
  return true;
}

/** Mode A: on the outer ring, where every counted card has a lit slice from stage 1 on. */
function SliceMarks({
  marks,
  segments,
  animate,
  weight,
}: {
  marks: readonly CardMark[];
  segments: readonly ProgressSegment[];
  animate: boolean;
  weight: () => number;
}) {
  const n = segments.length;
  const sheath = useMemo(() => (n > 0 ? sliceGeometry(RADII.outer, SHEATH_TUBE, n) : null), [n]);
  useEffect(() => () => sheath?.dispose(), [sheath]);
  const index = useMemo(() => new Map(segments.map((s, i) => [s.cardId, i] as const)), [segments]);
  const step = (Math.PI * 2) / Math.max(n, 1);

  return (
    <Marks
      marks={marks}
      sheath={sheath}
      placeSheath={(cardId, out) => {
        const i = index.get(cardId);
        if (i === undefined) return false;
        out.makeRotationZ(i * step);
        return true;
      }}
      placeCrack={(cardId, out) => {
        const i = index.get(cardId);
        return i !== undefined && crackOnRing(i * step + (step * SLICE_FILL) / 2, out);
      }}
      animate={animate}
      weight={weight}
    />
  );
}

const FULL_WEIGHT = () => 1;

/** Mode B: looked up by card id on each write, since a plate's instance index changes with its stage. */
export function PlateMarks({
  locator,
  marks,
  animate,
  weight,
}: {
  locator: RefObject<BlockLocator | null>;
  marks: readonly CardMark[];
  animate: boolean;
  weight: () => number;
}) {
  return (
    <Marks
      marks={marks}
      sheath={PLATE_SHEATH}
      placeSheath={(cardId, out) => locator.current?.(cardId, out) ?? false}
      placeCrack={(cardId, out) => {
        if (!locator.current?.(cardId, out)) return false;
        out.multiply(ringOffset.makeTranslation(0, 0, PLATE_THICKNESS / 2 + 0.02));
        return true;
      }}
      animate={animate}
      weight={weight}
    />
  );
}

/* ───────────────────────── one-shots on the outer ring ───────────────────────── */

const SPARK_TRAIL = 5;
const SPARK_INSTANCES = 3 * SPARK_TRAIL;
const SPARK_TRAIL_GAP = 0.09;
const SPARK_GEOMETRY = new SphereGeometry(0.09, 10, 8);
const SPARK_MATERIAL = new MeshBasicMaterial({ color: 0xe6ecff, toneMapped: false });
const CLICK_GEOMETRY = new TorusGeometry(RADII.outer, TUBE * 1.6, 8, 96);
const CLICK_MATERIAL = basic(0xecebe6);

/** Two fast flashes, like a detent. */
const clickFlash = (t: number) =>
  t < 0.3 ? 1 - t / 0.3 : t < 0.45 ? 0 : 0.7 * (1 - (t - 0.45) / 0.55);

const sparkMatrix = new Matrix4();
const sparkScale = new Matrix4();

/** Mounted inside the outer ring's pivot, so that all of this turns with the ring. Present in both modes. */
export function RingEffects({
  running,
  marks,
  segments,
  animate,
  weight,
}: {
  running: RefObject<RunningEffect[]>;
  marks: CoreMarks;
  /** Null: Mode A's slices are not on show, so neither are marks on them. */
  segments: readonly ProgressSegment[] | null;
  animate: boolean;
  weight: () => number;
}) {
  const sparks = useRef<InstancedMesh>(null);
  const click = useRef<Mesh>(null);

  useEffect(
    () => () => {
      SPARK_GEOMETRY.dispose();
      SPARK_MATERIAL.dispose();
      CLICK_GEOMETRY.dispose();
      CLICK_MATERIAL.dispose();
      CRACK_GEOMETRY.dispose();
      PLATE_SHEATH.dispose();
    },
    [],
  );

  // Runs with no motion too, so the frame after a stop clears what was showing.
  useFrame(() => {
    if (sparks.current) {
      let used = 0;
      for (const effect of running.current) {
        if (effect.kind !== 'spark' || used >= SPARK_INSTANCES) continue;
        const head = effect.angle + easeOutCubic(effect.t) * Math.PI * 2;
        const fade = 1 - effect.t;
        for (let i = 0; i < SPARK_TRAIL; i++) {
          const angle = head - i * SPARK_TRAIL_GAP * (0.3 + fade);
          const size = fade ** 0.5 * (1 - i / SPARK_TRAIL);
          sparkMatrix.makeTranslation(
            Math.cos(angle) * RADII.outer,
            Math.sin(angle) * RADII.outer,
            0,
          );
          sparkMatrix.multiply(sparkScale.makeScale(size, size, size));
          sparks.current.setMatrixAt(used++, sparkMatrix);
        }
      }
      sparks.current.count = used;
      sparks.current.instanceMatrix.needsUpdate = true;
    }
    if (click.current) {
      const effect = running.current.find((e) => e.kind === 'click');
      click.current.visible = effect !== undefined;
      if (effect) {
        CLICK_MATERIAL.opacity = clickFlash(effect.t);
        click.current.scale.setScalar(1 + 0.02 * (1 - effect.t));
      }
    }
  });

  const [rx, ry, rz] = RING_ROTATION.outer;
  return (
    <group rotation={[rx, ry, rz]}>
      {segments && (
        <SliceMarks marks={marks.cards} segments={segments} animate={animate} weight={weight} />
      )}
      <Marks
        marks={marks.loose}
        sheath={null}
        placeSheath={() => false}
        placeCrack={(cardId, out) => crackOnRing(hash(cardId, 41) * Math.PI * 2, out)}
        animate={animate}
        weight={FULL_WEIGHT}
      />
      <instancedMesh
        ref={sparks}
        args={[SPARK_GEOMETRY, SPARK_MATERIAL, SPARK_INSTANCES]}
        frustumCulled={false}
      />
      <mesh ref={click} geometry={CLICK_GEOMETRY} material={CLICK_MATERIAL} visible={false} />
    </group>
  );
}

/* ───────────────────────── one-shots at the core ───────────────────────── */

const UNIT_SPHERE = new SphereGeometry(1, 32, 24);
const PULSE_MATERIAL = basic(0x9b8cff);
const WAVE_MATERIAL = basic(0xffffff);
const WHITE_MATERIAL = basic(0xffffff);
WAVE_MATERIAL.blending = AdditiveBlending;
PULSE_MATERIAL.blending = AdditiveBlending;

const BURST_POINTS = 180;
const BURST_REACH = 3.5;
const BURST_GEOMETRY = (() => {
  const positions = new Float32Array(BURST_POINTS * 3);
  for (let i = 0; i < BURST_POINTS; i++) {
    const y = 1 - ((i + 0.5) / BURST_POINTS) * 2;
    const around = i * Math.PI * (3 - Math.sqrt(5));
    const flat = Math.sqrt(1 - y * y);
    // Not all at one radius, so that it reads as a burst and not as a growing sphere.
    const reach = 0.45 + 0.55 * ((i * 0.618) % 1);
    positions[i * 3] = flat * Math.cos(around) * reach;
    positions[i * 3 + 1] = y * reach;
    positions[i * 3 + 2] = flat * Math.sin(around) * reach;
  }
  return new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
})();
const BURST_MATERIAL = new PointsMaterial({
  color: 0xfff6d8,
  size: 0.09,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  toneMapped: false,
});

/** Share of a release's time at which the white starts to leave, and the wave has gone. */
const WHITE_HOLD = 0.65;
const WAVE_END = 0.4;

/**
 * Centred on the world origin, which is where the core is whatever the rings do. The white is a sphere over the core, so
 * when it fades the core shows whatever level the progress model gives it: the scene does not reset here.
 */
export function CentreEffects({ running }: { running: RefObject<RunningEffect[]> }) {
  const pulse = useRef<Mesh>(null);
  const wave = useRef<Mesh>(null);
  const white = useRef<Mesh>(null);
  const burst = useRef<Group>(null);

  useEffect(
    () => () => {
      UNIT_SPHERE.dispose();
      BURST_GEOMETRY.dispose();
      BURST_MATERIAL.dispose();
      for (const m of [PULSE_MATERIAL, WAVE_MATERIAL, WHITE_MATERIAL]) m.dispose();
    },
    [],
  );

  // Runs with no motion too, so the frame after a stop clears what was showing.
  useFrame(() => {
    if (!pulse.current || !wave.current || !white.current || !burst.current) return;
    const beat = running.current.find((e) => e.kind === 'pulse');
    pulse.current.visible = beat !== undefined;
    if (beat) {
      pulse.current.scale.setScalar(CORE_RADIUS * (1.05 + 1.3 * easeOutCubic(beat.t)));
      PULSE_MATERIAL.opacity = 0.6 * (1 - beat.t) ** 2;
    }

    const release = running.current.find((e) => e.kind === 'release');
    white.current.visible = release !== undefined;
    burst.current.visible = release !== undefined;
    wave.current.visible = release !== undefined && release.t < WAVE_END;
    if (!release) return;
    const t = release.t;
    WHITE_MATERIAL.opacity =
      t < 0.05 ? t / 0.05 : t < WHITE_HOLD ? 1 : 1 - (t - WHITE_HOLD) / (1 - WHITE_HOLD);
    const spread = Math.min(1, t / WAVE_END);
    wave.current.scale.setScalar(CORE_RADIUS + (BURST_REACH - CORE_RADIUS) * easeOutCubic(spread));
    WAVE_MATERIAL.opacity = 0.7 * (1 - spread) ** 2;
    burst.current.scale.setScalar(Math.max(0.001, BURST_REACH * easeOutCubic(t)));
    BURST_MATERIAL.opacity = 1 - t;
  });

  return (
    <>
      <mesh ref={pulse} geometry={UNIT_SPHERE} material={PULSE_MATERIAL} visible={false} />
      <mesh ref={wave} geometry={UNIT_SPHERE} material={WAVE_MATERIAL} visible={false} />
      <mesh
        ref={white}
        geometry={UNIT_SPHERE}
        material={WHITE_MATERIAL}
        scale={CORE_RADIUS * 1.01}
        visible={false}
      />
      <group ref={burst} visible={false}>
        <points geometry={BURST_GEOMETRY} material={BURST_MATERIAL} frustumCulled={false} />
      </group>
    </>
  );
}

/* ───────────────────────── reduced motion ───────────────────────── */

const NOTE_SECONDS = 8;
const NOTE: Record<EffectKind, { label: string; dot: string }> = {
  pulse: { label: 'New comment', dot: 'bg-river' },
  spark: { label: 'Approved', dot: 'bg-primary' },
  click: { label: 'Merged', dot: 'bg-plum' },
  release: { label: 'Release done', dot: 'bg-card ring-1 ring-border' },
};

/** Stands in for the one-shots under reduced motion: the latest one, as a still note over the canvas. HTML, not 3D. */
export function StaticEffectNote() {
  const [kind, setKind] = useState<EffectKind | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = getEventStream().subscribe((event) => {
      const next = effectFor(event);
      if (!next) return;
      setKind(next);
      clearTimeout(timer);
      timer = setTimeout(() => setKind(null), NOTE_SECONDS * 1000);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  if (!kind) return null;
  return (
    <p className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-md bg-popover/90 px-2 py-1 text-xs text-popover-foreground">
      <span className={`size-2 rounded-full ${NOTE[kind].dot}`} />
      {NOTE[kind].label}
    </p>
  );
}
