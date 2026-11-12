import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  LineBasicMaterial,
  PointsMaterial,
  SRGBColorSpace,
  type Sprite,
} from 'three';
import { rand, type ProgressFx } from './progressFx';
import { RADII } from './rig';

/**
 * The gimbal's atmosphere and finale: a halo round the core that breathes with its level, and from 98% electric arcs
 * jumping between the rings and sparks shed from the outer ring. At 100% everything is at full strength.
 */

const ARCS = 10;
const ARC_POINTS = 9;
const SPARKS = 260;

function haloTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,240,205,0.9)');
  grd.addColorStop(0.25, 'rgba(247,181,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const onSphere = (seed: number, r: number): [number, number, number] => {
  const th = rand(seed) * Math.PI * 2;
  const ph = Math.acos(2 * rand(seed + 1) - 1);
  return [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)];
};

export function GimbalFinale({
  fx,
  animate,
  coreLevel,
}: {
  fx: ProgressFx;
  animate: boolean;
  coreLevel: number;
}) {
  const halo = useRef<Sprite>(null);
  const tex = useMemo(haloTexture, []);
  const time = useRef(0);

  const arcGeo = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(ARCS * (ARC_POINTS - 1) * 2 * 3), 3),
    );
    return g;
  }, []);
  const arcMat = useMemo(
    () =>
      new LineBasicMaterial({
        color: 0xfff0c8,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  const sparkGeo = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(SPARKS * 3), 3));
    return g;
  }, []);
  const sparkMat = useMemo(
    () =>
      new PointsMaterial({
        color: 0xffe2a8,
        size: 0.06,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      for (const d of [tex, arcGeo, arcMat, sparkGeo, sparkMat]) d.dispose();
    },
    [tex, arcGeo, arcMat, sparkGeo, sparkMat],
  );

  const writeArcs = (t: number) => {
    const pos = arcGeo.getAttribute('position') as BufferAttribute;
    const radii = [RADII.inner, RADII.middle, RADII.outer];
    const frame = Math.floor(t * 18);
    let w = 0;
    for (let a = 0; a < ARCS; a++) {
      const r0 = radii[a % 2]!;
      const r1 = radii[(a % 2) + 1]!;
      const p0 = onSphere(frame * 31 + a * 7, r0);
      const p1 = onSphere(frame * 31 + a * 7 + 3, r1);
      let prev = p0;
      for (let k = 1; k < ARC_POINTS; k++) {
        const f = k / (ARC_POINTS - 1);
        const j = k === ARC_POINTS - 1 ? 0 : 0.18;
        const cur: [number, number, number] = [
          p0[0] + (p1[0] - p0[0]) * f + (rand(frame + a * 13 + k) - 0.5) * j,
          p0[1] + (p1[1] - p0[1]) * f + (rand(frame + a * 17 + k) - 0.5) * j,
          p0[2] + (p1[2] - p0[2]) * f + (rand(frame + a * 19 + k) - 0.5) * j,
        ];
        pos.setXYZ(w++, prev[0], prev[1], prev[2]);
        pos.setXYZ(w++, cur[0], cur[1], cur[2]);
        prev = cur;
      }
    }
    pos.needsUpdate = true;
  };

  const writeSparks = (t: number) => {
    const pos = sparkGeo.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < SPARKS; i++) {
      const life = (t * 0.35 + rand(i)) % 1;
      const d = onSphere(i * 5, 1);
      const r = RADII.outer + life * 2.4;
      pos.setXYZ(i, d[0] * r, d[1] * r, d[2] * r);
    }
    pos.needsUpdate = true;
  };

  useEffect(() => {
    if (animate) return;
    arcMat.opacity = fx.finale * 0.7;
    sparkMat.opacity = fx.finale * 0.8;
    writeArcs(0);
    writeSparks(0.5);
    if (halo.current) halo.current.scale.setScalar(1.8 + coreLevel * 0.6 + fx.finale * 3);
  }, [animate, fx, coreLevel]);

  useFrame((_, delta) => {
    if (!animate) return;
    time.current += Math.min(delta, 0.1);
    const t = time.current;
    if (halo.current) {
      const breathe = 1 + Math.sin(t * 1.3) * 0.06;
      halo.current.scale.setScalar((1.8 + coreLevel * 0.6 + fx.finale * 3) * breathe);
    }
    if (fx.finale > 0) {
      writeArcs(t);
      writeSparks(t);
      arcMat.opacity = fx.finale * (0.4 + rand(Math.floor(t * 18)) * 0.6);
      sparkMat.opacity = fx.finale * 0.85;
    } else {
      arcMat.opacity = 0;
      sparkMat.opacity = 0;
    }
  });

  return (
    <>
      <sprite ref={halo} scale={2}>
        <spriteMaterial
          map={tex}
          blending={AdditiveBlending}
          depthWrite={false}
          transparent
          opacity={0.85}
          toneMapped={false}
        />
      </sprite>
      <lineSegments geometry={arcGeo} material={arcMat} frustumCulled={false} />
      <points geometry={sparkGeo} material={sparkMat} frustumCulled={false} />
    </>
  );
}
