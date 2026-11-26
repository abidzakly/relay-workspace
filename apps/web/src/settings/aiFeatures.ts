import { AI_TEMPLATE_INFO, AI_TEMPLATES, type AiTemplate } from '@relay/shared';

export interface AiFeature {
  key: AiTemplate;
  label: string;
  /** What the feature does, without the place it runs. */
  hint: string;
}

/**
 * The AI features grouped by the place they run, in template order. The place is the part of
 * `AI_TEMPLATE_INFO.where` before the colon ("Review Deck and diff" files under "Review Deck"), so a new template
 * lands in its group with no change here.
 */
export function aiFeatureGroups(): { name: string; features: AiFeature[] }[] {
  const groups = new Map<string, AiFeature[]>();
  for (const key of AI_TEMPLATES) {
    const { label, where } = AI_TEMPLATE_INFO[key];
    const cut = where.indexOf(':');
    const place = cut > 0 ? where.slice(0, cut).replace(/ and .*$/, '') : 'Other';
    const rest = cut > 0 ? where.slice(cut + 1).trim() : where;
    const hint = rest.charAt(0).toUpperCase() + rest.slice(1);
    groups.set(place, [...(groups.get(place) ?? []), { key, label, hint }]);
  }
  return [...groups].map(([name, features]) => ({ name, features }));
}
