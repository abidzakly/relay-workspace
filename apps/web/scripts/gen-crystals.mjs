/**
 * Generates the Paper & Ink 3D assets: our own crystal rocks, the emblems held inside them and the pixel-art
 * crystal sprite. Everything is computed here from seeded noise and hand-written
 * shapes; nothing is downloaded. Deterministic: the same seeds give the same files.
 *
 *   node apps/web/scripts/gen-crystals.mjs
 *
 * Writes apps/web/public/models/*.glb (meshopt-compressed) and apps/web/public/textures/pixel-crystal.png.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  BufferAttribute,
  Color,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  Scene,
  Shape,
  Vector3,
} from 'three';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MODELS = join(ROOT, 'models');
const TEXTURES = join(ROOT, 'textures');
mkdirSync(MODELS, { recursive: true });
mkdirSync(TEXTURES, { recursive: true });

// GLTFExporter reads its Blob back with FileReader, which Node does not have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }
};

/* ───────────── seeded randomness and noise ───────────── */

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** 3D value noise with smooth interpolation, from a hashed lattice. */
function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function noise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const zf = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), xf), l(c(0, 1, 0), c(1, 1, 0), xf), yf),
    l(l(c(0, 0, 1), c(1, 0, 1), xf), l(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf,
  );
}
function fbm(x, y, z, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (noise3(x * f, y * f, z * f, seed + i * 17) * 2 - 1);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}

/* ───────────── crystal rocks (v2: signed distance field) ───────────── */

/**
 * A chunk of ice, described as a signed distance field and then meshed by casting a ray from the centre in every
 * direction of a dense sphere. The body is a rounded block (broad, slightly domed faces with soft edges, like a
 * tumbled ice cube), cut by a few soft fracture planes (big flat broken faces), then roughened: a fine dent noise
 * everywhere, and coarse ridged chipping only where a mask says this part of the rim broke off.
 */
const smax = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};
function roundedBox(p, half, round) {
  const qx = Math.abs(p.x) - half[0] + round;
  const qy = Math.abs(p.y) - half[1] + round;
  const qz = Math.abs(p.z) - half[2] + round;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - round;
}

