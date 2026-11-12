import type { WorldModule } from '../../world/types';
import { SICK_SET } from './SickObjects';
import { SickObservatory } from './SickObservatory';
import { SickWorld } from './SickWorld';

/** SICK's module, loaded only on a sick day. */
const module: WorldModule = { Scenery: SickWorld, objects: SICK_SET, Observatory: SickObservatory };
export default module;
