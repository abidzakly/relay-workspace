import { motion, useTransform, type MotionValue } from 'motion/react';
import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * The glass kit: flat SVG crystals in ink and paper that grow from a line. Used by the Builds and Release hold-to-start
 * triggers and by the release pipeline. Every crystal stands on the same baseline, `BASE`, in its own viewBox.
 */
export const BASE = 150;

const SHARDS = 14;
const DUST = 18;

/** A fixed pseudo-random number in [0, 1), so the scatter is the same on every render. */
export const rnd = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export interface Shape {
  outline: string;
  shoulders: string;
  ridge: string;
  glint: string;
  crack: string;
  cx: number;
  l: number;
  r: number;
  tip: number;
}

/** A hexagonal prism seen from the front, standing on the baseline: its outline, facet lines and where it would crack. */
export function prism(cx: number, w: number, h: number): Shape {
  const l = cx - w / 2;
  const r = cx + w / 2;
  const tip = BASE - h;
  const shoulder = tip + w * 0.6;
  const ridge = shoulder + w * 0.28;
  const body = BASE - shoulder;
  return {
    outline: `M${l} ${BASE} L${l} ${shoulder} L${cx} ${tip} L${r} ${shoulder} L${r} ${BASE} Z`,
    shoulders: `M${l} ${shoulder} L${cx} ${ridge} L${r} ${shoulder}`,
    ridge: `M${cx} ${tip} L${cx} ${ridge} V${BASE} M${l + w * 0.22} ${BASE} L${l + w * 0.22} ${shoulder + w * 0.12}`,
    glint: `M${cx} ${tip} L${r} ${shoulder}`,
    crack: `M${cx - w * 0.3} ${shoulder + body * 0.08} L${cx + w * 0.06} ${shoulder + body * 0.3} L${cx - w * 0.12} ${shoulder + body * 0.52} L${cx + w * 0.2} ${shoulder + body * 0.82} M${cx + w * 0.06} ${shoulder + body * 0.3} L${r} ${shoulder + body * 0.22}`,
    cx,
    l,
    r,
    tip,
  };
}

/** The gradients the crystals and their halo use. Put once in the SVG's `<defs>`. */
export function GlassGradients({ glowId, haloId }: { glowId: string; haloId: string }) {
  return (
    <>
      <linearGradient id={glowId} x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stopColor="var(--terracotta)" stopOpacity={0.55} />
        <stop offset="100%" stopColor="var(--terracotta)" stopOpacity={0} />
      </linearGradient>
      <radialGradient id={haloId}>
        <stop offset="0%" stopColor="var(--terracotta)" stopOpacity={0.5} />
        <stop offset="100%" stopColor="var(--terracotta)" stopOpacity={0} />
      </radialGradient>
    </>
  );
}

/**
 * One crystal: revealed from the line up, a bright growth front, facets drawn in as it passes them, light moving inside.
 * Cracked, it shows a fracture in the destructive ink and the growth front goes out.
 */
