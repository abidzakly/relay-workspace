import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  FogExp2,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three';
import { rand } from './progressFx';

/**
 * The world around the core: a nebula sky, twinkling stars, a planet with an atmosphere rim, a sun that is also the
 * key light, and faint drifting dust. Everything is generated locally (the CSP forbids fetching textures).
 * `finale` (0..1) stretches the stars into warp streaks and warms the sun.
 */

export const SUN_DIR: [number, number, number] = [-9, 5, -6];

function nebulaTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#120d0b';
  g.fillRect(0, 0, c.width, c.height);
  const blobs: [number, number, number, string][] = [
    [0.22, 0.42, 0.42, 'rgba(134, 60, 60, 0.3)'],
    [0.32, 0.55, 0.3, 'rgba(79, 127, 143, 0.14)'],
    [0.7, 0.35, 0.36, 'rgba(196, 98, 58, 0.26)'],
    [0.78, 0.6, 0.25, 'rgba(247, 181, 0, 0.12)'],
    [0.5, 0.5, 0.6, 'rgba(43, 33, 29, 0.5)'],
  ];
  for (const [x, y, r, col] of blobs) {
    const grd = g.createRadialGradient(
      x * c.width,
      y * c.height,
      0,
      x * c.width,
      y * c.height,
      r * c.width,
    );
    grd.addColorStop(0, col);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
  }
  // faint distant stars baked into the sky
  for (let i = 0; i < 900; i++) {
    const a = rand(i) * 0.6 + 0.1;
    g.fillStyle = `rgba(245,235,220,${a})`;
    g.fillRect(rand(i + 7) * c.width, rand(i + 13) * c.height, 1, 1);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function glowTexture(inner: string, outer: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.18, inner);
  grd.addColorStop(0.4, outer);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const STAR_COUNT = 1400;

const starVert = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uWarp;
  varying float vTw;
  void main() {
    vec3 p = position;
    // warp: stars stream past the camera along -z
    p.z = mod(p.z + uWarp * uTime * 40.0 + 60.0, 120.0) - 60.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vTw = 0.55 + 0.45 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 40.0);
    gl_PointSize = (1.2 + aSeed * 2.2) * (1.0 + uWarp * 2.5) * (30.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const starFrag = /* glsl */ `
  varying float vTw;
  uniform float uWarp;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    d.y *= mix(1.0, 0.18, uWarp);
    float a = smoothstep(0.5, 0.0, length(d));
    gl_FragColor = vec4(vec3(1.0, 0.93, 0.82) * (1.0 + uWarp), a * vTw);
  }
`;

const atmoVert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const atmoFrag = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  uniform vec3 uColor;
  void main() {
    float f = pow(1.0 - max(dot(vN, vV), 0.0), 3.0);
    gl_FragColor = vec4(uColor * 1.6, f);
  }
`;

const planetFrag = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  uniform vec3 uSun;
  void main() {
    float light = clamp(dot(normalize(vN), normalize(uSun)), 0.0, 1.0);
    float band = 0.5 + 0.5 * sin(vN.y * 18.0 + vN.x * 3.0);
    vec3 base = mix(vec3(0.17, 0.09, 0.06), vec3(0.55, 0.27, 0.15), band);
    float rim = pow(1.0 - max(dot(vN, vV), 0.0), 2.0);
    gl_FragColor = vec4(base * (0.08 + light * 1.1) + vec3(0.9, 0.55, 0.2) * rim * light, 1.0);
  }
`;

export function SpaceEnvironment({ animate, finale }: { animate: boolean; finale: number }) {
  const scene = useThree((s) => s.scene);
  const sky = useMemo(() => nebulaTexture(), []);
  const sunTex = useMemo(() => glowTexture('rgba(255,250,235,1)', 'rgba(255,170,80,0.35)'), []);
  const flareTex = useMemo(() => glowTexture('rgba(245,235,220,0.6)', 'rgba(247,181,0,0.1)'), []);
  const time = useRef(0);
  const dust = useRef<Group>(null);

  const stars = useMemo(() => {
    const g = new BufferGeometry();
    const pos = new Float32Array(STAR_COUNT * 3);
    const seed = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      const r = 18 + rand(i * 3) * 40;
      const th = rand(i * 3 + 1) * Math.PI * 2;
      const ph = Math.acos(2 * rand(i * 3 + 2) - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
      seed[i] = rand(i + 999);
    }
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new BufferAttribute(seed, 1));
    return g;
  }, []);
  const starMat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: starVert,
        fragmentShader: starFrag,
        uniforms: { uTime: { value: 0 }, uWarp: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  );
  const atmoMat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: atmoVert,
        fragmentShader: atmoFrag,
        uniforms: { uColor: { value: new Color(0xe08a4a) } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: BackSide,
      }),
    [],
  );
  const planetMat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: atmoVert,
        fragmentShader: planetFrag,
        uniforms: { uSun: { value: new Vector3(...SUN_DIR).normalize() } },
      }),
    [],
  );

  useEffect(() => {
    const prev = scene.fog;
    scene.fog = new FogExp2(0x120d0b, 0.012);
    return () => {
      scene.fog = prev;
      for (const d of [sky, sunTex, flareTex, stars, starMat, atmoMat, planetMat]) d.dispose();
    };
  }, [scene, sky, sunTex, flareTex, stars, starMat, atmoMat, planetMat]);

  useFrame((_, delta) => {
    if (!animate) return;
    time.current += Math.min(delta, 0.1);
    starMat.uniforms.uTime!.value = time.current;
    starMat.uniforms.uWarp!.value +=
      (finale - starMat.uniforms.uWarp!.value) * Math.min(1, delta * 1.5);
    if (dust.current) dust.current.rotation.y += delta * 0.01;
  });

  return (
    <>
      <mesh scale={80} renderOrder={-10}>
        <sphereGeometry args={[1, 32, 16]} />
        <meshBasicMaterial map={sky} side={BackSide} depthWrite={false} fog={false} />
      </mesh>
      <points geometry={stars} material={starMat} renderOrder={-9} frustumCulled={false} />
      {/* planet, low and to the right, its lit limb facing the sun */}
      <group position={[10, -7, -22]}>
        <mesh material={planetMat}>
          <sphereGeometry args={[7, 64, 32]} />
        </mesh>
        <mesh material={atmoMat} scale={1.08}>
          <sphereGeometry args={[7, 64, 32]} />
        </mesh>
      </group>
      {/* the sun: a sprite plus the key light from the same direction */}
      <sprite
        position={SUN_DIR.map((v) => v * 3) as [number, number, number]}
        scale={10 + finale * 6}
      >
        <spriteMaterial
          map={sunTex}
          blending={AdditiveBlending}
          depthWrite={false}
          transparent
          fog={false}
        />
      </sprite>
      <sprite
        position={SUN_DIR.map((v) => -v * 0.5) as [number, number, number]}
        scale={2.5 + finale * 3}
      >
        <spriteMaterial
          map={flareTex}
          blending={AdditiveBlending}
          depthWrite={false}
          transparent
          opacity={0.35 + finale * 0.5}
          fog={false}
        />
      </sprite>
      <group ref={dust}>
        {Array.from({ length: 40 }, (_, i) => (
          <mesh
            key={i}
            position={[(rand(i) - 0.5) * 16, (rand(i + 50) - 0.5) * 10, (rand(i + 90) - 0.5) * 10]}
          >
            <sphereGeometry args={[0.012 + rand(i + 3) * 0.02, 6, 4]} />
            <meshBasicMaterial color="#c9b9a4" transparent opacity={0.35} />
          </mesh>
        ))}
      </group>
    </>
  );
}
