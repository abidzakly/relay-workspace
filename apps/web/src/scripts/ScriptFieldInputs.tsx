import { SCRIPT_FIELDS, type ScriptFieldState, type ScriptSource } from '@relay/shared';
import { Field } from '@/components/Field';
import { Input } from '@/components/ui/input';
import { ScriptFieldPicker } from './ScriptFieldPicker';
import { useScriptFieldOptions } from './useScriptFieldOptions';

/** Where a derived value lives in Settings, in words. */
export const SOURCE_LABEL: Record<ScriptSource, string> = {
  'gitlab.host': 'Settings > GitLab host',
  'gitlab.hostname': 'Settings > GitLab host',
  'gitlab.myUsername': 'Settings > Your GitLab username',
  'repo.token': 'each repo’s token',
  'repo.versionBranchPrefix': 'each repo’s version branch prefix',
  'repo.reviewer': 'each repo’s first reviewer',
  'repo.commitName': 'each repo’s commit identity',
  'repo.commitEmail': 'each repo’s commit identity',
  'reviewer.token': 'Settings > Reviewer access',
  'notion.token': 'Settings > Notion',
  'notion.dataSourceId': 'Settings > Notion',
  'notion.readyStatus': 'Settings > Notion',
  'notion.version': 'Settings > Notion',
};

/**
 * Inputs for some release-script fields. Each value is picked from what Relay already knows ("Use Settings", a repo's
 * value, the GitLab or Notion sign-in) or typed under "Custom…". Picks live in `draft`: a missing key is untouched,
 * null forgets a typed value. Secrets stay password inputs and are never shown: a saved one reads "Saved" until
 * replaced.
 */
export function ScriptFieldInputs({
  keys,
  states,
  draft,
  onChange,
  idPrefix,
}: {
  keys: readonly string[];
  states: readonly ScriptFieldState[];
  draft: Record<string, string | null>;
  /** undefined = drop the key from the draft. */
  onChange: (key: string, value: string | null | undefined) => void;
  idPrefix: string;
}) {
  const options = useScriptFieldOptions();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {keys.map((key) => {
        const f = SCRIPT_FIELDS.find((x) => x.key === key);
        if (!f) return null;
        const st = states.find((s) => s.key === key);
        const derived =
          st?.derivedFrom && !st.saved
            ? `From ${SOURCE_LABEL[st.derivedFrom as ScriptSource] ?? st.derivedFrom}`
            : null;
        const placeholder = f.secret
          ? st?.saved
            ? 'Saved. Type to replace'
            : st?.filled
              ? `Using ${derived?.replace(/^From /, '') ?? 'Settings'}`
              : (f.placeholder ?? '')
          : (st?.value ?? f.placeholder ?? '');
        return (
          <Field
            key={key}
            label={f.label}
            htmlFor={`${idPrefix}-${key}`}
            hint={
              <>
                {f.hint}
                {derived ? <span className="block">{derived}.</span> : null}
              </>
            }
          >
            {f.secret || !options[key] ? (
              <Input
                id={`${idPrefix}-${key}`}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={draft[key] ?? ''}
                placeholder={placeholder}
                onChange={(e) => onChange(key, e.target.value)}
              />
            ) : (
              <ScriptFieldPicker
                id={`${idPrefix}-${key}`}
                field={f}
                state={st}
                value={key in draft ? draft[key] : undefined}
                options={options[key] ?? []}
                sourceLabel={
                  // A typed value hides where Settings would take it from; name the field's first source then.
                  (st?.derivedFrom ?? f.from[0])
                    ? (SOURCE_LABEL[(st?.derivedFrom ?? f.from[0]) as ScriptSource] ??
                      st?.derivedFrom ??
                      null)
                    : null
                }
                onChange={(v) => onChange(key, v)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
