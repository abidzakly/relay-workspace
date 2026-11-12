import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { ACESFilmicToneMapping } from 'three';
import { useKpiCards } from '@/lib/kpiApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { useUiStore } from '@/store/ui';
import { NIGHT, PAPER, StudioEnvironment, useDarkTheme } from '@/workspace/crystal/studio';
import { useQualityTier } from '@/workspace/environment/quality';
import { useNarrow } from '@/workspace/useMedia';
import { PageBackground } from '@/workspace/crystal/PageBackground';
import { AsciiScene } from './AsciiScene';
import { CoreScene } from './CoreScene';
import { PostFx } from './PostFx';
import { progressFx, progressOverride } from './progressFx';
import { StaticEffectNote } from './Effects';
import { buildMarks, slaRisks } from './effectModel';
import type { ProgressCardRef, ProgressModel } from './progressMapping';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const CAMERA = { position: [0, 0, 9], fov: 45 } as const;
/** One crystal on screen: it can afford retina-ish density (1.75), which is what keeps its edges and glints sharp. */
const DPR: [number, number] = [1, 1.75];
/** 60: the highlights glide across the folds, and at 30 that glide stutters. */
const IDLE_FPS = 60;
/** Full-scene ASCII reads pixels back and rewrites thousands of DOM nodes per frame, so it never runs faster than this. */
const ASCII_MAX_FPS = 30;

function subscribeHidden(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function subscribeReducedMotion(onChange: () => void) {
  const query = matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Paper or night behind the core, a studio for the glass to reflect, and a key light for the emblem. */
function Lighting({ dark }: { dark: boolean }) {
  return (
    <>
      <PageBackground color={dark ? NIGHT : PAPER} />
      <StudioEnvironment dark={dark} />
      <ambientLight intensity={dark ? 0.25 : 0.5} />
      <directionalLight position={[4, 8, 6]} intensity={dark ? 0.9 : 1.6} />
      <directionalLight
        position={[-6, 2, -4]}
        intensity={0.6}
        color={dark ? '#9b8cff' : '#dfe8ff'}
      />
    </>
  );
}

/** With an FPS cap the loop is on demand, and this asks for a frame only as often as the cap allows. */
function FrameLimiter({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    const interval = 1000 / fps;
    let last = 0;
    let handle = requestAnimationFrame(function tick(now) {
      handle = requestAnimationFrame(tick);
      // The tolerance stops a 30 cap on a 60 Hz screen from dropping to 20 on timer jitter.
      if (now - last < interval - 1) return;
      last = now;
      invalidate();
    });
    return () => cancelAnimationFrame(handle);
  }, [fps, invalidate]);

  return null;
}

/**
 * The R3F canvas. `demand` still draws the first frame and after a resize, so a paused core stays visible:
 * it just stops consuming a frame per display refresh while the tab is hidden or the user asked for reduced motion.
 *
 * This module is the only way into three.js, so import it lazily (see `CoreStage`).
 */
export function CoreCanvas({
  model,
  onDustPick,
  onDustHover,
}: {
  model: ProgressModel | null;
  onDustPick: (card: ProgressCardRef) => void;
  onDustHover: (card: ProgressCardRef | null) => void;
}) {
  const hidden = useSyncExternalStore(subscribeHidden, () => document.hidden);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => matchMedia(REDUCED_MOTION).matches,
  );
  const fpsCap = useUiStore((s) => s.fpsCap);
  const mode = useUiStore((s) => s.mode3d);
  const ascii = useUiStore((s) => s.ascii);
  const asciiTone = useUiStore((s) => s.asciiTone);
  const running = !hidden && !reducedMotion;
  const narrow = useNarrow();
  // Read here, outside the canvas, which is a separate React root.
  const cards = useStateSnapshot().data?.cards;
  const kpiRows = useKpiCards().data?.rows;
  const marks = useMemo(
    () => buildMarks(model, cards ?? [], slaRisks(kpiRows ?? [])),
    [model, cards, kpiRows],
  );
  const cap = ascii === 'full' ? Math.min(fpsCap || ASCII_MAX_FPS, ASCII_MAX_FPS) : fpsCap;
  const percent = progressOverride() ?? model?.percent ?? null;
  const fx = useMemo(() => progressFx(percent), [percent]);
  const dark = useDarkTheme();
  const quality = useQualityTier();

  return (
    <>
      <Canvas
        frameloop="demand"
        camera={CAMERA}
        dpr={DPR}
        gl={{
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.15,
        }}
        onCreated={({ gl }) => {
          // The page and emblem seen through the glass stay sharp near full size.
          gl.transmissionResolutionScale = 0.9;
        }}
      >
        <Lighting dark={dark} />
        <CoreScene
          dark={dark}
          quality={quality}
          fx={fx}
          model={model}
          marks={marks}
          mode={mode}
          textRing={ascii === 'text'}
          animate={running}
          onDustPick={onDustPick}
          onDustHover={onDustHover}
        />
        {/* Post-processing only for the 98-100% finale; the rest of the time it is a full-screen pass for nothing. */}
        {ascii === 'full' ? (
          <AsciiScene tone={asciiTone} />
        ) : (
          !narrow && fx.finale > 0 && <PostFx finale={fx.finale} dark={dark} />
        )}
        {running && <FrameLimiter fps={cap > 0 ? Math.min(cap, IDLE_FPS) : IDLE_FPS} />}
      </Canvas>
      {reducedMotion && <StaticEffectNote />}
    </>
  );
}
