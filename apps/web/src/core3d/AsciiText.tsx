import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  CanvasTexture,
  CylinderGeometry,
  FrontSide,
  MeshBasicMaterial,
  RepeatWrapping,
} from 'three';
import { CELL_WIDTH, composeBanner, drawBanner, fitToRing, readyTitles, ROWS } from './textBanner';
import type { ProgressSegment } from './progressMapping';
import { RADII } from './rig';

/**
 * Outside Mode B's stage 3 orbit (1.275, plus a plate's half width) and inside the inner ring's metal (1.74). Nothing else
 * is at this radius: the shell is at 0.75, and the first pins start at the inner ring.
 */
const RING_RADIUS = RADII.inner - 0.25;
const BAND_HEIGHT = 0.42;
const TILT: [number, number, number] = [0.22, 0, -0.06];

/** A cell is half as wide as it is tall, so letters keep their shape. */
const CELL_WORLD_WIDTH = BAND_HEIGHT / ROWS / 2;
const RING_COLS = Math.round((Math.PI * 2 * RING_RADIUS) / CELL_WORLD_WIDTH);

/** Largest texture asked for, and also what the "+N more" note depends on. */
const MAX_TEXTURE_WIDTH = 8192;
const SCROLL_COLS_PER_SECOND = 45;
const MAX_FRAME_SECONDS = 0.1;

const TEXT_COLOR = 0x8a86e8;

/** Starting at the back puts the only possible seam of the texture behind the core; `u` then grows to the right in front. */
const GEOMETRY = new CylinderGeometry(RING_RADIUS, RING_RADIUS, BAND_HEIGHT, 128, 1, true, Math.PI);

const textMaterial = (map: CanvasTexture) =>
  new MeshBasicMaterial({
    map,
    side: FrontSide,
    color: TEXT_COLOR,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });

function buildRing(titles: readonly string[], maxTextureSize: number) {
  const maxCols = Math.floor(Math.min(maxTextureSize, MAX_TEXTURE_WIDTH) / CELL_WIDTH);
  const banner = composeBanner(titles, maxCols);
  if (!banner) return null;
  const { cols, repeat } = fitToRing(banner.cols, RING_COLS);
  const canvas = drawBanner(banner, cols);
  if (!canvas) return null;
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.repeat.x = repeat;
  return {
    cols,
    // Puts the banner's first column at the left edge of the front half, which is all that reduced motion ever shows.
    startOffset: (((-0.25 * repeat) % 1) + 1) % 1,
    texture,
    material: textMaterial(texture),
  };
}

/**
 * The Ready to Test titles as a scrolling block-letter ring round the core. It is fixed in the scene rather
 * than mounted on a turning ring, so the text stays readable. Only the near half is drawn: the far half is seen from inside,
 * which would mirror the letters. No handlers, so it never takes a click from the dust.
 */
export function AsciiText({
  segments,
  animate,
}: {
  segments: readonly ProgressSegment[];
  animate: boolean;
}) {
  const maxTextureSize = useThree((s) => s.gl.capabilities.maxTextureSize);
  const invalidate = useThree((s) => s.invalidate);
  // A new snapshot with the same titles must not rebuild the texture or restart the scroll.
  const titles = readyTitles(segments);
  const key = titles.length > 0 ? titles.join('\n') : null;
  const ring = useMemo(
    () => (key === null ? null : buildRing(key.split('\n'), maxTextureSize)),
    [key, maxTextureSize],
  );
  const offset = useRef(0);

  useEffect(() => () => GEOMETRY.dispose(), []);

  useEffect(() => {
    if (!ring) return;
    return () => {
      ring.texture.dispose();
      ring.material.dispose();
    };
  }, [ring]);

  useLayoutEffect(() => {
    if (!ring) return;
    offset.current = ring.startOffset;
    ring.texture.offset.x = ring.startOffset;
    invalidate();
  }, [ring, invalidate]);

  useFrame((_, delta) => {
    if (!animate || !ring) return;
    const step = (Math.min(delta, MAX_FRAME_SECONDS) * SCROLL_COLS_PER_SECOND) / ring.cols;
    offset.current = (offset.current + step) % 1;
    ring.texture.offset.x = offset.current;
  });

  if (!ring) return null;
  return (
    <group rotation={TILT}>
      <mesh geometry={GEOMETRY} material={ring.material} renderOrder={2} />
    </group>
  );
}
