import { useEffect, useRef, useState } from 'react';
import type { ScriptField, ScriptFieldState } from '@relay/shared';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { Input } from '@/components/ui/input';

const SETTINGS = '__settings';
const CUSTOM = '__custom';
/** Fields that hold a comma list; picked several at once. */
const LIST_KEYS = new Set(['REAUTHOR_WORK_HOSTS']);

/**
 * One release-script value, picked instead of typed: "Use Settings" (no override), a value Relay already knows, or
 * "Custom…" to type one. `value` is the draft: undefined = untouched, null = forget the typed value, '' = custom but
 * still empty.
 */
export function ScriptFieldPicker({
  id,
  field,
  state,
  value,
  options,
  sourceLabel,
  onChange,
}: {
  id: string;
  field: ScriptField;
  state: ScriptFieldState | undefined;
  value: string | null | undefined;
  options: DropdownOption<string>[];
  sourceLabel: string | null;
  /** undefined = drop the draft (leave the field as it is). */
  onChange: (value: string | null | undefined) => void;
}) {
  const saved = state?.saved ? (state.value ?? '') : null;
  const current = value === undefined ? saved : value;
  const [customOpen, setCustomOpen] = useState(false);
  const customInput = useRef<HTMLInputElement>(null);
  // Picking "Custom…" moves the cursor into the box, so typing does not land on the page's shortcuts.
  useEffect(() => {
    if (customOpen) customInput.current?.focus();
  }, [customOpen]);
  const known = (v: string) => options.some((o) => o.value === v);
  // "Use Settings" means no typed value: forget a saved one, or just leave the field alone.
  const resetToSettings = () => onChange(saved !== null ? null : undefined);
  const derivedHint =
    !state?.saved && state?.value ? state.value : (sourceLabel ?? 'Nothing set there yet');

  if (LIST_KEYS.has(field.key)) {
    const picked = (current ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const all = [
      ...options,
      ...picked.filter((p) => !known(p)).map((p) => ({ value: p, label: p, hint: 'Typed' })),
    ];
    return (
      <Dropdown
        id={id}
        multiple
        width="full"
        options={all}
        value={picked}
        allLabel={`Use Settings (${derivedHint})`}
        footer={all.length === 0 ? 'No hosts known yet. Add a repo first.' : undefined}
        onChange={(v) => (v.length === 0 ? resetToSettings() : onChange(v.join(',')))}
      />
    );
  }

  const custom = customOpen || current === '' || (current !== null && !known(current));
  const rows: DropdownOption<string>[] = [
    { value: SETTINGS, label: 'Use Settings', hint: derivedHint },
    ...options,
    { value: CUSTOM, label: 'Custom…', hint: 'Type a value' },
  ];
  const selected = custom ? CUSTOM : current === null ? SETTINGS : current;

  return (
    <div className="grid gap-2">
      <Dropdown
        id={id}
        width="full"
        options={rows}
        value={selected}
        searchable={rows.length > 8}
        onChange={(v) => {
          if (v === CUSTOM) {
            setCustomOpen(true);
            if (current === null) onChange('');
            return;
          }
          setCustomOpen(false);
          if (v === SETTINGS) resetToSettings();
          else onChange(v);
        }}
      />
      {custom && (
        <Input
          ref={customInput}
          aria-label={`${field.label}, custom value`}
          autoComplete="off"
          spellCheck={false}
          value={current ?? ''}
          placeholder={field.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
