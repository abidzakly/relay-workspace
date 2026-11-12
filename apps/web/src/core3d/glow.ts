import { MeshStandardMaterial } from 'three';

/**
 * The lit colours, shared so both modes show a stage in the same colour. Each mode has its own set, because a cross-fade
 * gives the two sets different opacities at the same moment. Always `transparent`, since changing that later would force
 * a shader recompile in the middle of the fade. At opacity 1 it looks the same as an opaque material.
 */
const glow = (color: number, intensity: number) =>
  new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    metalness: 0.2,
    roughness: 0.5,
    transparent: true,
  });

const glowSet = () => ({
  // Terracotta, river, moss and marigold.
  outer: glow(0xc4623a, 0.9),
  middle: glow(0x4f7f8f, 0.9),
  inner: glow(0x6b8a58, 0.9),
  shell: glow(0xf7b500, 1.3),
});

export const MODE_A_GLOW = glowSet();
export const MODE_B_GLOW = glowSet();

export function setGlowOpacity(set: ReturnType<typeof glowSet>, opacity: number) {
  for (const material of Object.values(set)) material.opacity = opacity;
}

/** Only frees GPU memory: three uploads these again if the view is opened again. */
export function disposeGlow() {
  for (const set of [MODE_A_GLOW, MODE_B_GLOW]) {
    for (const material of Object.values(set)) material.dispose();
  }
}
