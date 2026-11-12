import type { EnvId } from '../envFor';
import type { ObjectId, PickId } from '../registry';

/**
 * What each object IS in each environment, for the tooltip and the menu's
 * screen-reader label. The tab it opens stays the registry's; only the name of the thing changes.
 */
export const THINGS: Record<
  EnvId,
  Record<ObjectId, string> & { observatory: string; bench: string }
> = {
  home: {
    monitor: 'Mailbox',
    review: "Developer's Workshop",
    notes: 'Notice board',
    kpi: 'Archery target',
    plant: 'Bonsai',
    router: 'Communication tower',
    train: 'Miniature railway',
    printer: 'Workshop printer',
    ship: 'River boat',
    toolbox: 'Toolbox',
    cabinet: 'Archive cabinet',
    observatory: 'Hilltop observatory',
    bench: 'Helper bench',
  },
  office: {
    monitor: 'Holographic terminal',
    review: 'Engineering Review Chamber',
    notes: 'Glass planning wall',
    kpi: 'Radar target system',
    plant: 'Energy reactor',
    router: 'Rooftop antenna',
    train: 'Monorail',
    printer: 'Robotic fabrication lab',
    ship: 'Spacecraft docking bay',
    toolbox: 'Maintenance toolbox',
    cabinet: 'Server archive room',
    observatory: 'Rooftop observation dome',
    bench: 'Helper bench',
  },
  trip: {
    monitor: 'Airport information terminal',
    review: 'Engineering Dispatch Terminal',
    notes: 'Itinerary board',
    kpi: 'Destination compass',
    plant: 'Lighthouse',
    router: 'Coastal radio tower',
    train: 'Terminal shuttle',
    printer: 'Hangar printer',
    ship: 'Harbour ferry',
    toolbox: 'Travel equipment kiosk',
    cabinet: 'Customs archive office',
    observatory: 'Lighthouse observation deck',
    bench: 'Helper bench',
  },
  sick: {
    monitor: 'Cabin mailbox',
    review: 'Quiet Review Cabin',
    notes: 'Wooden notice board',
    kpi: 'Meditation stones',
    plant: 'Ancient glowing tree',
    router: 'Hilltop radio tower',
    train: 'Mountain funicular',
    printer: 'Crafts workshop',
    ship: 'Lake boat',
    toolbox: 'Care cabinet',
    cabinet: 'Archive chest',
    observatory: 'Forest observatory',
    bench: 'Helper bench',
  },
  leave: {
    monitor: 'Bungalow mailbox',
    review: 'Island Signal Station',
    notes: 'Beach hut notice board',
    kpi: 'Coconut targets',
    plant: 'Palm tree',
    router: 'Coastal radio beacon',
    train: 'Beach tram',
    printer: 'Artisan workshop printer',
    ship: 'Sailboat',
    toolbox: 'Equipment chest',
    cabinet: 'Treasure archive chest',
    observatory: 'Coastal cliff observatory',
    bench: 'Helper bench',
  },
};

/**
 * Paper & Ink: every object is now a crystal in one shared world, so the name no longer depends on the environment.
 * `THINGS` keeps the old per-world names for the stories that still describe them.
 */
export const CRYSTAL_NAMES: Record<PickId, string> = {
  monitor: 'the inbox crystal',
  review: 'the review crystal',
  notes: 'the board crystal',
  kpi: 'the target crystal',
  plant: 'the overview crystal',
  router: 'the pulse crystal',
  train: 'the release crystal',
  printer: 'the build crystal',
  ship: 'the harbor crystal',
  toolbox: 'the settings crystal',
  cabinet: 'the archive crystal',
  observatory: 'the core',
  bench: 'the helpers crystal',
};

export const thingIn = (_env: EnvId, id: PickId): string => CRYSTAL_NAMES[id];
