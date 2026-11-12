import { MAX_STAGE, type ProgressSegment } from './progressMapping';

/**
 * Card titles -> the block-letter banner of the text ring. Free of three.js and React.
 *
 * Each title is drawn whole by the browser, so shaping, right-to-left runs and font fallback all work, then thresholded
 * into a grid with one `█` per lit cell. A `█` is about twice as tall as it is wide, so the grid is sampled at twice the
 * horizontal resolution to keep letters in proportion.
 */

/** Grid rows. Enough to keep CJK recognisable; tall marks in some scripts can still clip at the edges. */
export const ROWS = 14;
const FONT_PX = 12;
const BASELINE = 11;
const X_SAMPLES = 2;
const FONT_FAMILY = 'system-ui, sans-serif';
const LIT_ALPHA = 96;

/** Texture pixels per grid cell. */
export const CELL_WIDTH = 3;
const CELL_HEIGHT = CELL_WIDTH * 2;

const MAX_TITLE_GRAPHEMES = 40;
const GAP_COLUMNS = 40;
/** Kept free so the "+N more" note always fits. */
const MORE_COLUMNS = 160;

const UNTITLED = '(untitled)';
const MISSING_GLYPH = '?';
const INVISIBLE = /^[\p{Cc}\p{Cf}]+$/u;
const PROBE_PX = 32;
const PROBE_WIDTH = PROBE_PX * 3;
const PROBE_HEIGHT = PROBE_PX * 2;
/** A noncharacter: no font has it, so this draws what the browser draws for a missing glyph. */
const NOT_A_GLYPH = '\u{10FFFF}';

/** Lit cells, `rows` tall, in row order. */
export interface Banner {
  cols: number;
  bits: Uint8Array;
}

function context2d(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true });
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

let probeContext: CanvasRenderingContext2D | null | undefined;
const probed = new Map<string, boolean>();

function probeSignature(ctx: CanvasRenderingContext2D, text: string): string {
  ctx.clearRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  ctx.fillText(text, PROBE_PX / 2, PROBE_PX * 1.25);
  const { data } = ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  let signature = '';
  for (let i = 3; i < data.length; i += 4) signature += (data[i] ?? 0) >= LIT_ALPHA ? '1' : '0';
  return signature;
}

/**
 * True if no installed font can draw this grapheme: it comes out blank, or the same as the browser's own missing-glyph box.
 * Best effort: a fallback font can bring its own box, which then passes as a real glyph.
 */
function isMissing(grapheme: string): boolean {
  if (grapheme.trim() === '') return false;
  const known = probed.get(grapheme);
  if (known !== undefined) return known;
  if (probeContext === undefined) {
    probeContext = context2d(PROBE_WIDTH, PROBE_HEIGHT);
    if (probeContext) probeContext.font = `${PROBE_PX}px ${FONT_FAMILY}`;
  }
  if (!probeContext) return false;
  const signature = probeSignature(probeContext, grapheme);
  const missing =
    !signature.includes('1') || signature === probeSignature(probeContext, NOT_A_GLYPH);
  probed.set(grapheme, missing);
  return missing;
}

/** One line, clipped between graphemes (never inside an emoji or a combining sequence), with undrawable glyphs replaced. */
function displayTitle(title: string): string {
  const visible = graphemes(title).filter((g) => !INVISIBLE.test(g));
  const clipped = visible
    .slice(0, MAX_TITLE_GRAPHEMES)
    .map((g) => (isMissing(g) ? MISSING_GLYPH : g));
  if (visible.length > MAX_TITLE_GRAPHEMES) clipped.push('…');
  return clipped.join('').trim() || UNTITLED;
}

/** The titles the ring spells out, as one string per card. */
export function readyTitles(segments: readonly ProgressSegment[]): string[] {
  return segments
    .filter((s) => s.stage === MAX_STAGE)
    .map((s) => s.title.replace(/\s+/gu, ' ').trim());
}

function rasterise(text: string, maxCols: number): Banner | null {
  const font = `${FONT_PX}px ${FONT_FAMILY}`;
  const measure = context2d(1, 1);
  if (!measure) return null;
  measure.font = font;
  const width = measure.measureText(text).width;
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(width * X_SAMPLES) + 2));

  const ctx = context2d(cols, ROWS);
  if (!ctx) return null;
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.scale(X_SAMPLES, 1);
  ctx.fillText(text, 0.5, BASELINE);

  const { data } = ctx.getImageData(0, 0, cols, ROWS);
  const bits = new Uint8Array(cols * ROWS);
  for (let i = 0; i < bits.length; i += 1) {
    bits[i] = (data[i * 4 + 3] ?? 0) >= LIT_ALPHA ? 1 : 0;
  }
  return { cols, bits };
}

/**
 * The titles side by side, each followed by a gap. Rasterised apart so a right-to-left title cannot reorder its neighbours.
 * What does not fit in `maxCols` (the texture's limit) becomes a "+N more" note.
 */
export function composeBanner(titles: readonly string[], maxCols: number): Banner | null {
  const room = maxCols - MORE_COLUMNS;
  const parts: Banner[] = [];
  let used = 0;
  for (const [index, title] of titles.entries()) {
    const part = rasterise(displayTitle(title), room - GAP_COLUMNS);
    if (!part) return null;
    if (parts.length > 0 && used + part.cols + GAP_COLUMNS > room) {
      const more = rasterise(`+${titles.length - index} more`, MORE_COLUMNS - GAP_COLUMNS);
      if (more) parts.push(more);
      break;
    }
    parts.push(part);
    used += part.cols + GAP_COLUMNS;
  }
  if (parts.length === 0) return null;

  const cols = parts.reduce((total, part) => total + part.cols + GAP_COLUMNS, 0);
  const bits = new Uint8Array(cols * ROWS);
  let left = 0;
  for (const part of parts) {
    for (let row = 0; row < ROWS; row += 1) {
      const from = row * part.cols;
      bits.set(part.bits.subarray(from, from + part.cols), row * cols + left);
    }
    left += part.cols + GAP_COLUMNS;
  }
  return { cols, bits };
}

/**
 * How a banner wraps a ring of `ringCols` columns, with no stretching. A shorter banner gets blank columns so that a whole
 * number of copies closes the ring without a seam. A longer one shows as a window that scrolls along it.
 */
export function fitToRing(bannerCols: number, ringCols: number): { cols: number; repeat: number } {
  if (bannerCols >= ringCols) return { cols: bannerCols, repeat: ringCols / bannerCols };
  const repeat = Math.floor(ringCols / bannerCols);
  return { cols: Math.ceil(ringCols / repeat), repeat };
}

/** Draws the `█` glyphs, white on transparent, `cols` wide (at least the banner's width). */
export function drawBanner(banner: Banner, cols: number): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL_WIDTH;
  canvas.height = ROWS * CELL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${CELL_HEIGHT}px monospace`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < banner.cols; col += 1) {
      if (!banner.bits[row * banner.cols + col]) continue;
      const x = (col + 0.5) * CELL_WIDTH;
      ctx.fillText('█', x, (row + 0.5) * CELL_HEIGHT, CELL_WIDTH);
    }
  }
  return canvas;
}