function rockSdf(spec) {
  const r = rng(spec.seed);
  // A random tilt of the block, so no face lines up with the axes.
  const ax = r() * Math.PI;
  const ay = r() * Math.PI;
  const az = r() * Math.PI;
  const rot = (p) => {
    let { x, y, z } = p;
    let c = Math.cos(ax);
    let s = Math.sin(ax);
    [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(ay);
    s = Math.sin(ay);
    [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(az);
    s = Math.sin(az);
    [x, y] = [x * c - y * s, x * s + y * c];
    return { x, y, z };
  };
  const planes = [];
  for (let i = 0; i < spec.cuts; i++) {
    const n = new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    planes.push({ n, d: spec.cutDepth[0] + r() * (spec.cutDepth[1] - spec.cutDepth[0]) });
  }
  return (p) => {
    const q = rot(p);
    // a slight bulge, so faces are domed and never dead flat
    const bulge = fbm(q.x * 0.8, q.y * 0.8, q.z * 0.8, spec.seed + 5, 2) * spec.lump;
    let d = roundedBox(q, spec.half, spec.round) - bulge;
    for (const { n, d: off } of planes)
      d = smax(d, p.x * n.x + p.y * n.y + p.z * n.z - off, spec.cutSoft);
    return d;
  };
}

function rockGeometry(spec) {
  const sdf = rockSdf(spec);
  let g = new IcosahedronGeometry(1, spec.detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const dir = new Vector3();
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    // bisection along the ray: inside at 0, outside at 3
    let lo = 0;
    let hi = 3;
    for (let k = 0; k < 28; k++) {
      const mid = (lo + hi) / 2;
      p.copy(dir).multiplyScalar(mid);
      if (sdf(p) < 0) lo = mid;
      else hi = mid;
    }
    let rad = (lo + hi) / 2;
    p.copy(dir).multiplyScalar(rad);
    // chipped rims: coarse ridged noise, only where the mask is high
    const mask = Math.max(0, fbm(p.x * 1.3, p.y * 1.3, p.z * 1.3, spec.seed + 71, 2) * 2.2 - 0.25);
    const ridge = 1 - Math.abs(fbm(p.x * 5.5, p.y * 5.5, p.z * 5.5, spec.seed + 13, 4) * 2);
    rad -= Math.min(1, mask) * Math.pow(Math.max(0, ridge), 3) * spec.chip;
    // fine dents everywhere
    rad += fbm(p.x * 14, p.y * 14, p.z * 14, spec.seed + 29, 3) * spec.dent;
    pos.setXYZ(i, dir.x * rad, dir.y * rad, dir.z * rad);
  }

  // Centre and normalise to a 1 m tall rock, so placement in the app is uniform.
  g.computeBoundingBox();
  const box = g.boundingBox;
  const centre = box.getCenter(new Vector3());
  const height = box.max.y - box.min.y;
  g.translate(-centre.x, -centre.y, -centre.z);
  g.scale(1 / height, 1 / height, 1 / height);
  g.computeVertexNormals();

  // Box-projected UVs for the tiling crack and frost maps.
  const uv = new Float32Array(pos.count * 2);
  const nrm = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const [u, w] = nx > ny && nx > nz ? [z, y] : ny > nz ? [x, z] : [x, y];
    uv[i * 2] = u * 0.9 + 0.5;
    uv[i * 2 + 1] = w * 0.9 + 0.5;
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

function crystalMaterial() {
  return new MeshPhysicalMaterial({
    name: 'Crystal',
    color: new Color('#eef3f5'),
    roughness: 0.06,
    metalness: 0,
    transmission: 1,
    thickness: 0.5,
    ior: 1.5,
    dispersion: 5,
    iridescence: 0.6,
    iridescenceIOR: 1.3,
    iridescenceThicknessMinimum: 180,
    iridescenceThicknessMaximum: 620,
    attenuationColor: new Color('#dce8ee'),
    attenuationDistance: 4,
    specularIntensity: 1,
  });
}

const ROCKS = [
  {
    name: 'rock-a',
    seed: 11,
    detail: 30,
    half: [0.62, 0.78, 0.5],
    round: 0.13,
    lump: 0.06,
    cuts: 6,
    cutDepth: [0.4, 0.58],
    cutSoft: 0.025,
    chip: 0.11,
    dent: 0.003,
  },
  {
    name: 'rock-b',
    seed: 23,
    detail: 30,
    half: [0.75, 0.6, 0.55],
    round: 0.15,
    lump: 0.07,
    cuts: 6,
    cutDepth: [0.38, 0.6],
    cutSoft: 0.02,
    chip: 0.12,
    dent: 0.003,
  },
  {
    name: 'rock-c',
    seed: 37,
    detail: 30,
    half: [0.55, 0.8, 0.48],
    round: 0.12,
    lump: 0.06,
    cuts: 5,
    cutDepth: [0.42, 0.62],
    cutSoft: 0.03,
    chip: 0.1,
    dent: 0.003,
  },
  {
    name: 'rock-d',
    seed: 51,
    detail: 30,
    half: [0.68, 0.68, 0.6],
    round: 0.16,
    lump: 0.08,
    cuts: 7,
    cutDepth: [0.4, 0.58],
    cutSoft: 0.02,
    chip: 0.12,
    dent: 0.003,
  },
  {
    name: 'rock-e',
    seed: 67,
    detail: 30,
    half: [0.66, 0.74, 0.44],
    round: 0.12,
    lump: 0.05,
    cuts: 5,
    cutDepth: [0.36, 0.58],
    cutSoft: 0.025,
    chip: 0.1,
    dent: 0.003,
  },
  {
    name: 'rock-f',
    seed: 83,
    detail: 30,
    half: [0.78, 0.62, 0.58],
    round: 0.15,
    lump: 0.07,
    cuts: 6,
    cutDepth: [0.42, 0.62],
    cutSoft: 0.02,
    chip: 0.11,
    dent: 0.003,
  },
  // the core: bigger faces, more breaks, finer mesh
  {
    name: 'rock-core',
    seed: 211,
    detail: 50,
    half: [0.72, 0.8, 0.5],
    round: 0.17,
    lump: 0.05,
    cuts: 6,
    cutDepth: [0.46, 0.64],
    cutSoft: 0.02,
    chip: 0.07,
    dent: 0.0025,
  },
  // shards: thin sharp splinters for progress and the reward moments
  {
    name: 'shard-a',
    seed: 131,
    detail: 16,
    half: [0.3, 0.8, 0.22],
    round: 0.04,
    lump: 0.04,
    cuts: 5,
    cutDepth: [0.15, 0.4],
    cutSoft: 0.015,
    chip: 0.05,
    dent: 0.002,
  },
  {
    name: 'shard-b',
    seed: 149,
    detail: 16,
    half: [0.45, 0.55, 0.3],
    round: 0.05,
    lump: 0.04,
    cuts: 5,
    cutDepth: [0.2, 0.42],
    cutSoft: 0.015,
    chip: 0.05,
    dent: 0.002,
  },
];

/* ───────────── emblems (the shape held inside each crystal) ───────────── */

function poly(points) {
  const s = new Shape();
  points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}
function ring(sides, outer, inner, rot = 0) {
  const pts = (r) =>
    Array.from({ length: sides }, (_, i) => {
      const a = rot + (i / sides) * Math.PI * 2;
      return [Math.cos(a) * r, Math.sin(a) * r];
    });
  const s = poly(pts(outer));
  const hole = new Path();
  pts(inner)
    .reverse()
    .forEach(([x, y], i) => (i ? hole.lineTo(x, y) : hole.moveTo(x, y)));
  hole.closePath();
  s.holes.push(hole);
  return s;
}
function disc(r, segments = 32) {
  return poly(
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2;
      return [Math.cos(a) * r, Math.sin(a) * r];
    }),
  );
}
function rect(x, y, w, h) {
  return poly([
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]);
}
function star(points, outer, inner) {
  return poly(
    Array.from({ length: points * 2 }, (_, i) => {
      const r = i % 2 ? inner : outer;
      const a = Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
      return [Math.cos(a) * r, Math.sin(a) * r];
    }),
  );
}

/** One per world object id, plus the core (Overview) and the bench (Cockpit). Sizes in a 1-unit box. */
const EMBLEMS = {
  // MR Inbox: a tray with a downward notch
  monitor: [
    poly([
      [-0.45, -0.3],
      [0.45, -0.3],
      [0.45, 0.1],
      [0.2, 0.1],
      [0.1, -0.05],
      [-0.1, -0.05],
      [-0.2, 0.1],
      [-0.45, 0.1],
    ]),
    rect(-0.06, 0.12, 0.12, 0.28),
  ],
  // Code Review: two offset rings, a compare
  review: [ring(32, 0.24, 0.15, 0), ring(32, 0.24, 0.15, 0)],
  // Board: three columns
  notes: [
    rect(-0.42, -0.35, 0.22, 0.7),
    rect(-0.11, -0.1, 0.22, 0.45),
    rect(0.2, -0.35, 0.22, 0.55),
  ],
  // KPI: a target
  kpi: [ring(32, 0.45, 0.34), ring(32, 0.24, 0.14), disc(0.06)],
  // Sync Health: a pulse line
  router: [
    poly([
      [-0.5, -0.04],
      [-0.2, -0.04],
      [-0.1, 0.32],
      [0.04, -0.36],
      [0.14, -0.04],
      [0.5, -0.04],
      [0.5, 0.04],
      [0.18, 0.04],
      [0.06, -0.22],
      [-0.08, 0.46],
      [-0.24, 0.04],
      [-0.5, 0.04],
    ]),
  ],
  // Release: a cut gem with an arrow rising out of it
  train: [
    poly([
      [-0.26, -0.2],
      [-0.14, -0.06],
      [0.14, -0.06],
      [0.26, -0.2],
      [0, -0.48],
    ]),
    poly([
      [-0.05, 0.02],
      [0.05, 0.02],
      [0.05, 0.2],
      [0.18, 0.2],
      [0, 0.48],
      [-0.18, 0.2],
      [-0.05, 0.2],
    ]),
  ],
  // Builds: a hammer
  printer: [rect(-0.06, -0.45, 0.12, 0.6), rect(-0.3, 0.15, 0.6, 0.22)],
  // Sprint Atelier: a cut gem standing in a case
  ship: [
    ring(4, 0.5, 0.42, Math.PI / 4),
    poly([
      [-0.18, 0.12],
      [-0.08, 0.24],
      [0.08, 0.24],
      [0.18, 0.12],
      [0, -0.2],
    ]),
    rect(-0.3, -0.3, 0.6, 0.06),
  ],
  // Settings: a gear
  toolbox: [star(8, 0.45, 0.33), ring(32, 0.2, 0.1)],
  // Audit: a scroll of lines
  cabinet: [
    rect(-0.38, 0.22, 0.76, 0.08),
    rect(-0.38, 0.02, 0.6, 0.08),
    rect(-0.38, -0.18, 0.7, 0.08),
    rect(-0.38, -0.38, 0.45, 0.08),
  ],
  // Overview (the object): a hexagon ring, the studio mark
  plant: [ring(6, 0.46, 0.3, Math.PI / 6)],
  // The core: a faceted hexagon mark, thicker
  core: [ring(6, 0.5, 0.32, Math.PI / 6), ring(6, 0.18, 0.08, Math.PI / 6)],
  // The bench (Cockpit): a small star
  bench: [star(4, 0.45, 0.14)],
};
/** Emblems built from several identical parts are spread so they do not overlap. */
const OFFSETS = {
  review: [
    [-0.13, 0.08],
    [0.13, -0.08],
  ],
};

function emblemMesh(id) {
  const shapes = EMBLEMS[id];
  const group = new Group();
  group.name = id;
  const mat = new MeshStandardMaterial({
    name: 'Emblem',
    color: new Color('#b7c2ca'),
    roughness: 0.5,
    metalness: 0,
  });
  shapes.forEach((shape, i) => {
    const geo = new ExtrudeGeometry(shape, {
      depth: 0.2,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.035,
      bevelSegments: 3,
      curveSegments: 12,
    });
    geo.translate(0, 0, -0.1);
    const [ox, oy] = OFFSETS[id]?.[i] ?? [0, 0];
    geo.translate(ox, oy, 0);
    const m = new Mesh(geo, mat);
    m.name = `${id}-${i}`;
    group.add(m);
  });
  return group;
}

/* ───────────── PNG writer ───────────── */

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The pixel crystal: a 24×24 hand-drawn gem. Characters map to colours; '.' is clear.
 * K outline, W white, I ice, S shade, D deep shade, O/P/C rainbow edge pixels (orange, pink, cyan), Y sparkle.
 */
const PIXEL = [
  '........................',
  '...........Y............',
  '..........YYY...........',
  '...........Y............',
  '.........KKKKKK.........',
  '.......KKWWWIIIKK.......',
  '.....KKWWWWWIIISSKK.....',
  '....KOWWWWWWIIISSSDK....',
  '...KOWWWWWWWIIISSSDDK...',
  '...KPWWWWWWIIIISSSDDK...',
  '..KPWWWWWWIIIIISSSDDDK..',
  '..KOWWWWWIIIISSSSDDDDK..',
  '..KCIIIIIIIISSSSSDDDDK..',
  '..KCIIIIIIISSSSSDDDDDK..',
  '..KCSSIIIISSSSSDDDDDDK..',
  '...KCSSSSSSSSSDDDDDDK...',
  '...KCCSSSSSSSDDDDDDDK...',
  '....KCCSSSSSDDDDDDDK....',
  '.....KKCSSSDDDDDDKK.....',
  '.......KKSSDDDDKK.......',
  '.........KKKKKK.........',
  '........................',
  '...C...............Y....',
  '........................',
];
const PIXEL_COLOURS = {
  K: [18, 18, 26, 255],
  W: [250, 252, 255, 255],
  I: [204, 232, 246, 255],
  S: [150, 178, 196, 255],
  D: [96, 104, 132, 255],
  O: [255, 138, 76, 255],
  P: [255, 120, 196, 255],
  C: [86, 214, 255, 255],
  Y: [120, 220, 255, 255],
};
function pixelSprite(scale = 8) {
  const n = PIXEL.length;
  const size = n * scale;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = PIXEL[Math.floor(y / scale)][Math.floor(x / scale)];
      const c = PIXEL_COLOURS[ch] ?? [0, 0, 0, 0];
      buf.set(c, (y * size + x) * 4);
    }
  }
  return { size, buf };
}

