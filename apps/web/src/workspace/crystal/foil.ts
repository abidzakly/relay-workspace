import { Color, FrontSide, ShaderMaterial, type CubeTexture, type Texture } from 'three';
import type { QualityTier } from '../environment/quality';
import { STUDIO_MAX_LOD } from './studio';

/**
 * The crystal surface: one shader, no transmission pass. The rock should read as solid
 * crumpled foil rather than ice: the surface is all reflection and violent refraction, high contrast, with rainbow
 * fringes, and the fine detail is computed per pixel. Our own shader, written for our rocks:
 *
 *  - Folds and crumple: big smooth folds over the whole rock carry the refraction as long streaks; fine ridged
 *    crumple, in patches and towards the rims, breaks the reflections into foil. The rest of each face stays polished.
 *  - Chips: an object-space Voronoi lattice tilts the normal per cell, in patches, for flat glinting facets.
 *  - Reflection and refraction both sample the studio PMREM (`studio.tsx`, HDR): reflection near mirror-sharp,
 *    refraction a little blurred. Refraction samples red, green and blue at three indices: the dispersion fringes.
 *  - Thin film: a rainbow that turns with the view angle and the folds, on the reflections.
 *  - Crease lines: one-pixel bright lines where the geometry turns sharply (screen derivatives).
 *  - Veil: the faces turned to the viewer are partly see-through, so the emblem inside reads; the rims are opaque.
 *
 * Cheap enough for 60 fps at retina density: one draw per crystal and no second render of the scene.
 */
export interface FoilOptions {
  quality: QualityTier;
  dark: boolean;
  /** A fresh fracture face: frosted white, opaque. */
  frost?: boolean;
}

export type FoilMaterial = ShaderMaterial & {
  /** Read and written by `Interactive`'s hover glow, like a standard material's. */
  emissive: Color;
  emissiveIntensity: number;
};

export function foilMaterial({ quality, dark, frost = false }: FoilOptions): FoilMaterial {
  const uniforms = {
    uEnv: { value: null as CubeTexture | Texture | null },
    uTime: { value: 0 },
    uEnvRot: { value: 0 },
    uMaxLod: { value: STUDIO_MAX_LOD },
    uFold: { value: frost ? 0.08 : 0.16 },
    uFoldScale: { value: 1.7 },
    uCrumple: { value: frost ? 0.05 : 0.07 },
    uCrumpleScale: { value: 5.5 },
    uCells: { value: 9 },
    uFacet: { value: frost ? 0.12 : 0.22 },
    uIor: { value: 1.45 },
    uDisp: { value: quality === 'low' ? 0.02 : 0.045 },
    uBend: { value: 2.4 },
    uIri: { value: dark ? 0.75 : 0.6 },
    uCrease: { value: dark ? 0.8 : 1.1 },
    uStrain: { value: 0 },
    uTint: { value: new Color(dark ? '#e6e2ff' : '#f4f8fb') },
    uDeep: { value: new Color(dark ? '#6c66b8' : '#8796a6') },
    uVeil: { value: frost ? 1 : 0.36 },
    uFrost: { value: frost ? 1 : 0 },
    uPaper: { value: new Color(dark ? '#1a1a34' : '#ecebe6') },
    uGlow: { value: new Color(0, 0, 0) },
    uGlowK: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines: { OCTAVES: quality === 'low' ? 2 : quality === 'medium' ? 3 : 4 },
    transparent: !frost,
    depthWrite: true,
    side: FrontSide,
  }) as FoilMaterial;
  // Hover glow: `Interactive` copies a colour into `emissive` and sets `emissiveIntensity`.
  Object.defineProperty(material, 'emissive', { value: uniforms.uGlow.value });
  Object.defineProperty(material, 'emissiveIntensity', {
    get: () => uniforms.uGlowK.value,
    set: (v: number) => {
      uniforms.uGlowK.value = v;
    },
  });
  if (frost) material.userData.noGlow = true;
  return material;
}

const VERTEX = /* glsl */ `
varying vec3 vObj;
varying vec3 vWPos;
varying vec3 vWNrm;
void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAGMENT = /* glsl */ `
uniform mat4 modelMatrix;
uniform samplerCube uEnv;
uniform float uMaxLod;
uniform float uTime;
uniform float uEnvRot;
uniform float uCrumple;
uniform float uFold;
uniform float uFoldScale;
uniform float uCrumpleScale;
uniform float uCells;
uniform float uFacet;
uniform float uIor;
uniform float uDisp;
uniform float uBend;
uniform float uIri;
uniform float uCrease;
uniform float uStrain;
uniform vec3 uTint;
uniform vec3 uDeep;
uniform float uVeil;
uniform float uFrost;
uniform vec3 uPaper;
uniform vec3 uGlow;
uniform float uGlowK;
varying vec3 vObj;
varying vec3 vWPos;
varying vec3 vWNrm;

float h31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
/** Ridged noise: sharp creases where the noise crosses its middle, like folded foil. */
float crumple(vec3 p) {
  float s = 0.0;
  float a = 0.55;
  for (int i = 0; i < OCTAVES; i++) {
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    s += a * n * n;
    p = p * 2.13 + vec3(3.1, 1.7, 4.3);
    a *= 0.5;
  }
  return s;
}
vec3 facet(vec3 p) {
  vec3 ic = floor(p);
  vec3 fc = fract(p);
  vec3 sb = step(0.5, fc) - 1.0;
  float best = 8.0;
  vec3 cell = ic;
  for (int z = 0; z <= 1; z++) for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {
    vec3 g = sb + vec3(float(x), float(y), float(z));
    vec3 o = vec3(h31(ic + g), h31(ic + g + 17.3), h31(ic + g + 41.9));
    vec3 r = g + o - fc;
    float d = dot(r, r);
    if (d < best) { best = d; cell = ic + g; }
  }
  return vec3(h31(cell + 3.1), h31(cell + 7.7), h31(cell + 11.3)) * 2.0 - 1.0;
}
/** The studio PMREM at a roughness: three's own roughness-to-mip curve. */
vec3 env(vec3 d, float roughness) {
  float c = cos(uEnvRot);
  float s = sin(uEnvRot);
  d = vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
  float r = clamp(roughness, 0.0, 1.0);
  return textureLod(uEnv, d, uMaxLod * r * (2.0 - r)).rgb;
}

