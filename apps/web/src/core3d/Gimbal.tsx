import { useEffect, useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Color,
  CylinderGeometry,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type Group,
  type Mesh,
  type PointLight,
} from 'three';
import { GimbalFinale } from './GimbalFinale';
import { pieceBuilt, progressFx, type ProgressFx } from './progressFx';
import { CORE_RADIUS, RADII, RING_ROTATION, TUBE } from './rig';

/**
 * The armillary, as nested groups: each pivot is a child of the previous one, so tilt is inherited.
 *
 * A pivot's rotation axis must be the pin axis joining it to its parent, so that axis has to be a diameter of BOTH rings
 * it joins. A torus starts in the XY plane, and the rest pose used here has the three rings mutually perpendicular:
 *
 *   ring    plane   spins on   joined to its parent by
 *   outer   XY      X          stationary stubs on X (root)
 *   middle  YZ      Y          pins on Y (Y is in both XY and YZ)
 *   inner   XZ      Z          pins on Z (Z is in both YZ and XZ)
 *
 * This keeps the plan's axes and pin axes but not its ring orientations. Its snippet turns the OUTER ring into YZ, whose
 * normal is X, so it would only spin within its own plane and look still; and it leaves the MIDDLE ring in XY, whose
 * normal is Z, so the Z pins would float clear of it. The plan's pins are also shorter than the gap between rings, so
 * here they run from one ring's centre line to the other's.
 */

const PIN_RADIUS = TUBE * 1.6;
const MOUNT_LENGTH = 0.35;

/** Rad/s, deliberately unrelated, and each wobbles so the motion never settles into a visible loop. */
const SPEED = { outer: 0.31, middle: 0.47, inner: 0.83 } as const;
/** A long frame (a stall, or the first one after a pause) must not jump the rings. */
const MAX_FRAME_SECONDS = 0.1;

/** A readable pose with no motion at all, which is what reduced motion shows. */
const VIEW_TILT: [number, number, number] = [0.3, -0.45, 0];
const OUTER_START: [number, number, number] = [0.35, 0, 0];
const MIDDLE_START: [number, number, number] = [0, 0.6, 0];
const INNER_START: [number, number, number] = [0, 0, 0.9];

/** A cylinder's axis starts on Y. */
const ALONG_X: [number, number, number] = [0, 0, Math.PI / 2];
const ALONG_Z: [number, number, number] = [Math.PI / 2, 0, 0];

const pinGeometry = (length: number) => new CylinderGeometry(PIN_RADIUS, PIN_RADIUS, length, 16);

const GEOMETRY = {
  outerRing: new TorusGeometry(RADII.outer, TUBE, 24, 128),
  middleRing: new TorusGeometry(RADII.middle, TUBE, 24, 128),
  innerRing: new TorusGeometry(RADII.inner, TUBE, 24, 128),
  mountPin: pinGeometry(MOUNT_LENGTH),
  outerMiddlePin: pinGeometry(RADII.outer - RADII.middle),
  middleInnerPin: pinGeometry(RADII.middle - RADII.inner),
  core: new SphereGeometry(CORE_RADIUS, 48, 48),
};

const MATERIAL = {
  // Polished, lacquered metal: the clearcoat catches the key light as a second, sharper highlight.
  ring: new MeshPhysicalMaterial({
    color: 0xd8cbb8,
    metalness: 0.95,
    roughness: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  }),
  pin: new MeshPhysicalMaterial({
    color: 0xf7b500,
    metalness: 1,
    roughness: 0.18,
    clearcoat: 0.8,
  }),
  core: new MeshStandardMaterial({
    color: 0x2b211d,
    emissive: 0xf7b500,
    emissiveIntensity: 1.2,
  }),
};

const CORE_COLOR = new Color(0xf7b500);
const SUPERNOVA = new Color(0xfff4dc);

/**
 * Broken offsets per ring (fraction of "how wrong" at 0% assembly): a displaced, mis-tilted ring that settles home.
 * The pins are pieces too: missing until their turn in the build order.
 */
