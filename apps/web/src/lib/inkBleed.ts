/**
 * The theme switch bleeds ink: the new theme spreads from the click as a ragged, boiling blob.
 *
 * A View Transition snapshots the old and new page (WebGL canvases included). The new snapshot is
 * revealed through an animated `clip-path: polygon(...)` whose outline is driven by noise on the
 * circle: slow lobes, a drifting fBm blob and sparse ridged tendrils. The easing is baked into the
 * keyframes, so the animation itself runs linear.
 */

type Point = { x: number; y: number };

const DURATION_MS = 1100;
const KEYFRAMES = 28;
const VERTICES = 300;
/** A click this recent is where the ink lands. Older than this, it starts from the toggle. */
const ORIGIN_FRESH_MS = 1000;

let lastPointer: (Point & { at: number }) | null = null;
let running: ViewTransition | null = null;

/** Remembers where the user last pressed, so the bleed starts under their finger. */
export function rememberInkOrigin(): () => void {
  const onDown = (e: PointerEvent) => {
    lastPointer = { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  return () => window.removeEventListener('pointerdown', onDown, { capture: true });
}

/** The last press if fresh, else the theme toggle on screen, else the middle of the viewport. */
function inkOrigin(): Point {
  if (lastPointer && performance.now() - lastPointer.at < ORIGIN_FRESH_MS) return lastPointer;
  const toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    const r = toggle.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: innerWidth / 2, y: innerHeight / 2 };
}

// Hashed 2D value noise with fBm. Sampled on a circle, so every outline closes without a seam.
function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Sum of octaves, centred on 0, roughly in [-0.5, 0.5]. */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y);
    norm += amp;
    // Rotate and scale each octave so the grid never lines up.
    const nx = (0.8 * x - 0.6 * y) * 2.03;
    y = (0.6 * x + 0.8 * y) * 2.03;
    x = nx;
    amp *= 0.5;
  }
  return sum / norm - 0.5;
}

/** Keyframes of a ragged ink blob growing from `origin` until it covers a `w` x `h` viewport. */
export function buildInkKeyframes(origin: Point, seed: number, w: number, h: number): Keyframe[] {
  const maxDist =
    Math.max(
      Math.hypot(origin.x, origin.y),
      Math.hypot(w - origin.x, origin.y),
      Math.hypot(origin.x, h - origin.y),
      Math.hypot(w - origin.x, h - origin.y),
    ) + 4;
  const sx = seed * 17.3;
  const sy = seed * 31.7;
  const frames: Keyframe[] = [];
  for (let k = 0; k <= KEYFRAMES; k++) {
    const linear = k / KEYFRAMES;
    const eased = 1 - (1 - linear) ** 3; // power3.out
    const radius = eased * maxDist;
    const t = linear * 1.6; // the edge boils while it spreads
    // From 45% on, push the whole edge out so the last frame covers every corner.
    const ramp = Math.max(0, (linear - 0.45) / 0.55);
    const cleanup = ramp * ramp * maxDist * 0.4 + Math.max(0, (linear - 0.97) / 0.03) * maxDist;
    const points: string[] = [];
    for (let i = 0; i < VERTICES; i++) {
      const theta = (i / VERTICES) * Math.PI * 2;
      const cx = Math.cos(theta);
      const cy = Math.sin(theta);
      // Lopsided lobes: direction only, so even a small drop is not round.
      const lobes = fbm(cx * 1.2 + sx, cy * 1.2 + sy, 2);
      // The blob drifts with time, so the edge crawls instead of scaling.
      const blob = fbm(cx * 2.4 + sx + t * 0.7, cy * 2.4 + sy - t * 0.5, 3);
      // Ridged noise at high frequency, raised to a power: sparse thin tendrils.
      const ridge = 1 - Math.abs(2 * noise(cx * 9 + sx + t * 0.3, cy * 9 + sy) - 1);
      const tendril = ridge ** 16 * 0.28;
      const reach = Math.max(0.35, 1 + 0.8 * lobes + 0.45 * blob + tendril);
      const r = radius * reach + cleanup;
      points.push(`${(origin.x + cx * r).toFixed(1)}px ${(origin.y + cy * r).toFixed(1)}px`);
    }
    frames.push({ clipPath: `polygon(${points.join(',')})` });
  }
  return frames;
}

/** Runs `apply` (the DOM theme flip) behind an ink bleed, or instantly when motion is off. */
export function inkBleed(apply: () => void): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (running) {
    // A second switch mid-bleed: finish the first at once and flip straight away.
    running.skipTransition();
    apply();
    return;
  }
  if (reduced || document.hidden || typeof document.startViewTransition !== 'function') {
    apply();
    return;
  }
  const origin = inkOrigin();
  const root = document.documentElement;
  root.dataset.inkBleed = '';
  const vt = document.startViewTransition(apply);
  running = vt;
  let spread: Animation | null = null;
  vt.ready
    .then(() => {
      spread = root.animate(
        buildInkKeyframes(origin, Math.random() * 100, innerWidth, innerHeight),
        {
          duration: DURATION_MS,
          easing: 'linear',
          fill: 'both',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    })
    .catch(() => {});
  vt.finished
    .catch(() => {})
    .finally(() => {
      if (running === vt) running = null;
      // A held fill would clip the root of the next View Transition (PageSwap, review).
      spread?.cancel();
      delete root.dataset.inkBleed;
    });
}
