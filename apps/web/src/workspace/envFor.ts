/**
 * The five worlds. Home is the everyday world; the others (office, sick, trip, leave) are kept for previews
 * (`?env=` in development) and for editions that pick the world from a calendar.
 */
export type EnvId = 'home' | 'office' | 'sick' | 'trip' | 'leave';

export const ENV_LABEL: Record<EnvId, string> = {
  home: 'Working from home',
  office: 'In the office',
  sick: 'Resting',
  trip: 'On a trip',
  leave: 'Day off',
};

/** The world shown when nothing else decides: home. */
export const DEFAULT_ENV: EnvId = 'home';

/** Off-duty worlds keep every object clickable, but put the work away (laptop closed, board covered). */
export const isStowed = (env: EnvId): boolean => env === 'sick' || env === 'leave';
