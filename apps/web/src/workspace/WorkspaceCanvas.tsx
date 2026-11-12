import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ACESFilmicToneMapping, MathUtils, Vector3, type PerspectiveCamera } from 'three';
import { subscribePresented } from '@/lib/reward/engine';
import { useUiStore } from '@/store/ui';
import { useHidden } from './useMedia';
import { isStowed, type EnvId } from './envFor';
import { FpsWatch } from './environment/FpsWatch';
import { capTier, nextCap, useQualityTier, type QualityTier } from './environment/quality';
import { CrystalWorld } from './crystal/CrystalWorld';
import { CRYSTAL_LAYOUT } from './crystal/layout';
import { NIGHT, PAPER, StudioEnvironment, useDarkTheme } from './crystal/studio';
import { PageBackground } from './crystal/PageBackground';
import {
  clampOrbit,
  ORBIT_HOME,
  RESET_VIEW_EVENT,
  orbitPose,
  type EnvLayout,
  type Orbit,
  type Pose,
} from './layout';
import type { ObjectId, PickId } from './registry';
import type { PickHandlers } from './scene/Interactive';
import {
  arrivalPose,
  planFlight,
  sampleFlight,
  type CameraState,
  type FlightPlan,
} from './world/cameraMachine';
import { CELEBRATION_S } from './world/useCelebration';
import type { SceneData } from './signals';

export interface WorkspaceCanvasProps {
  data: SceneData;
  env: EnvId;
  hour: number;
  focus: ObjectId | null;
  /** The page is already open: move the camera without a flight (nobody sees it). */
  instant: boolean;
  highlighted: PickId | null;
  /** The object of the next job: it glows like a hovered one, but gets no tooltip. */
  nudge: PickId | null;
  /** The way into Overview asked for (route state): through the observatory, or not. */
  via: 'observatory' | null;
  /** A page covers the world: stop drawing frames. */
  paused: boolean;
  reducedMotion: boolean;
  narrow: boolean;
  /** The first look at the world: the camera settles and the avatar looks up, once. */
  arrive: boolean;
  onHover: (id: PickId | null) => void;
  onProject: (at: { x: number; y: number } | null) => void;
  onPick: (id: PickId, touch: boolean) => void;
  onArrive: (id: ObjectId | null, at: { x: number; y: number } | null) => void;
  /** This environment's world has finished loading. */
  onWorldReady: (env: EnvId) => void;
}

const tmp = new Vector3();

/**
 * Sharpness comes from pixel density (capped at 1.5-2): at 1.25 every edge and glint on a
 * retina screen is upscaled mush. `FpsWatch` steps the tier down if a device cannot keep up, which lowers this too.
 */
const DPR: Record<QualityTier, number | [number, number]> = {
  high: [1, 2],
  medium: [1, 1.5],
  low: [1, 1.25],
};
/** Smooth motion: the foil shader is one pass per crystal, so a full 60 is affordable. `FpsWatch` still steps down. */
const IDLE_FPS = 60;
/**
 * The glass pass draws the scene behind the crystals again. At full size the emblem and the page stay sharp through
 * the clear glass; medium keeps 80%, which is still clean at its lower pixel ratio.
 */
const TRANSMISSION_SCALE: Record<QualityTier, number> = { high: 1, medium: 0.8, low: 0.6 };

/** Keeps the glass pass size in step with the tier, which `FpsWatch` can lower mid-session. */
function TransmissionScale({ scale }: { scale: number }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    gl.transmissionResolutionScale = scale;
    invalidate();
  }, [gl, scale, invalidate]);
  return null;
}

/** Dev only: `?cam=x,y,z,lx,ly,lz` replaces the wide shot, to inspect the scene from any angle. */
function devCamera(): Pose | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get('cam')?.split(',').map(Number);
  if (!v || v.length !== 6 || v.some(Number.isNaN)) return null;
  return { pos: [v[0]!, v[1]!, v[2]!], look: [v[3]!, v[4]!, v[5]!], fov: 40 };
}

function project(
  camera: PerspectiveCamera,
  size: { width: number; height: number },
  p: readonly number[],
) {
  tmp.set(p[0]!, p[1]!, p[2]!).project(camera);
  return { x: ((tmp.x + 1) / 2) * size.width, y: ((1 - tmp.y) / 2) * size.height };
}

interface OrbitState {
  goal: Orbit;
  now: Orbit;
  /** 1 in the wide shot, 0 at an object. */
  weight: number;
  dragging: boolean;
}

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm';

