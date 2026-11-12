import type { ComponentType } from 'react';
import type { SkyPhase } from '@/lib/daypart';
import type { AvatarActivity } from '../environment/config';
import type { QualityTier } from '../environment/quality';
import type { Weather, WeatherFx } from '../environment/weather';
import type { EnvId } from '../envFor';
import type { RepresentationSet } from '../objects/representations';
import type { EnvPalette } from '../scene/palette';
import type { SceneData } from '../signals';

/** What an outdoor world's scenery needs from the canvas. The dashboard objects are placed by the canvas itself. */
export interface SceneryProps {
  env: EnvId;
  phase: SkyPhase;
  /** 0..1: how much artificial light is on (dusk, night). */
  lamps: number;
  animate: boolean;
  quality: QualityTier;
  pal: EnvPalette;
  data: SceneData;
  avatar: { activity: AvatarActivity; color: string | null; restTurn: number; greet: boolean };
  /** Today's decorative weather here. */
  weather: WeatherFx & { kind: Weather };
}

/** The observatory, drawn about its base; `active` = the camera is on its way to the ship through it. */
export interface ObservatoryProps {
  active: boolean;
  lamps: number;
  animate: boolean;
}

/** One environment's lazily loaded module (environment-specific bundles). */
export interface WorldModule {
  Scenery: ComponentType<SceneryProps>;
  objects: RepresentationSet;
  /** The environment's observatory: the cinematic gateway to Overview. */
  Observatory: ComponentType<ObservatoryProps>;
}
