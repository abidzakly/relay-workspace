import { useState } from 'react';
import type { GlobalConfigPublic } from '@relay/shared';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Field, errorMap } from '@/components/Field';
import { ApiError } from '@/lib/api';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

export function toPlanningDraft(s: GlobalConfigPublic) {
  return { capacityHours: String(s.sprint.capacityHours) };
}

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

/** The slider's usual top; a larger saved capacity stretches it. */
const CAPACITY_MAX = 160;

/** Sprint capacity for the Sprint Atelier, and the KPI presets. */
export function PlanningCard({ settings }: { settings: GlobalConfigPublic }) {
  const saved = settings.sprint.capacityHours;
  const [capacity, setCapacity] = useState(saved);
  const save = useSaveGlobal();
  const saveCapacity = (hours: number) => {
    if (hours === saved || hours <= 0) return;
    save.mutate({
      patch: (s) => ({ ...s, sprint: { ...s.sprint, capacityHours: hours } }),
    });
  };
  const errs = errorMap(save.error instanceof ApiError ? save.error.issues : []);
  return (
    <SectionCard
      id="planning"
      title="Planning"
      description="Sprint capacity for the Sprint Atelier."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Sprint capacity (hours)"
          htmlFor="pl-cap"
          hint="The Sprint Atelier fill line: estimated hours one sprint can hold. Saved when you let go."
          error={errs['sprint.capacityHours']}
        >
          <Slider
            id="pl-cap"
            min={1}
            max={Math.max(CAPACITY_MAX, Math.ceil(saved))}
            step={1}
            value={capacity}
            disabled={save.isPending}
            format={(h) => `${h} h`}
            onChange={setCapacity}
            onCommit={saveCapacity}
          />
        </Field>
      </div>
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