/**
 * Look around the world: drag (mouse or one finger) turns and tilts, the wheel or a pinch zooms, arrow keys and +/-
 * do the same from the keyboard, double-click or 0 resets. Limited, so the world never gets lost. Only in the wide shot:
 * at an object the page has the input.
 */
function useOrbitInput(wide: Pose, enabled: boolean, layout: EnvLayout) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const state = useRef<OrbitState>({
    goal: { ...ORBIT_HOME },
    now: { ...ORBIT_HOME },
    weight: 1,
    dragging: false,
  });
  const on = useRef(enabled);
  on.current = enabled;

  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let moved = 0;
    const set = (o: Orbit) => {
      s.goal = clampOrbit(wide, o, layout.orbit);
      invalidate();
    };
    const reset = () => set({ ...ORBIT_HOME });

    const down = (e: PointerEvent) => {
      if (!on.current) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    };
    const move = (e: PointerEvent) => {
      const last = pointers.get(e.pointerId);
      if (!last || !on.current) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinch > 0) set({ ...s.goal, zoom: s.goal.zoom * (pinch / d) });
        pinch = d;
        return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved < 4) return;
      s.dragging = true;
      el.style.cursor = 'grabbing';
      set({ ...s.goal, yaw: s.goal.yaw - dx * 0.006, pitch: s.goal.pitch + dy * 0.004 });
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (pointers.size === 0 && s.dragging) {
        s.dragging = false;
        el.style.cursor = '';
      }
    };
    const wheel = (e: WheelEvent) => {
      if (!on.current) return;
      e.preventDefault();
      set({ ...s.goal, zoom: s.goal.zoom * Math.exp(e.deltaY * 0.0012) });
    };
    const dbl = () => on.current && reset();
    const key = (e: KeyboardEvent) => {
      if (!on.current || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof Element && t.closest(TYPING)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const g = s.goal;
      const step: Record<string, Orbit> = {
        ArrowLeft: { ...g, yaw: g.yaw + 0.15 },
        ArrowRight: { ...g, yaw: g.yaw - 0.15 },
        ArrowUp: { ...g, pitch: g.pitch + 0.1 },
        ArrowDown: { ...g, pitch: g.pitch - 0.1 },
        '+': { ...g, zoom: g.zoom / 1.12 },
        '=': { ...g, zoom: g.zoom / 1.12 },
        '-': { ...g, zoom: g.zoom * 1.12 },
        '0': { ...ORBIT_HOME },
      };
      const next = step[e.key];
      if (!next) return;
      e.preventDefault();
      set(next);
    };

    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dbl);
    document.addEventListener('keydown', key);
    window.addEventListener(RESET_VIEW_EVENT, reset);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dbl);
      document.removeEventListener('keydown', key);
      window.removeEventListener(RESET_VIEW_EVENT, reset);
    };
  }, [gl, invalidate, wide, layout]);

  return state;
}

/**
 * The camera follows the URL. A new target plans a flight (`world/cameraMachine.ts`) from wherever the camera is now,
 * so going back halfway through a flight just turns around. In the wide shot it sways a little with the pointer, and
 * the visitor may look around within the environment's limits.
 */
