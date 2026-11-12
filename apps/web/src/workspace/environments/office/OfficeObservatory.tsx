import { ObservatoryModel } from '../../world/Observatory';
import type { ObservatoryProps } from '../../world/types';
import { OFFICE_SHIP, TELESCOPE_PIVOT } from './officeLayout';

/** OFFICE's observatory: a rooftop glass observation dome on the tallest tower. */
export function OfficeObservatory(p: ObservatoryProps) {
  return (
    <ObservatoryModel
      {...p}
      pivot={TELESCOPE_PIVOT}
      ship={OFFICE_SHIP}
      radius={2.2}
      style={{ tower: '#d9dee6', band: '#43d1ff', dome: '#bfe6ff', door: '#2b2f36', glass: true }}
    />
  );
}
