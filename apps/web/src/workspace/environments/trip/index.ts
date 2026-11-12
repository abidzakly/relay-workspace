import type { WorldModule } from '../../world/types';
import { TRIP_SET } from './TripObjects';
import { TripObservatory } from './TripObservatory';
import { TripWorld } from './TripWorld';

/** TRIP's module, loaded only on a travel day. */
const module: WorldModule = { Scenery: TripWorld, objects: TRIP_SET, Observatory: TripObservatory };
export default module;
