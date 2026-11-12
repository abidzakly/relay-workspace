import { Box, Cyl } from '../../scene/parts';
import { ObservatoryModel } from '../../world/Observatory';
import type { ObservatoryProps } from '../../world/types';
import { LEAVE_SHIP, TELESCOPE_PIVOT } from './leaveLayout';

/** LEAVE's observatory: an elevated coastal observatory built into the rocky shoreline. */
export function LeaveObservatory(p: ObservatoryProps) {
  return (
    <ObservatoryModel
      {...p}
      pivot={TELESCOPE_PIVOT}
      ship={LEAVE_SHIP}
      style={{ tower: '#d9cfbf', band: '#3f6b69', dome: '#f4f1ea', door: '#3f6b69' }}
      extras={
        <group>
          {/* a railed viewing ledge on the cliff */}
          <Box size={[5.4, 0.16, 1.6]} position={[0, 0.08, 2.9]} color="#c9c1b3" />
          <Box size={[5.4, 0.06, 0.06]} position={[0, 0.95, 3.65]} color="#f4f1ea" />
          {[-2.6, -1.3, 0, 1.3, 2.6].map((x) => (
            <Cyl key={x} r={0.04} h={0.9} position={[x, 0.5, 3.65]} color="#f4f1ea" />
          ))}
        </group>
      }
    />
  );
}
