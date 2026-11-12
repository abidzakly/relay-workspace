import { ObservatoryModel } from '../../world/Observatory';
import type { ObservatoryProps } from '../../world/types';
import { HOME_SHIP, TELESCOPE_PIVOT } from './homeLayout';

/**
 * HOME's observatory: a wooden and stone tower on the highest hill, its dome open towards the ship.
 * A gateway to Overview, not a dashboard tab.
 */
export function HomeObservatory(p: ObservatoryProps) {
  return (
    <ObservatoryModel
      {...p}
      pivot={TELESCOPE_PIVOT}
      ship={HOME_SHIP}
      style={{ tower: '#a9a39a', band: '#8a5a3b', dome: '#c4c9d0', door: '#6b3b2b' }}
    />
  );
}
