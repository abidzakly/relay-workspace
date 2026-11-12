import type { WorldModule } from '../../world/types';
import { LEAVE_SET } from './LeaveObjects';
import { LeaveObservatory } from './LeaveObservatory';
import { LeaveWorld } from './LeaveWorld';

/** LEAVE's module, loaded only on a day off. */
const module: WorldModule = {
  Scenery: LeaveWorld,
  objects: LEAVE_SET,
  Observatory: LeaveObservatory,
};
export default module;
