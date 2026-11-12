import { useMemo } from 'react';
import { FeaturesSchema, pathEnabled, type Features } from '@relay/shared';
import type { GlobalConfigPublic } from '@relay/shared';
import { NAV, type NavItem } from '@/components/nav';
import { queryClient } from './queryClient';
import { keys as settingsKeys, useSettings } from './settingsApi';

/** Defaults until the settings arrive: everything on except Reviews (same as the server's). */
const DEFAULTS: Features = FeaturesSchema.parse({});

/** The feature switches (Settings > General > Features). */
export function useFeatures(): Features {
  return useSettings().data?.features ?? DEFAULTS;
}

/** The same, outside React (keyboard shortcuts): whatever the settings query last loaded. */
export function featuresNow(): Features {
  return queryClient.getQueryData<GlobalConfigPublic>(settingsKeys.settings)?.features ?? DEFAULTS;
}

export function usePathEnabled(path: string): boolean {
  return pathEnabled(path, useFeatures());
}

/** The main nav without the switched-off features. */
export function useEnabledNav(): NavItem[] {
  const features = useFeatures();
  return useMemo(() => NAV.filter((n) => pathEnabled(n.to, features)), [features]);
}

/** The KPI presets (Settings > Planning); all on until the settings load. */
export function useKpiPresets(): GlobalConfigPublic['kpi'] {
  return useSettings().data?.kpi ?? { pointsAsHours: true, researchQuota: true, bugRatio: true };
}
