import { useState } from 'react';
import {
  builtinCursorModels,
  CLAUDE_MODELS,
  familyCapabilities,
  findModel,
  MODEL_EFFORT_LABEL,
  MODEL_VENDOR_LABEL,
  resolveVariant,
  type ModelEffort,
  type ModelFamily,
} from '@relay/shared';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAgentModels } from '@/lib/cockpitApi';
import { cn } from '@/lib/utils';

/**
 * A model chooser for one agent: a searchable list of the models the local login may use, then (Cursor) the chosen
 * model's effort, Fast and Thinking variants, which Cursor folds into the id. The last option takes any id by hand. A
 * saved id the login no longer has still shows, marked, and an id the catalog does not know opens as a custom id.
 */

const CUSTOM = '__custom';
const DEFAULT = '__default';
const STANDARD = 'standard';
const MODEL_ID_RE = /^[a-z0-9.-]{1,64}$/i;

export function ModelPicker({
  agent,
  value,
  onChange,
  label,
  disabled,
  defaultLabel,
  className,
}: {
  agent: 'claude' | 'cursor';
  /** undefined = the built-in default (only with `defaultLabel`). */
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  label: string;
  disabled?: boolean;
  /** Adds a first option that clears the choice, e.g. "Built-in default". */
  defaultLabel?: string;
  className?: string;
}) {
  const catalog = useAgentModels().data;
  const families: ModelFamily[] = (agent === 'claude' ? catalog?.claude : catalog?.cursor) ?? [];
  const everything: readonly ModelFamily[] =
    agent === 'claude' ? CLAUDE_MODELS : builtinCursorModels();

  const hit = value ? findModel(families, value) : null;
  // Known to the catalog but not offered to this login: keep it visible, marked.
  const outside = value && !hit ? findModel(everything, value) : null;
  const [customOpen, setCustomOpen] = useState(false);
  const custom = customOpen || (!!value && !hit && !outside);

  const options: DropdownOption<string>[] = [
    ...(defaultLabel ? [{ value: DEFAULT, label: defaultLabel }] : []),
    ...(outside
      ? [{ value: outside.family.key, label: outside.family.label, hint: 'Not in your plan' }]
      : []),
    ...families.map((f) => ({
      value: f.key,
      label: f.label,
      hint: [agent === 'cursor' ? MODEL_VENDOR_LABEL[f.vendor] : null, f.note]
        .filter(Boolean)
        .join(' · '),
    })),
    { value: CUSTOM, label: 'Custom model id…', hint: 'Type any id' },
  ];
  const selected = custom
    ? CUSTOM
    : (hit?.family.key ?? outside?.family.key ?? (defaultLabel ? DEFAULT : null));

  const shown = hit ?? outside;
  const caps = shown && !custom ? familyCapabilities(shown.family, shown.variant) : null;
  const pick = (want: { effort?: ModelEffort | null; fast?: boolean; thinking?: boolean }) => {
    if (!shown) return;
    const v = resolveVariant(shown.family, {
      effort: shown.variant.effort,
      fast: shown.variant.fast,
      thinking: shown.variant.thinking,
      ...want,
    });
    if (v.id !== value) onChange(v.id);
  };

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown
          label={label}
          options={options}
          value={selected}
          disabled={disabled}
          searchable={options.length > 8}
          placeholder="Choose a model"
          className="min-w-44 max-w-full"
          onChange={(key) => {
            if (key === CUSTOM) {
              setCustomOpen(true);
              return;
            }
            setCustomOpen(false);
            if (key === DEFAULT) {
              if (value !== undefined) onChange(undefined);
              return;
            }
            const f = families.find((x) => x.key === key) ?? outside?.family;
            if (f && f.key !== hit?.family.key) onChange(f.defaultId);
          }}
        />
        {caps && caps.efforts.length > 0 && shown && (
          <Dropdown
            label={`${label} effort`}
            size="sm"
            disabled={disabled}
            value={shown.variant.effort ?? STANDARD}
            options={caps.efforts.map((e) => ({
              value: e ?? STANDARD,
              label: e ? MODEL_EFFORT_LABEL[e] : 'Standard',
            }))}
            onChange={(e) => pick({ effort: e === STANDARD ? null : (e as ModelEffort) })}
          />
        )}
        {caps?.fast && shown && (
          <Toggle
            label="Fast"
            title="Faster output, at a higher price"
            checked={shown.variant.fast}
            disabled={disabled}
            onChange={(fast) => pick({ fast })}
          />
        )}
        {caps?.thinking && shown && (
          <Toggle
            label="Thinking"
            title="Thinks before answering"
            checked={shown.variant.thinking}
            disabled={disabled}
            onChange={(thinking) => pick({ thinking })}
          />
        )}
      </div>
      {custom && (
        <Input
          key={value ?? ''}
          aria-label={`${label} id`}
          placeholder={agent === 'claude' ? 'e.g. claude-opus-5-5' : 'e.g. composer-2.5-fast'}
          defaultValue={value ?? ''}
          disabled={disabled}
          autoFocus={customOpen}
          className="max-w-72 font-mono text-xs"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== value && MODEL_ID_RE.test(v)) onChange(v);
            else if (!v && defaultLabel && value !== undefined) onChange(undefined);
            else e.target.value = value ?? '';
          }}
        />
      )}
      {outside && !custom && (
        <p className="text-xs text-warning">
          Your {agent === 'claude' ? 'Claude' : 'Cursor'} plan does not include this model. Runs
          will fall back to the default until you pick another.
        </p>
      )}
    </div>
  );
}

function Toggle({
  label,
  title,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  title: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={title}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
      {label}
    </label>
  );
}