export function Gem({
  shape,
  growth,
  flash,
  hover = false,
  cracked = false,
  glowId,
}: {
  shape: Shape;
  growth: MotionValue<number>;
  flash: MotionValue<number>;
  hover?: boolean;
  cracked?: boolean;
  glowId: string;
}) {
  const id = useId();
  const height = BASE - shape.tip;
  const frontY = useTransform(growth, (g) => BASE - g * height);
  const clipH = useTransform(growth, (g) => g * height);
  const ridgeLen = useTransform(growth, [0.25, 0.55], [0, 1]);
  const shoulderLen = useTransform(growth, [0.5, 0.8], [0, 1]);
  const glintLen = useTransform(growth, [0.85, 1], [0, 1]);
  const glow = useTransform(growth, [0, 1], [0, 0.6]);
  const hatchY = useTransform(growth, (g) => -g * 64);
  const front = useTransform(growth, (g) => (!cracked && g > 0.02 && g < 0.995 ? 1 : 0));

  return (
    <g>
      <defs>
        <clipPath id={`${id}-grow`}>
          <motion.rect x={shape.l - 4} width={shape.r - shape.l + 8} y={frontY} height={clipH} />
        </clipPath>
        <clipPath id={`${id}-shape`}>
          <path d={shape.outline} />
        </clipPath>
      </defs>

      {/* the shape it will fill: a faint promise, marching when the pointer is over the seed */}
      <path
        d={shape.outline}
        fill="none"
        strokeDasharray="3 4"
        className={cn(
          'transition-[stroke] duration-300',
          hover ? 'crystal-march stroke-foreground/35' : 'stroke-foreground/15',
        )}
      />

      <g clipPath={`url(#${id}-grow)`}>
        <path d={shape.outline} className="fill-card" />
        <motion.path d={shape.outline} fill={`url(#${glowId})`} style={{ opacity: glow }} />
        {/* light moving inside the glass */}
        <g clipPath={`url(#${id}-shape)`}>
          <motion.g style={{ y: hatchY }}>
            {Array.from({ length: 16 }, (_, k) => {
              const y0 = shape.tip + k * 14;
              return (
                <line
                  key={k}
                  x1={shape.l - 10}
                  y1={y0 + 22}
                  x2={shape.r + 10}
                  y2={y0 - 8}
                  className={k % 4 === 0 ? 'stroke-terracotta/30' : 'stroke-foreground/[0.07]'}
                  strokeWidth={k % 4 === 0 ? 2 : 1}
                />
              );
            })}
          </motion.g>
        </g>
        <motion.path d={shape.outline} className="fill-terracotta" style={{ opacity: flash }} />
        <path
          d={shape.outline}
          fill="none"
          className="stroke-foreground"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        <motion.path
          d={shape.ridge}
          style={{ pathLength: ridgeLen }}
          className="stroke-foreground/45"
          fill="none"
        />
        <motion.path
          d={shape.shoulders}
          style={{ pathLength: shoulderLen }}
          className="stroke-foreground/45"
          fill="none"
        />
        <motion.path
          d={shape.glint}
          style={{ pathLength: glintLen }}
          className="stroke-terracotta"
          strokeWidth={2.5}
          strokeLinecap="round"
          fill="none"
        />
        {cracked && (
          <motion.path
            d={shape.crack}
            className="stroke-destructive"
            strokeWidth={1.6}
            strokeLinejoin="round"
            fill="none"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          />
        )}
      </g>

      {/* the crystallisation front: where the glass is forming right now */}
      <g clipPath={`url(#${id}-shape)`}>
        <motion.line
          x1={shape.l}
          x2={shape.r}
          y1={frontY}
          y2={frontY}
          className="stroke-terracotta"
          strokeWidth={2}
          style={{ opacity: front }}
        />
      </g>
    </g>
  );
}

/**
 * A grain drawn in from the air to the growth front. `clock` drives its loop (the growth itself while a hold is
 * running, a timer while a release stage works); `stream` fades the whole stream in and out.
 */
export function Mote({
  i,
  clock,
  growth,
  stream,
  shape,
}: {
  i: number;
  clock: MotionValue<number>;
  growth: MotionValue<number>;
  stream: MotionValue<number>;
  shape: Shape;
}) {
  const angle = rnd(i, 1) * Math.PI * 2;
  const reach = 110 + rnd(i, 2) * 90;
  const sx = shape.cx + Math.cos(angle) * reach * 1.3;
  const sy = 78 + Math.sin(angle) * reach * 0.55;
  const phase = rnd(i, 3);
  // Whole laps, so the stream has no jump when the clock wraps.
  const laps = 2 + Math.floor(rnd(i, 4) * 3);
  const lap = (c: number) => (c * laps + phase) % 1;
  // Accelerates as it falls in, like something being pulled.
  const pull = (c: number) => lap(c) ** 2;
  const x = useTransform(clock, (c) => sx + (shape.cx - sx) * pull(c));
  const y = useTransform([clock, growth], ([c = 0, g = 0]: number[]) => {
    const target = BASE - g * (BASE - shape.tip);
    return sy + (target - sy) * pull(c);
  });
  const opacity = useTransform([clock, growth, stream], ([c = 0, g = 0, s = 0]: number[]) =>
    g >= 1 ? 0 : Math.sin(Math.PI * lap(c)) * Math.min(1, g * 6 + 0.25) * s,
  );
  return (
    <motion.circle
      cx={x}
      cy={y}
      r={1 + rnd(i, 5) * 1.6}
      style={{ opacity }}
      className={i % 3 === 0 ? 'fill-terracotta' : 'fill-foreground'}
    />
  );
}

