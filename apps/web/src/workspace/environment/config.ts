import type { EnvId } from '../envFor';
import { HOME_LAYOUT, HOME_SHIP } from '../environments/home/homeLayout';
import { LEAVE_LAYOUT, LEAVE_SHIP } from '../environments/leave/leaveLayout';
import { OFFICE_LAYOUT, OFFICE_SHIP } from '../environments/office/officeLayout';
import { SICK_LAYOUT, SICK_SHIP } from '../environments/sick/sickLayout';
import { TRIP_LAYOUT, TRIP_SHIP } from '../environments/trip/tripLayout';
import type { EnvLayout, V3 } from '../layout';

/** Which of the avatar's activity sets an environment uses (`scene/Avatar.tsx`). */
export type AvatarActivity = 'work' | 'home' | 'leave' | 'sick';

/**
 * Everything one environment decides for itself: where things sit, how the avatar
 * spends the day, where the distant ship hangs. The tab an object opens and the data it shows never live here: those
 * belong to the registry and the signals, the same in every environment. Pure data, free of three.js.
 */
export interface EnvironmentConfig {
  id: EnvId;
  layout: EnvLayout;
  avatar: {
    activity: AvatarActivity;
    /** How far the chair turns away from the desk (radians): off-duty days face the view. */
    restTurn: number;
  };
  /** Where the CoreStage ship hangs in this environment's sky (world metres), and how it is turned. */
  ship: { at: V3; rotY: number };
}

export const ENVIRONMENTS: Record<EnvId, EnvironmentConfig> = {
  home: {
    id: 'home',
    layout: HOME_LAYOUT,
    // Typing on the porch, with a coffee break now and then.
    avatar: { activity: 'home', restTurn: 0 },
    // Above the distant mountains.
    ship: { at: HOME_SHIP, rotY: 0.2 },
  },
  office: {
    id: 'office',
    layout: OFFICE_LAYOUT,
    // At the main building's atrium desk.
    avatar: { activity: 'work', restTurn: 0 },
    // Between the two towers.
    ship: { at: OFFICE_SHIP, rotY: 0 },
  },
  trip: {
    id: 'trip',
    layout: TRIP_LAYOUT,
    // At the terminal café, laptop open between flights, luggage beside the table.
    avatar: { activity: 'work', restTurn: 0 },
    // Above the ocean horizon.
    ship: { at: TRIP_SHIP, rotY: -0.15 },
  },
  sick: {
    id: 'sick',
    layout: SICK_LAYOUT,
    // A chair on the cabin's porch, under a blanket, looking out over the lake.
    avatar: { activity: 'sick', restTurn: 0 },
    // Behind the forest and the mountain mist.
    ship: { at: SICK_SHIP, rotY: 0.1 },
  },
  leave: {
    id: 'leave',
    layout: LEAVE_LAYOUT,
    // A deck chair: the avatar relaxes, mug in hand, looking out to the lagoon.
    avatar: { activity: 'leave', restTurn: 0 },
    // Above the open tropical sea.
    ship: { at: LEAVE_SHIP, rotY: 0.1 },
  },
};

export const environmentFor = (env: EnvId): EnvironmentConfig => ENVIRONMENTS[env];
export const layoutFor = (env: EnvId): EnvLayout => ENVIRONMENTS[env].layout;
