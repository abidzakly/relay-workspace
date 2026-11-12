import { ObservatoryModel } from '../../world/Observatory';
import type { ObservatoryProps } from '../../world/types';
import { SICK_SHIP, TELESCOPE_PIVOT } from './sickLayout';

/** SICK's observatory: a small forest observatory on a knoll overlooking the mountain lake. */
export function SickObservatory(p: ObservatoryProps) {
  return (
    <ObservatoryModel
      {...p}
      pivot={TELESCOPE_PIVOT}
      ship={SICK_SHIP}
      radius={1.9}
      style={{ tower: '#7a5235', band: '#5a4a44', dome: '#9a95a8', door: '#5b3a2a' }}
    />
  );
}