const BREAK = {
  outer: { pos: [0.55, -0.35, 0.5], rot: [0.35, 0.2, -0.25] },
  middle: { pos: [-0.4, 0.3, -0.35], rot: [-0.3, 0.25, 0.2] },
  inner: { pos: [0.25, 0.25, 0.3], rot: [0.2, -0.3, 0.3] },
} as const;
/** Build order: inner ring, its pins, middle ring, its pins, outer ring, the mounts. */
const ORDER = {
  inner: 0,
  middleInnerPins: 1,
  middle: 2,
  outerMiddlePins: 3,
  outer: 4,
  mounts: 5,
} as const;
const PIECES = 6;

/** How fast the core's glow follows a change, per second. */
const CORE_FOLLOW = 3;
const DEFAULT_CORE_LEVEL = MATERIAL.core.emissiveIntensity;

const SIDES = [-1, 1] as const;
const MOUNT_AT = RADII.outer + MOUNT_LENGTH / 2;
const OUTER_MIDDLE_AT = (RADII.outer + RADII.middle) / 2;
const MIDDLE_INNER_AT = (RADII.middle + RADII.inner) / 2;

/** What a mode mounts inside a ring's pivot, so that it moves with that ring. */
export interface GimbalSlots {
  outer?: ReactNode;
  middle?: ReactNode;
  inner?: ReactNode;
}

