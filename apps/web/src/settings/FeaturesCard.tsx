import { Fragment } from 'react';
import {
  FEATURE_GROUPS,
  FEATURES,
  featuresForMobileRelease,
  type FeatureId,
  type GlobalConfigPublic,
} from '@relay/shared';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSaveGlobal } from '@/lib/settingsApi';
import { useUnsupported } from '@/lib/systemApi';
import { ErrorAlert, SectionCard } from './SectionCard';

/**
 * Feature switches: hide the parts of the dashboard you do not use. Each switch saves at once. A switched-off feature
 * leaves the nav, the command palette and the workspace menu; its data stays.
 */
export function FeaturesCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const unsupported = useUnsupported();
  const on = settings.features;
  const count = FEATURES.filter((f) => on[f.id]).length;
  const toggle = (id: FeatureId, value: boolean) =>
    save.mutate({ patch: (s) => ({ ...s, features: { ...s.features, [id]: value } }) });

  return (
    <SectionCard
      id="features"
      title="Features"
      description={`Switch off what you do not use. ${count} of ${FEATURES.length} on. Nothing is deleted when a feature is off.`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <Label htmlFor="feature-mobile-release">I release and build a mobile app</Label>
          <p className="text-xs text-muted-foreground">
            Yes switches Release and Builds on, No switches them off.
          </p>
        </div>
        <Select
          id="feature-mobile-release"
          className="w-40"
          value={
            settings.profile.releasesMobileApp === null
              ? ''
              : settings.profile.releasesMobileApp
                ? 'yes'
                : 'no'
          }
          disabled={save.isPending}
          onChange={(e) => {
            const yes = e.target.value === 'yes';
            save.mutate({
              patch: (s) => ({
                ...s,
                profile: { ...s.profile, releasesMobileApp: yes },
                features: featuresForMobileRelease(s.features, yes),
              }),
            });
          }}
        >
          <option value="" disabled>
            Not answered
          </option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      </div>
      {FEATURE_GROUPS.map((g) => (
        <Fragment key={g.id}>
          <p className="type-micro text-muted-foreground">{g.label}</p>
          <ul className="-mt-2 border-b border-hairline">
            {FEATURES.filter((f) => f.group === g.id).map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-4 border-t border-hairline py-3"
              >
                <div className="grid min-w-0 gap-0.5">
                  <Label htmlFor={`feature-${f.id}`}>{f.label}</Label>
                  <p className="text-xs text-muted-foreground">{f.description}</p>
                  {unsupported.has(f.id) && (
                    <p className="text-xs text-warning">{unsupported.get(f.id)}</p>
                  )}
                </div>
                <Switch
                  id={`feature-${f.id}`}
                  checked={on[f.id] && !unsupported.has(f.id)}
                  disabled={save.isPending || unsupported.has(f.id)}
                  onCheckedChange={(v) => toggle(f.id, v)}
                />
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
      <ErrorAlert error={save.error} />
    </SectionCard>
  );
}
