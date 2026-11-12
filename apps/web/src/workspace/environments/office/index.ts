import type { WorldModule } from '../../world/types';
import { OFFICE_SET } from './OfficeObjects';
import { OfficeObservatory } from './OfficeObservatory';
import { OfficeWorld } from './OfficeWorld';

/** OFFICE's module, loaded only on an office day. */
const module: WorldModule = {
  Scenery: OfficeWorld,
  objects: OFFICE_SET,
  Observatory: OfficeObservatory,
};
export default module;
