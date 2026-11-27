import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import type { GlobalConfigPublic } from '@relay/shared';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Field, errorMap } from '@/components/Field';
import { ApiError } from '@/lib/api';
import { useSaveGlobal } from '@/lib/settingsApi';
import { CapacityWaterline } from './CapacityWaterline';
import { ErrorAlert, SectionCard } from './SectionCard';

type KpiPreset = keyof GlobalConfigPublic['kpi'];

const KPI_PRESETS: readonly { id: KpiPreset; label: string; hint: string }[] = [
  {
    id: 'pointsAsHours',
    label: 'Points as hours',
    hint: 'A card’s Point is its estimate in hours: effort on the KPI page, load in Sprints.',
  },
  {
    id: 'researchQuota',
    label: 'Research quota',
    hint: 'At least a set number of Research cards each month.',
  },
  { id: 'bugRatio', label: 'Bug ratio', hint: 'At most a set share of bug cards each month.' },
];

/** Sprint capacity for the Sprint Atelier, and the KPI presets. */
export function PlanningCard({ settings }: { settings: GlobalConfigPublic }) {
  const { t } = useTranslation();
  const saved = settings.sprint.capacityHours;
  const save = useSaveGlobal();
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(t);
  }, [justSaved]);
  const saveCapacity = (hours: number) => {
    if (hours === saved || hours <= 0) return;
    save.mutate(
      { patch: (s) => ({ ...s, sprint: { ...s.sprint, capacityHours: hours } }) },
      { onSuccess: () => setJustSaved(true) },
    );
  };
  const errs = errorMap(save.error instanceof ApiError ? save.error.issues : []);
  return (
    <SectionCard id="planning" title="Planning" description={t('settings.descriptions.planning')}>
      <Field
        label="Sprint capacity"
        htmlFor="pl-cap"
        hint="The Sprint Atelier fill line: estimated hours one sprint can hold. Type 72, 2w or 5d (a day is 8 h); saved on Enter or when you leave the field."
        error={errs['sprint.capacityHours']}
      >
        <CapacityWaterline
          id="pl-cap"
          saved={saved}
          pending={save.isPending}
          justSaved={justSaved}
          onSave={saveCapacity}
        />
      </Field>
      <ErrorAlert error={save.error && Object.keys(errs).length === 0 ? save.error : null} />
      <fieldset className="grid gap-3 border-t border-hairline pt-4">
        <legend className="type-micro text-muted-foreground">KPI presets</legend>
        {KPI_PRESETS.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor={`kpi-${p.id}`}>{p.label}</Label>
              <p className="text-xs text-muted-foreground">{p.hint}</p>
            </div>
            <Switch
              id={`kpi-${p.id}`}
              checked={settings.kpi[p.id]}
              disabled={save.isPending}
              onCheckedChange={(on) =>
                save.mutate({ patch: (s) => ({ ...s, kpi: { ...s.kpi, [p.id]: on } }) })
              }
            />
          </div>
        ))}
      </fieldset>
    </SectionCard>
  );
}
