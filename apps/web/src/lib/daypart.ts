/** The time of day. The hours are repeated in `public/theme-init.js`, which runs before this code loads. */
export type SkyPhase = 'dawn' | 'day' | 'dusk' | 'night';

export const skyPhase = (hour: number): SkyPhase =>
  hour >= 5 && hour < 8
    ? 'dawn'
    : hour >= 8 && hour < 17
      ? 'day'
      : hour >= 17 && hour < 19
        ? 'dusk'
        : 'night';
