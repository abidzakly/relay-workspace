import { Ball, Box, Cyl } from '../scene/parts';
import type { EnvPalette } from '../scene/palette';

const CLAY = '#2b211d';
const MARIGOLD = '#f7b500';
const MOSS = '#6b8a58';

function Figure({ x, body }: { x: number; body: string }) {
  return (
    <group position={[x, 0, 0.55]}>
      <Cyl r={0.13} rBottom={0.18} h={0.5} position={[0, 0.25, 0]} color={body} />
      <Ball r={0.15} position={[0, 0.63, 0]} color={CLAY} />
    </group>
  );
}

/** The Cockpit's way in, in every world: a small workbench with two helpers at it. Drawn about its base. */
export function HelperBench({ pal }: { pal: EnvPalette }) {
  return (
    <group>
      <Box size={[2, 0.1, 0.8]} position={[0, 0.72, 0]} color={pal.desk} />
      {[-0.9, 0.9].map((x) => (
        <Box key={x} size={[0.1, 0.7, 0.7]} position={[x, 0.35, 0]} color={pal.deskLeg} />
      ))}
      <Box size={[0.5, 0.28, 0.3]} position={[-0.45, 0.91, -0.1]} color={MARIGOLD} />
      <Figure x={-0.45} body={MARIGOLD} />
      <Figure x={0.5} body={MOSS} />
    </group>
  );
}
