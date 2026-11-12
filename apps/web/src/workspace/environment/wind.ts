import { MeshStandardMaterial, type ColorRepresentation } from 'three';

/**
 * One wind for the whole world. Materials made here sway their
 * vertices by height, per instance, in the vertex shader: no per-frame CPU work beyond one uniform. `WindClock`
 * advances `uTime` while the world animates; under reduced motion it stands still and so does everything.
 */
export const windUniforms = {
  uTime: { value: 0 },
  /** Metres of sway per metre of height. */
  uWind: { value: 0.05 },
};

export function windMaterial(
  color: ColorRepresentation,
  opts: { strength?: number; vertexColors?: boolean } = {},
): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.9,
    vertexColors: opts.vertexColors ?? false,
  });
  const k = (opts.strength ?? 1).toFixed(3);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
#else
  vec2 ip = vec2(0.0);
#endif
  float sway = sin(uTime * 1.3 + ip.x * 0.35 + ip.y * 0.27) + 0.35 * sin(uTime * 3.1 + ip.y);
  float bend = uWind * ${k} * max(position.y, 0.0);
  transformed.x += sway * bend;
  transformed.z += sway * bend * 0.6;`,
      );
  };
  // Same program for every wind material of the same strength.
  m.customProgramCacheKey = () => `wind-${k}`;
  return m;
}
