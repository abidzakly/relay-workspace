import { Ball, Box, Cone, Cyl } from '../scene/parts';

/** Small props the Code Review gateways carry (the Git story in miniature, a beacon, a cup of tea). */

/** Home: a little branching tree, one lit node per review waiting (max 3), the Git story in a pot. */
export function BranchTree({ lit }: { lit: number }) {
  const nodes: [number, number, number][] = [
    [0, 0.2, 0],
    [-0.055, 0.15, 0.01],
    [0.06, 0.13, -0.01],
  ];
  return (
    <group>
      <Cyl r={0.04} rBottom={0.032} h={0.05} position={[0, 0.025, 0]} color="#a0623f" />
      <Cyl r={0.006} h={0.16} position={[0, 0.12, 0]} color="#5b4636" />
      <Box
        size={[0.006, 0.07, 0.006]}
        position={[-0.03, 0.13, 0.005]}
        rotation={[0, 0, 0.8]}
        color="#5b4636"
      />
      <Box
        size={[0.006, 0.07, 0.006]}
        position={[0.032, 0.11, -0.005]}
        rotation={[0, 0, -0.9]}
        color="#5b4636"
      />
      {nodes.map((p, i) => (
        <Ball
          key={i}
          r={0.016}
          position={p}
          color={i < lit ? '#ffd27a' : '#7a9a6a'}
          emissive={i < lit ? '#ffb347' : '#000000'}
          emissiveIntensity={i < lit ? 1.6 : 0}
          noGlow
        />
      ))}
    </group>
  );
}

/** Sick: a cup of tea beside the reading tablet. Nothing here asks for work. */
export function TeaCup() {
  return (
    <group>
      <Cyl r={0.035} rBottom={0.028} h={0.07} position={[0, 0.035, 0]} color="#f3efe8" />
      <Cyl r={0.031} h={0.004} position={[0, 0.066, 0]} color="#a8743d" shadow={false} />
      <Box size={[0.012, 0.035, 0.012]} position={[0.042, 0.04, 0]} color="#f3efe8" />
    </group>
  );
}

/** Leave: a tiny lighthouse, the repository beacon; it stays dark unless something finished. */
export function Beacon() {
  return (
    <group>
      <Cyl r={0.03} rBottom={0.04} h={0.06} position={[0, 0.03, 0]} color="#f3efe8" />
      <Cyl r={0.026} rBottom={0.03} h={0.06} position={[0, 0.09, 0]} color="#d6453d" />
      <Cyl r={0.022} rBottom={0.026} h={0.05} position={[0, 0.145, 0]} color="#f3efe8" />
      <Ball
        r={0.018}
        position={[0, 0.185, 0]}
        color="#fff6d8"
        emissive="#ffd890"
        emissiveIntensity={0.6}
        noGlow
      />
      <Cone r={0.026} h={0.03} position={[0, 0.215, 0]} color="#2b2f36" />
    </group>
  );
}