/* ───────────── export ───────────── */

async function exportGlb(object, file) {
  const scene = new Scene();
  scene.add(object);
  const data = await new GLTFExporter().parseAsync(scene, {
    binary: true,
    copyright: 'Relay, generated by scripts/gen-crystals.mjs',
  });
  const packed = await meshoptPack(new Uint8Array(data));
  writeFileSync(join(MODELS, file), packed);
  return packed.byteLength;
}

/**
 * EXT_meshopt_compression for a dense rock: keep every vertex (the detail is the point),
 * reorder for the GPU cache, quantise positions, normals and UVs to 16/8/12-bit, and let meshopt's codec squeeze
 * the buffers. Quantised positions put their dequantise scale on the node; `assets.ts` bakes it back into float
 * geometry once on load. The browser decodes with three's bundled meshopt decoder.
 */
async function meshoptPack(glb) {
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.readBinary(glb);
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 12 }),
  );
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  return io.writeBinary(doc);
}

const crystals = new Group();
crystals.name = 'crystals';
const mat = crystalMaterial();
for (const spec of ROCKS) {
  const mesh = new Mesh(rockGeometry(spec), mat);
  mesh.name = spec.name;
  crystals.add(mesh);
}
const emblems = new Group();
emblems.name = 'emblems';
for (const id of Object.keys(EMBLEMS)) emblems.add(emblemMesh(id));

const sizes = {
  'crystals.glb': await exportGlb(crystals, 'crystals.glb'),
  'emblems.glb': await exportGlb(emblems, 'emblems.glb'),
};
const sprite = pixelSprite();
writeFileSync(join(TEXTURES, 'pixel-crystal.png'), png(sprite.size, sprite.size, sprite.buf));
console.log('models', sizes);
console.log('textures pixel-crystal.png');
