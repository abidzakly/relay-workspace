import type { TFunction } from 'i18next';
import { i18n } from './index';

/** A key built at run time (from a route or an id); falls back to the English text when the key is absent. */
function lookup(t: TFunction, key: string, fallback: string): string {
  return i18n.exists(key) ? (t as unknown as (k: string) => string)(key) : fallback;
}

/** A page's name by its route (`/overview` → `nav.overview`, `/` → `nav.workspace`). */
export const navLabel = (t: TFunction, route: string, fallback: string) =>
  lookup(t, `nav.${route.slice(1) || 'workspace'}`, fallback);

export const settingsGroupLabel = (t: TFunction, id: string, fallback: string) =>
  lookup(t, `settings.groups.${id}`, fallback);

export const settingsSectionTitle = (t: TFunction, id: string, fallback: string) =>
  lookup(t, `settings.sections.${id}`, fallback);