/** The seal: a shockwave along the line, a ring of light, shards flung out, a sparkle on each tip, a band of light. */
export function SealBurst({ shapes, clip, cx }: { shapes: Shape[]; clip: string; cx: number }) {
  const out = [0.15, 0.9, 0.3, 1] as const;
  const first = shapes[0];
  const cy = first ? (first.tip + BASE) / 2 : BASE / 2;
  return (
    <g pointerEvents="none">
      <motion.ellipse
        cx={cx}
        cy={BASE}
        fill="none"
        className="stroke-foreground"
        initial={{ rx: 10, ry: 2, opacity: 0.7, strokeWidth: 2 }}
        animate={{ rx: 250, ry: 24, opacity: 0, strokeWidth: 0.5 }}
        transition={{ duration: 0.9, ease: out }}
      />
      <motion.circle
        cx={cx}
        cy={cy}
        fill="none"
        className="stroke-terracotta"
        initial={{ r: 16, opacity: 0.9, strokeWidth: 3 }}
        animate={{ r: 150, opacity: 0, strokeWidth: 0.5 }}
        transition={{ duration: 0.75, ease: out }}
      />
      {Array.from({ length: SHARDS }, (_, i) => {
        const a = (i / SHARDS) * Math.PI * 2 + rnd(i, 6) * 0.35;
        const d = 110 + rnd(i, 7) * 100;
        const s = 0.6 + rnd(i, 8) * 0.9;
        return (
          <motion.g
            key={i}
            initial={{ x: cx, y: cy, rotate: 0, opacity: 1, scale: 0.3 }}
            animate={{
              x: cx + Math.cos(a) * d * 1.35,
              y: cy + Math.sin(a) * d * 0.6 + 24,
              rotate: (rnd(i, 9) > 0.5 ? 1 : -1) * (200 + rnd(i, 10) * 360),
              opacity: 0,
              scale: s,
            }}
            transition={{ duration: 0.8 + rnd(i, 11) * 0.4, ease: out }}
          >
            <path
              d="M0 -7 L5 4 L-4 5 Z"
              strokeWidth={1}
              strokeLinejoin="round"
              className={
                i % 3 === 0 ? 'fill-terracotta stroke-terracotta' : 'fill-card stroke-foreground'
              }
            />
          </motion.g>
        );
      })}
      <g clipPath={`url(#${clip})`}>
        <motion.rect
          y={0}
          width={22}
          height={BASE}
          className="fill-background"
          initial={{ x: cx - 90, opacity: 0.95, skewX: -22 }}
          animate={{ x: cx + 90, opacity: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </g>
      {shapes.map((shape, k) => (
        <g key={shape.outline} transform={`translate(${shape.cx} ${shape.tip})`}>
          <motion.path
            d="M0 -12 L2.4 -2.4 L12 0 L2.4 2.4 L0 12 L-2.4 2.4 L-12 0 L-2.4 -2.4 Z"
            className="fill-foreground"
            initial={{ scale: 0, rotate: 0 }}
            animate={{ scale: [0, 1.3, 0], rotate: 90 }}
            transition={{ duration: 0.7, delay: 0.12 + k * 0.15, ease: 'easeOut' }}
          />
        </g>
      ))}
    </g>
  );
}

/** Let go too soon: the glass breaks into grains that fall back to the line. */
export function Dust({ shapes, reached }: { shapes: Shape[]; reached: number }) {
  return (
    <g pointerEvents="none">
      {Array.from({ length: DUST }, (_, i) => {
        const shape = shapes[i % shapes.length];
        if (!shape) return null;
        const x = shape.l + rnd(i, 12) * (shape.r - shape.l);
        const y = BASE - rnd(i, 13) * reached * (BASE - shape.tip);
        return (
          <motion.rect
            key={i}
            width={2.5}
            height={2.5}
            className={i % 4 === 0 ? 'fill-terracotta' : 'fill-foreground/60'}
            initial={{ x, y, opacity: 0.9, rotate: 45 }}
            animate={{
              x: x + (rnd(i, 14) - 0.5) * 28,
              y: BASE + 2 + rnd(i, 15) * 8,
              opacity: 0,
              rotate: 45 + (rnd(i, 16) - 0.5) * 240,
            }}
            transition={{ duration: 0.55 + rnd(i, 17) * 0.5, ease: 'easeIn' }}
          />
        );
      })}
    </g>
  );
}
