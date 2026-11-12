import { Box, Cyl } from '../../scene/parts';
import { ObservatoryModel } from '../../world/Observatory';
import type { ObservatoryProps } from '../../world/types';
import { TELESCOPE_PIVOT, TRIP_SHIP } from './tripLayout';

/** TRIP's observatory: the lighthouse's observation deck, on the rocks beside it, over the ocean. */
export function TripObservatory(p: ObservatoryProps) {
  return (
    <ObservatoryModel
      {...p}
      pivot={TELESCOPE_PIVOT}
      ship={TRIP_SHIP}
      radius={1.9}
      style={{ tower: '#f4f1ea', band: '#f2683c', dome: '#e8e4dc', door: '#22303f' }}
      extras={
        <group>
          <Box size={[5, 0.16, 5]} position={[0, 0.08, 0]} color="#c9c1b3" />
          {[-2.4, 2.4].map((x) => (
            <Box key={x} size={[0.06, 0.06, 5]} position={[x, 1, 0]} color="#f4f1ea" />
          ))}
          {[-2.4, -1.2, 0, 1.2, 2.4].map((z) => (
            <Cyl key={z} r={0.04} h={0.95} position={[2.4, 0.5, z]} color="#f4f1ea" />
          ))}
        </group>
      }
    />
  );
}
