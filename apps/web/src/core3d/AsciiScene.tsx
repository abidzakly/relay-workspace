import { useLayoutEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color } from 'three';
import { AsciiEffect } from 'three/examples/jsm/effects/AsciiEffect.js';
import type { AsciiTone } from '@/store/ui';

/** The character ramp, in order. Index 0 is the darkest pixel, so the space leaves black empty. */
const GLYPH_RAMP = ' .:-=+*#%@█▓▒░';
const RESOLUTION = 0.15;
/** What the effect sets as its font size, and the pitch one image column needs on screen. */
const FONT_PX = 2 / RESOLUTION;
const COLUMN_PX = 1 / RESOLUTION;
const MONOSPACE_ADVANCE = 0.6;

const BACKGROUND = '#000000';
const DULL_TEXT = '#a89c8e';

/**
 * The whole scene as text, using three's `AsciiEffect`. A positive `useFrame` priority replaces R3F's own
 * render, so this runs at whatever rate the canvas's frames do: it follows the FPS cap and the hidden-tab and reduced-motion
 * pauses without any logic of its own, and when paused the last picture simply stays on screen.
 *
 * The effect has no dispose method: taking its element off the page and dropping the object is all there is to free.
 */
export function AsciiScene({ tone }: { tone: AsciiTone }) {
  const gl = useThree((s) => s.gl);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);

  // `invert` so that bright pixels get the dense glyphs on this dark panel. Color is fixed at construction, so tone rebuilds.
  const effect = useMemo(
    () =>
      new AsciiEffect(gl, GLYPH_RAMP, {
        resolution: RESOLUTION,
        color: tone === 'color',
        invert: true,
      }),
    [gl, tone],
  );

  // The effect reads a transparent pixel as full brightness, which `invert` turns into the densest glyph. So: no
  // transparency while this is mounted, and the empty scene reads as black.
  useLayoutEffect(() => {
    const color = gl.getClearColor(new Color());
    const alpha = gl.getClearAlpha();
    gl.setClearColor(BACKGROUND, 1);
    return () => gl.setClearColor(color, alpha);
  }, [gl]);

  // The canvas stays underneath and keeps receiving the pointer. R3F reads offsets from the event target, which would be
  // wrong on a glyph's <span>, so the overlay must not be hit at all or the dust's picks would land in the wrong place.
  useLayoutEffect(() => {
    const host = gl.domElement.parentElement;
    if (!host) return;
    const element = effect.domElement;
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      userSelect: 'none',
      background: BACKGROUND,
      color: DULL_TEXT,
    });
    host.appendChild(element);
    return () => {
      element.remove();
      // Back on R3F's own render, which a paused loop would otherwise never get round to.
      invalidate();
    };
  }, [effect, gl, invalidate]);

  useLayoutEffect(() => {
    // Also resizes the renderer, to the same size R3F has just given it, which clears the canvas: hence the invalidate.
    effect.setSize(width, height);
    // The effect's own value leaves its text about 5% too wide, so the picture would drift from the canvas under it.
    const table = effect.domElement.querySelector('table');
    if (table) table.style.letterSpacing = `${COLUMN_PX - FONT_PX * MONOSPACE_ADVANCE}px`;
    invalidate();
  }, [effect, width, height, invalidate]);

  // A collapsed panel would make the effect read a 0-sized image, which throws.
  const drawable = Math.floor(width * RESOLUTION) >= 1 && Math.floor(height * RESOLUTION) >= 1;

  useFrame(({ scene, camera }) => {
    if (drawable) effect.render(scene, camera);
    else gl.render(scene, camera);
  }, 1);

  return null;
}