function CameraRig({
  layout,
  via,
  focus,
  instant,
  reducedMotion,
  narrow,
  arrive,
  onArrive,
  onState,
}: Pick<
  WorkspaceCanvasProps,
  'focus' | 'instant' | 'reducedMotion' | 'narrow' | 'arrive' | 'onArrive'
> & {
  layout: EnvLayout;
  via: 'observatory' | null;
  onState?: (state: CameraState) => void;
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const pointer = useThree((s) => s.pointer);
  const invalidate = useThree((s) => s.invalidate);
  const wide = useMemo(
    () => devCamera() ?? (narrow ? layout.worldNarrow : layout.world),
    [narrow, layout],
  );
  const flight = useRef<{ from: Pose; plan: FlightPlan; start: number } | null>(null);
  const current = useRef<Pose>(focus ? layout.focus[focus] : wide);
  const state = useRef<CameraState>(focus ? 'object-focus' : 'world');
  const sway = useRef({ x: 0, y: 0 });
  const first = useRef(true);
  const look = useRef(new Vector3());
  const orbit = useOrbitInput(wide, focus === null, layout);

  // The clip planes follow the environment's size.
  useEffect(() => {
    camera.near = layout.clip[0];
    camera.far = layout.clip[1];
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, layout, invalidate]);

  useEffect(() => {
    const plan = planFlight(layout, wide, focus, first.current || instant || reducedMotion, {
      from: state.current,
      via,
    });
    first.current = false;
    flight.current = { from: current.current, plan, start: performance.now() };
    invalidate();
  }, [focus, narrow, layout]);

  // After the flight above, so a world swapped in on the same commit still gets the settle.
  const settled = useRef(false);
  useEffect(() => {
    if (!arrive || settled.current || focus !== null) return;
    settled.current = true;
    const from = arrivalPose(wide);
    current.current = from;
    flight.current = {
      from,
      plan: planFlight(layout, wide, null, false, { from: 'world' }),
      start: performance.now(),
    };
    invalidate();
  }, [arrive]);

  const setState = (next: CameraState) => {
    if (state.current === next) return;
    state.current = next;
    onState?.(next);
  };

  useFrame((_, dt) => {
    const f = flight.current;
    if (f) {
      const s = sampleFlight(f.from, f.plan, performance.now() - f.start);
      current.current = s.pose;
      setState(s.state);
      if (s.done) {
        flight.current = null;
        // Applied first, so the projection uses the arrived pose.
        applyPose();
        const id = f.plan.id;
        onArrive(id, id ? project(camera, size, layout.anchors[id]) : null);
      } else {
        invalidate();
      }
    }
    // The visitor's orbit eases in only in the wide shot; a flight to an object eases it out.
    const o = orbit.current;
    const k = reducedMotion ? 1 : 1 - Math.exp(-9 * dt);
    o.now.yaw += (o.goal.yaw - o.now.yaw) * k;
    o.now.pitch += (o.goal.pitch - o.now.pitch) * k;
    o.now.zoom += (o.goal.zoom - o.now.zoom) * k;
    o.weight = reducedMotion
      ? focus === null
        ? 1
        : 0
      : MathUtils.damp(o.weight, focus === null ? 1 : 0, 5, dt);
    const settling =
      Math.abs(o.goal.yaw - o.now.yaw) +
        Math.abs(o.goal.pitch - o.now.pitch) +
        Math.abs(o.goal.zoom - o.now.zoom) >
        1e-4 ||
      (o.weight > 1e-3 && o.weight < 0.999);
    if (settling) invalidate();
    // Pointer sway only in the wide shot, not while dragging, and not under reduced motion.
    const swayOn = !focus && !reducedMotion && !o.dragging;
    sway.current.x = MathUtils.damp(sway.current.x, swayOn ? pointer.x : 0, 2.5, dt);
    sway.current.y = MathUtils.damp(sway.current.y, swayOn ? pointer.y : 0, 2.5, dt);
    applyPose();
  });

  function applyPose() {
    const o = orbit.current;
    const w = o.weight;
    const p = orbitPose(
      current.current,
      {
        yaw: o.now.yaw * w,
        pitch: o.now.pitch * w,
        zoom: 1 + (o.now.zoom - 1) * w,
      },
      layout.orbit,
    );
    const sx = sway.current.x * 0.35;
    const sy = sway.current.y * 0.18;
    camera.position.set(p.pos[0] + sx, p.pos[1] + sy, p.pos[2] - sx * 0.4);
    look.current.set(p.look[0], p.look[1], p.look[2]);
    camera.lookAt(look.current);
    if (camera.fov !== p.fov) {
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
  }

  return null;
}

/** Keeps the tooltip pinned over the highlighted object, reporting only real moves. */
function Projector({
  id,
  layout,
  onProject,
}: {
  id: PickId | null;
  layout: EnvLayout;
  onProject: WorkspaceCanvasProps['onProject'];
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!id) {
      last.current = null;
      onProject(null);
    }
  }, [id, onProject]);
  useFrame(() => {
    if (!id) return;
    const gateway =
      id === 'observatory' ? layout.observatory : id === 'bench' ? layout.bench : null;
    const a = gateway ? gateway.anchor : layout.anchors[id as ObjectId];
    const lift = gateway ? gateway.tip : layout.tipLift[id as ObjectId];
    const at = project(camera, size, [a[0], a[1] + lift, a[2]]);
    const l = last.current;
    if (!l || Math.abs(l.x - at.x) > 1 || Math.abs(l.y - at.y) > 1) {
      last.current = at;
      onProject(at);
    }
  });
  return null;
}

