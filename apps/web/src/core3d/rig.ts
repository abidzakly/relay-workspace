/** Measurements of the armillary, shared by `Gimbal` and whatever is mounted on its rings. */
export const RADII = { outer: 3.0, middle: 2.4, inner: 1.8 } as const;
export const TUBE = 0.06;
export const CORE_RADIUS = 0.6;
/** The thin shell round the core that stage 4 lights in Mode A and docks onto in Mode B. */
export const SHELL_RADIUS = CORE_RADIUS * 1.25;

/** A torus starts in the XY plane. These put each ring in its plane; see the table in `Gimbal.tsx`. */
export const RING_ROTATION = {
  outer: [0, 0, 0],
  middle: [0, Math.PI / 2, 0],
  inner: [Math.PI / 2, 0, 0],
} as const satisfies Record<string, [number, number, number]>;
