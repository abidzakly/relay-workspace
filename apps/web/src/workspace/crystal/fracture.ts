import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

/** One broken-off piece: its geometry is centred on `centre`, so it spins about its own middle. */
export interface Shard {
  geometry: BufferGeometry;
  /** Where the piece's middle sits in the whole rock (rock units). */
  centre: Vector3;
  /** Which way it flies when the rock breaks: out from the core, a little randomised. */
  dir: Vector3;
  /** Tumble axis and speed. */
  axis: Vector3;
  spin: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Breaks a closed rock surface into `count` solid pieces. Each surface triangle joins the piece whose seed (a random
 * point inside the rock) is nearest. Every piece is then closed: each edge on its border gets a triangle to a point
 * inside the rock, which makes the fresh fracture face. Group 0 is the original surface, group 1 the fracture faces,
 * so the inside can be drawn frosted. Runs once per rock shape, in a few milliseconds.
 */
export function fracture(src: BufferGeometry, count: number, seed: number): Shard[] {
  const r = rng(seed);
  const pos = src.getAttribute('position');
  const nrm = src.getAttribute('normal');
  const uv = src.getAttribute('uv');
  const index = src.getIndex();
  if (!index) throw new Error('fracture needs an indexed geometry');
  src.computeBoundingBox();
  const box = src.boundingBox!;
  const size = box.getSize(new Vector3());

  const seeds: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    seeds.push(
      new Vector3(
        (r() - 0.5) * size.x * 0.8,
        (r() - 0.5) * size.y * 0.8,
        (r() - 0.5) * size.z * 0.8,
      ),
    );
  }

  const tris: number[][] = seeds.map(() => []);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const mid = new Vector3();
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(pos, index.getX(t));
    b.fromBufferAttribute(pos, index.getX(t + 1));
    c.fromBufferAttribute(pos, index.getX(t + 2));
    mid.copy(a).add(b).add(c).divideScalar(3);
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < seeds.length; s++) {
      const d = mid.distanceToSquared(seeds[s]!);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    tris[best]!.push(t);
  }

  const shards: Shard[] = [];
  for (let s = 0; s < seeds.length; s++) {
    const list = tris[s]!;
    if (list.length === 0) continue;
    const surfacePos: number[] = [];
    const surfaceNrm: number[] = [];
    const surfaceUv: number[] = [];
    const edges = new Map<string, [number, number]>();
    const centre = new Vector3();
    let n = 0;
    for (const t of list) {
      const ids = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      for (const id of ids) {
        surfacePos.push(pos.getX(id), pos.getY(id), pos.getZ(id));
        surfaceNrm.push(nrm.getX(id), nrm.getY(id), nrm.getZ(id));
        surfaceUv.push(uv ? uv.getX(id) : 0, uv ? uv.getY(id) : 0);
        centre.x += pos.getX(id);
        centre.y += pos.getY(id);
        centre.z += pos.getZ(id);
        n++;
      }
      // An edge shared by two triangles of this piece cancels out; what remains is the border.
      for (let k = 0; k < 3; k++) {
        const p = ids[k]!;
        const q = ids[(k + 1) % 3]!;
        const key = p < q ? `${p}_${q}` : `${q}_${p}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [p, q]);
      }
    }
    centre.divideScalar(n);
    // The fracture face: every border edge joins one apex, set a little inside the border's middle, and the whole
    // face shares one normal pointing into the rock. It renders as one flat broken plane, not a fan of slivers.
    const apex = new Vector3();
    let m = 0;
    for (const [p, q] of edges.values()) {
      apex.x += pos.getX(p) + pos.getX(q);
      apex.y += pos.getY(p) + pos.getY(q);
      apex.z += pos.getZ(p) + pos.getZ(q);
      m += 2;
    }
    if (m > 0) apex.divideScalar(m);
    apex.lerp(seeds[s]!, 0.35);
    const faceNormal = centre.clone().negate().normalize();

    const capPos: number[] = [];
    const capNrm: number[] = [];
    for (const [p, q] of edges.values()) {
      // Reverse the border's winding so the cap faces out of the piece.
      a.fromBufferAttribute(pos, q);
      b.fromBufferAttribute(pos, p);
      for (const v of [a, b, apex]) {
        capPos.push(v.x, v.y, v.z);
        capNrm.push(faceNormal.x, faceNormal.y, faceNormal.z);
      }
    }

    const all = new Float32Array(surfacePos.length + capPos.length);
    all.set(surfacePos);
    all.set(capPos, surfacePos.length);
    for (let i = 0; i < all.length; i += 3) {
      all[i] = all[i]! - centre.x;
      all[i + 1] = all[i + 1]! - centre.y;
      all[i + 2] = all[i + 2]! - centre.z;
    }
    const normals = new Float32Array(surfaceNrm.length + capNrm.length);
    normals.set(surfaceNrm);
    normals.set(capNrm, surfaceNrm.length);
    const uvs = new Float32Array((all.length / 3) * 2);
    uvs.set(surfaceUv);
    // fracture faces take a planar projection, so the frost map still lands on them
    for (let i = surfacePos.length / 3; i < all.length / 3; i++) {
      uvs[i * 2] = all[i * 3]! * 0.9 + 0.5;
      uvs[i * 2 + 1] = all[i * 3 + 1]! * 0.9 + 0.5;
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(all, 3));
    g.setAttribute('normal', new BufferAttribute(normals, 3));
    g.setAttribute('uv', new BufferAttribute(uvs, 2));
    g.addGroup(0, surfacePos.length / 3, 0);
    g.addGroup(surfacePos.length / 3, capPos.length / 3, 1);
    g.computeBoundingSphere();

    const dir = centre
      .clone()
      .normalize()
      .add(new Vector3(r() - 0.5, r() - 0.3, r() - 0.5).multiplyScalar(0.6))
      .normalize();
    shards.push({
      geometry: g,
      centre,
      dir,
      axis: new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
      spin: 2 + r() * 5,
    });
  }
  return shards;
}

const cache = new Map<string, Shard[]>();

/** The pieces of one rock shape, cut once and shared by every crystal that uses it. */
export function shardsOf(key: string, src: BufferGeometry, count = 9): Shard[] {
  let s = cache.get(key);
  if (!s) {
    s = fracture(src, count, key.length * 7919 + key.charCodeAt(key.length - 1));
    cache.set(key, s);
  }
  return s;
}