/** With an FPS cap the loop is on demand, and this asks for a frame only as often as the cap allows. */
function FrameLimiter({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const interval = 1000 / fps;
    let last = 0;
    let handle = requestAnimationFrame(function tick(now) {
      handle = requestAnimationFrame(tick);
      if (now - last < interval - 1) return;
      last = now;
      invalidate();
    });
    return () => cancelAnimationFrame(handle);
  }, [fps, invalidate]);
  return null;
}

/** The world reacts to a big win: the rings spin up for as long as a celebration lasts. */
function useBigWin(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribePresented((reward) => {
      if (reward.level !== 'event') return;
      setOn(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOn(false), CELEBRATION_S * 1000);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);
  return on;
}

/** Sits inside the world's Suspense, so its effect runs only once that world has really loaded. */
function WorldReady({ env, onReady }: { env: EnvId; onReady: (env: EnvId) => void }) {
  useEffect(() => onReady(env), [env, onReady]);
  return null;
}

function ResetCursor({ interactive }: { interactive: boolean }) {
  useEffect(() => {
    if (!interactive) document.body.style.cursor = '';
    return () => void (document.body.style.cursor = '');
  }, [interactive]);
  return null;
}

/**
 * The Living Workspace's R3F canvas. The only way into three.js for the workspace, so import it lazily
 * (see `WorkspaceShell`). Draws on demand while a page covers it, while the tab is hidden, and under reduced motion.
 */
export function WorkspaceCanvas(props: WorkspaceCanvasProps) {
  const { data, env, focus, paused, reducedMotion, narrow, highlighted } = props;
  const fpsCap = useUiStore((s) => s.fpsCap);
  const stowed = isStowed(env);
  const dark = useDarkTheme();
  const animate = !paused && !reducedMotion;
  const hidden = useHidden();
  const live = animate && !hidden;
  const celebrating = useBigWin();

  const handlers: PickHandlers = {
    interactive: focus === null,
    // No glow on the way to (or inside) a page.
    highlighted: focus === null ? (highlighted ?? props.nudge) : null,
    reducedMotion,
    onHover: props.onHover,
    onPick: props.onPick,
  };
  const [, setCamState] = useState<CameraState>(focus ? 'object-focus' : 'world');
  // One crystal world for every environment: the environment still decides off-duty rest and the labels.
  const layout = CRYSTAL_LAYOUT;
  const deviceTier = useQualityTier();
  // Only ever goes down, and only for this session, so the world can't flip back and forth between tiers.
  const [tierCap, setTierCap] = useState<QualityTier>('high');
  const quality = capTier(deviceTier, tierCap);

  return (
    <div className="absolute inset-0">
      <Canvas
        dpr={DPR[quality]}
        // On demand always: the idle ticker paces the gentle motion, interactions and flights ask for their own frames.
        frameloop="demand"
        camera={{
          position: [...layout.world.pos],
          fov: layout.world.fov,
          near: layout.clip[0],
          far: layout.clip[1],
        }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.15,
        }}
        // Drags turn the camera; the browser must not scroll or zoom the page instead.
        style={{ touchAction: 'none' }}
        onPointerMissed={() => props.onHover(null)}
      >
        <TransmissionScale scale={TRANSMISSION_SCALE[quality]} />
        <ResetCursor interactive={handlers.interactive} />
        <PageBackground color={dark ? NIGHT : PAPER} />
        <StudioEnvironment dark={dark} />
        <CameraRig
          layout={layout}
          via={props.via}
          onState={setCamState}
          focus={focus}
          instant={props.instant}
          reducedMotion={reducedMotion}
          narrow={narrow}
          arrive={props.arrive}
          onArrive={props.onArrive}
        />
        <Projector
          id={focus === null ? highlighted : null}
          layout={layout}
          onProject={props.onProject}
        />
        {/* The generated crystals load once; until then the page colour fills the canvas. */}
        <Suspense fallback={null}>
          <CrystalWorld
            data={data}
            handlers={handlers}
            quality={quality}
            dark={dark}
            animate={animate}
            stowed={stowed}
            focus={focus}
            celebrating={celebrating}
          />
          <WorldReady env={env} onReady={props.onWorldReady} />
        </Suspense>

        {live && <FrameLimiter fps={fpsCap > 0 ? Math.min(fpsCap, IDLE_FPS) : IDLE_FPS} />}
        <FpsWatch
          active={live && fpsCap === 0 && quality !== 'low'}
          onSlow={() => setTierCap(nextCap(quality))}
        />
      </Canvas>
    </div>
  );
}
