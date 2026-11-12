import type { WorldModule } from '../../world/types';
import { HOME_SET } from './HomeObjects';
import { HomeObservatory } from './HomeObservatory';
import { HomeWorld } from './HomeWorld';

/** HOME's module, loaded only when the day is a home day. */
const module: WorldModule = { Scenery: HomeWorld, objects: HOME_SET, Observatory: HomeObservatory };
export default module;