void main() {
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 N = normalize(vWNrm);
  if (!gl_FrontFacing) N = -N;
  mat3 M = mat3(modelMatrix);
  float scaleW = length(M[0]);

  float ndv0 = clamp(dot(N, V), 0.0, 1.0);

  // Big folds: a slow, smooth field. These carry the refraction, as long dark and bright streaks.
  vec3 pb = vObj * uFoldScale;
  float eb = 0.04;
  float b0 = vnoise(pb) + 0.5 * vnoise(pb * 2.1 + 9.0);
  vec3 gb = vec3(
    vnoise(pb + vec3(eb, 0.0, 0.0)) + 0.5 * vnoise((pb + vec3(eb, 0.0, 0.0)) * 2.1 + 9.0),
    vnoise(pb + vec3(0.0, eb, 0.0)) + 0.5 * vnoise((pb + vec3(0.0, eb, 0.0)) * 2.1 + 9.0),
    vnoise(pb + vec3(0.0, 0.0, eb)) + 0.5 * vnoise((pb + vec3(0.0, 0.0, eb)) * 2.1 + 9.0)) - b0;
  gb = (M * gb) / (eb * scaleW);
  gb -= N * dot(gb, N);
  vec3 Nb = normalize(N - gb * uFold * (1.0 + uStrain * 1.5));

  // Fine crumple, only in patches and towards the rims: the rest of each face stays polished.
  float mask = smoothstep(0.5, 0.72, vnoise(vObj * 2.4 + 7.0) * 0.75 + vnoise(vObj * 7.0 + 1.3) * 0.25);
  mask = max(mask, smoothstep(0.45, 0.12, ndv0) * 0.8);
  mask = clamp(mask + uStrain, 0.0, 1.0);
  vec3 po = vObj * uCrumpleScale;
  float c0 = 0.0;
  vec3 Nc = Nb;
  if (mask > 0.01) {
    float e = 0.01;
    c0 = crumple(po);
    vec3 g = vec3(crumple(po + vec3(e, 0.0, 0.0)), crumple(po + vec3(0.0, e, 0.0)), crumple(po + vec3(0.0, 0.0, e))) - c0;
    g = (M * g) / (e * scaleW);
    g -= Nb * dot(g, Nb);
    Nc = normalize(Nb - g * uCrumple * mask);
  }

  // Chips: a few flat glinting facets.
  float patchy = smoothstep(0.55, 0.7, vnoise(vObj * 3.1 + 2.3));
  vec3 f = M * facet(vObj * uCells) / scaleW;
  f -= Nc * dot(f, Nc);
  vec3 Nf = normalize(Nc + f * uFacet * patchy);

  float ndv = clamp(dot(Nf, V), 0.0, 1.0);
  float F = 0.05 + 0.95 * pow(1.0 - ndv, 5.0);

  // Reflection, with a thin-film rainbow over it.
  vec3 R = reflect(-V, Nf);
  vec3 refl = env(R, 0.04 + uFrost * 0.5);
  float film = ndv * 1.4 + b0 * 0.9 + c0 * 0.8 + uTime * 0.03;
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (film + vec3(0.0, 0.33, 0.67)));
  refl *= mix(vec3(1.0), rainbow * 1.5, uIri * (0.3 + 0.7 * (1.0 - ndv)));

  // Refraction follows the big folds (smooth streaks), with a little of the fine crumple; three indices for fringes.
  vec3 Nr = normalize(Nb + (Nb - N) * 1.2 + (Nf - Nb) * 0.35);
  vec3 tr = normalize(mix(-V, refract(-V, Nr, 1.0 / (uIor - uDisp)), uBend));
  vec3 tg = normalize(mix(-V, refract(-V, Nr, 1.0 / uIor), uBend));
  vec3 tb = normalize(mix(-V, refract(-V, Nr, 1.0 / (uIor + uDisp)), uBend));
  // Blurred a little: smooth streaks, not hard-edged blotches of the gels.
  float lod = 0.12 + uFrost * 0.45;
  vec3 refr = vec3(env(tr, lod).r, env(tg, lod).g, env(tb, lod).b);
  // Thick middle absorbs towards the deep tint; thin rims stay clear.
  refr *= mix(uTint, uDeep, smoothstep(0.25, 1.0, ndv) * 0.55);

  vec3 col = mix(refr, refl, F);

  // Frost: a fresh fracture face is white and matte.
  col = mix(col, uPaper * 0.55 + refl * 0.35 + vec3(0.25), uFrost * 0.7);

  float bend = length(fwidth(N));
  col += vec3(smoothstep(0.08, 0.32, bend) * uCrease);
  col += uGlow * uGlowK * (0.25 + F * 1.2);

  // Faces turned to the viewer let the emblem through; rims and grazing faces are solid foil.
  float solid = clamp(F * 1.8 + (1.0 - smoothstep(0.35, 0.85, ndv)), 0.0, 1.0);
  float alpha = mix(uVeil, 1.0, solid);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
