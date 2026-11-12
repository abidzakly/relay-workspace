import { useEffect, useMemo } from 'react';
import { BufferAttribute, Color, PlaneGeometry } from 'three';

/**
 * Low-poly ground from a height function: one faceted mesh, coloured per vertex by height and slope (grass on the
 * flats, darker on slopes, sand by the water, snow-free rock high up). Built once per world; the shape is pure data
 * (`ground(x, z)`), so objects stand exactly on it.
 */
export interface TerrainColors {
  low: string;
  mid: string;
  high: string;
  shore: string;
}

export function Terrain({
  ground,
  size,
  segments,
  colors,
  waterY = null,
  colorAt,
}: {
  ground: (x: number, z: number) => number;
  size: number;
  segments: number;
  colors: TerrainColors;
  /** Ground just above this height is shore-coloured. */
  waterY?: number | null;
  /** Overrides the height/slope colouring (beaches, snow lines, paved decks). */
  colorAt?: (x: number, z: number, y: number) => string | null;
}) {
  const geometry = useMemo(() => {
    const g = new PlaneGeometry(size, size, segments, segments);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position');
    const n = pos.count;
    const col = new Float32Array(n * 3);
    const low = new Color(colors.low);
    const mid = new Color(colors.mid);
    const high = new Color(colors.high);
    const shore = new Color(colors.shore);
    const c = new Color();
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = ground(x, z);
      pos.setY(i, y);
      const slope = Math.abs(ground(x + 0.5, z) - y) + Math.abs(ground(x, z + 0.5) - y);
      c.copy(low).lerp(mid, Math.min(1, Math.max(0, y / 4)));
      c.lerp(high, Math.min(1, Math.max(0, (y - 4) / 6)));
      c.lerp(high, Math.min(0.6, slope * 0.8));
      if (waterY !== null && y < waterY + 0.35) c.copy(shore);
      const custom = colorAt?.(x, z, y);
      if (custom) c.set(custom);
      // A little deterministic variation, so flats do not look painted.
      const v = Math.sin(x * 12.9898 + z * 78.233) * 0.5 + 0.5;
      c.multiplyScalar(0.94 + v * 0.1);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }, [ground, size, segments, colors, waterY, colorAt]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors flatShading roughness={0.95} />
    </mesh>
  );
}
