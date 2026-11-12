import type { ComponentType } from 'react';
import type { EnvId } from '../envFor';
import type { ObjectId } from '../registry';
import type { EnvPalette } from '../scene/palette';
import type { SceneData } from '../signals';

/**
 * The three layers of a workspace object:
 *  1. visual model: a representation, chosen per environment (each world's `*Objects.tsx`);
 *  2. data adapter: `signals.ts` (`SceneData`), the same for every representation of a tab;
 *  3. interaction contract: `scene/Interactive.tsx` + the registry's route, the same everywhere.
 * A representation only draws: it never fetches, never navigates, never decides what the data means.
 */
export interface RepresentationProps {
  data: SceneData;
  pal: EnvPalette;
  stowed: boolean;
  animate: boolean;
  env: EnvId;
}

export type Representation = ComponentType<RepresentationProps>;
/** Every environment draws every object; only the drawing may differ. */
export type RepresentationSet = Record<ObjectId, Representation>;