export function Gimbal({
  animate,
  coreLevel = DEFAULT_CORE_LEVEL,
  slots,
  fx = progressFx(100),
}: {
  animate: boolean;
  /** The core's emissive intensity. */
  coreLevel?: number;
  slots?: GimbalSlots | undefined;
  /** Progress-driven look: broken → assembled (90%), spin, finale (98-100%). */
  fx?: ProgressFx;
}) {
  const outer = useRef<Group>(null);
  const middle = useRef<Group>(null);
  const inner = useRef<Group>(null);
  const ringMesh = {
    outer: useRef<Mesh>(null),
    middle: useRef<Mesh>(null),
    inner: useRef<Mesh>(null),
  };
  const pins = {
    mounts: useRef<Group>(null),
    outerMiddlePins: useRef<Group>(null),
    middleInnerPins: useRef<Group>(null),
  };
  const coreLight = useRef<PointLight>(null);
  const level = useRef(coreLevel);
  const shown = useRef<number[]>(Array.from({ length: PIECES }, () => 0));
  // Our own clock: R3F restarts its own whenever the frameloop changes, which would jump the wobble's phase.
  const time = useRef(0);
  const invalidate = useThree((s) => s.invalidate);

  // Dispose only frees GPU memory: three uploads these objects again if the view is opened again.
  useEffect(
    () => () => {
      for (const geometry of Object.values(GEOMETRY)) geometry.dispose();
      for (const material of Object.values(MATERIAL)) material.dispose();
    },
    [],
  );

  /** Places the broken / assembled pieces for build fractions `b` (by ORDER). */
  const place = (b: readonly number[], t: number) => {
    (['outer', 'middle', 'inner'] as const).forEach((k) => {
      const m = ringMesh[k].current;
      if (!m) return;
      const off = 1 - b[ORDER[k]]!;
      const jitter = off > 0.02 ? Math.sin(t * 9 + ORDER[k] * 3) * 0.02 * off : 0;
      const br = BREAK[k];
      m.position.set(br.pos[0] * off + jitter, br.pos[1] * off, br.pos[2] * off);
      const base = RING_ROTATION[k];
      m.rotation.set(
        base[0] + br.rot[0] * off,
        base[1] + br.rot[1] * off,
        base[2] + br.rot[2] * off + jitter,
      );
    });
    (['mounts', 'outerMiddlePins', 'middleInnerPins'] as const).forEach((k) => {
      const g = pins[k].current;
      if (g) g.scale.setScalar(Math.max(0.0001, b[ORDER[k]]!));
    });
  };

  const applyCore = (level: number) => {
    MATERIAL.core.emissive.copy(CORE_COLOR).lerp(SUPERNOVA, fx.finale);
    MATERIAL.core.emissiveIntensity = level * (1 + fx.finale * 2.5);
    if (coreLight.current) {
      coreLight.current.intensity = 2 + level * 6 + fx.finale * 30;
      coreLight.current.color.copy(CORE_COLOR).lerp(SUPERNOVA, fx.finale);
    }
  };

  // Static pose: the build state progress puts it in, no motion.
  useEffect(() => {
    if (animate) return;
    const b = Array.from({ length: PIECES }, (_, i) => pieceBuilt(i, PIECES, fx.assembly));
    shown.current = b;
    level.current = coreLevel;
    place(b, 0);
    applyCore(coreLevel);
    invalidate();
  }, [animate, fx, coreLevel, invalidate]);

  useFrame((_, delta) => {
    if (!animate || !outer.current || !middle.current || !inner.current) return;
    const dt = Math.min(delta, MAX_FRAME_SECONDS);
    time.current += dt;
    const t = time.current;
    level.current += (coreLevel - level.current) * Math.min(1, dt * CORE_FOLLOW);
    applyCore(level.current);
    // Spin follows progress: a crawl when broken, a confident whirl when done.
    const k = fx.spin * (1 + fx.finale * 0.8);
    outer.current.rotation.x += SPEED.outer * k * dt * (1 + 0.15 * Math.sin(t * 0.4));
    middle.current.rotation.y += SPEED.middle * k * dt * (1 + 0.12 * Math.sin(t * 0.7 + 1));
    inner.current.rotation.z += SPEED.inner * k * dt * (1 + 0.1 * Math.sin(t * 1.1 + 2));
    const b = shown.current.map(
      (cur, i) => cur + (pieceBuilt(i, PIECES, fx.assembly) - cur) * Math.min(1, dt * 1.1),
    );
    shown.current = b;
    place(b, t);
  });

  return (
    <group rotation={VIEW_TILT}>
      <GimbalFinale fx={fx} animate={animate} coreLevel={coreLevel} />
      <group ref={pins.mounts}>
        {SIDES.map((side) => (
          <mesh
            key={side}
            geometry={GEOMETRY.mountPin}
            material={MATERIAL.pin}
            position={[side * MOUNT_AT, 0, 0]}
            rotation={ALONG_X}
          />
        ))}
      </group>
      <group ref={outer} rotation={OUTER_START}>
        <mesh
          ref={ringMesh.outer}
          geometry={GEOMETRY.outerRing}
          material={MATERIAL.ring}
          rotation={RING_ROTATION.outer}
        />
        {slots?.outer}
        <group ref={pins.outerMiddlePins}>
          {SIDES.map((side) => (
            <mesh
              key={side}
              geometry={GEOMETRY.outerMiddlePin}
              material={MATERIAL.pin}
              position={[0, side * OUTER_MIDDLE_AT, 0]}
            />
          ))}
        </group>
        <group ref={middle} rotation={MIDDLE_START}>
          <mesh
            ref={ringMesh.middle}
            geometry={GEOMETRY.middleRing}
            material={MATERIAL.ring}
            rotation={RING_ROTATION.middle}
          />
          {slots?.middle}
          <group ref={pins.middleInnerPins}>
            {SIDES.map((side) => (
              <mesh
                key={side}
                geometry={GEOMETRY.middleInnerPin}
                material={MATERIAL.pin}
                position={[0, 0, side * MIDDLE_INNER_AT]}
                rotation={ALONG_Z}
              />
            ))}
          </group>
          <group ref={inner} rotation={INNER_START}>
            <mesh
              ref={ringMesh.inner}
              geometry={GEOMETRY.innerRing}
              material={MATERIAL.ring}
              rotation={RING_ROTATION.inner}
            />
            {slots?.inner}
            <mesh geometry={GEOMETRY.core} material={MATERIAL.core} />
            {/* the core lights the rings from inside */}
            <pointLight ref={coreLight} distance={9} decay={1.6} intensity={6} color={0xf7b500} />
          </group>
        </group>
      </group>
    </group>
  );
}
