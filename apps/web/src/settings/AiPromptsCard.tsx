import { useState } from 'react';
import {
  AI_JSON_INSTRUCTION,
  AI_PROMPT_DEFAULTS,
  AI_TEMPLATE_INFO,
  AI_TEMPLATES,
  promptOverrideProblem,
  promptVariables,
  type AiTemplate,
  type GlobalConfigPublic,
} from '@relay/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

/**
 * The prompt each AI feature sends, readable and editable. An edit replaces the built-in prompt for that feature only;
 * Reset brings the built-in one back. The `{{placeholders}}` carry the diff, the card and the rest of the data, so
 * they must stay. Saved with the other settings, so it is audited and part of a config export.
 */
export function AiPromptsCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const edited = AI_TEMPLATES.filter((t) => settings.aiPrompts[t] !== undefined).length;
  return (
    <SectionCard
      id="ai-prompts"
      title="AI prompts"
      description={
        <>
          What each AI feature sends to the model, and your own version of it. Data such as the diff
          or the card goes in where a <code>{'{{placeholder}}'}</code> stands.
          {edited > 0 ? ` ${edited} edited.` : ''}
        </>
      }
    >
      <div className="grid divide-y divide-hairline border-y border-hairline">
        {AI_TEMPLATES.map((t) => (
          <PromptRow
            key={`${t}:${settings.aiPrompts[t] ?? ''}`}
            template={t}
            override={settings.aiPrompts[t]}
            saving={save.isPending}
            onSave={(text) =>
              save.mutate({
                patch: (s) => {
                  const aiPrompts = { ...s.aiPrompts };
                  if (text === null) delete aiPrompts[t];
                  else aiPrompts[t] = text;
                  return { ...s, aiPrompts };
                },
              })
            }
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        The Claude and Cursor CLIs have no structured output, so after the prompt they also get this
        line and the answer&apos;s JSON Schema: <q className="italic">{AI_JSON_INSTRUCTION}</q> The
        Anthropic API gets the schema as its output format instead. The answer must still match the
        schema, whatever the prompt says.
      </p>
      <ErrorAlert error={save.error} />
    </SectionCard>
  );
}

function PromptRow({
  template,
  override,
  saving,
  onSave,
}: {
  template: AiTemplate;
  override: string | undefined;
  saving: boolean;
  onSave: (text: string | null) => void;
}) {
  const info = AI_TEMPLATE_INFO[template];
  const builtIn = AI_PROMPT_DEFAULTS[template];
  const current = override ?? builtIn;
  const [draft, setDraft] = useState(current);
  const problem = promptOverrideProblem(template, draft);
  const dirty = draft.trim() !== current.trim();
  const sameAsBuiltIn = draft.trim() === builtIn.trim();
  return (
    <details className="group py-3">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="text-sm font-medium">{info.label}</span>
        {override !== undefined && <Badge variant="warning">Edited</Badge>}
        <span className="text-xs text-muted-foreground">{info.where}</span>
      </summary>
      <div className="mt-3 grid gap-2">
        <Textarea
          aria-label={`${info.label} prompt`}
          className="min-h-72 font-mono text-xs leading-relaxed"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Placeholders:{' '}
          {promptVariables(builtIn).map((v, i) => (
            <span key={v}>
              {i > 0 && ', '}
              <code>{`{{${v}}}`}</code>
            </span>
          ))}
        </p>
        {problem && <p className="text-xs text-destructive">Cannot save yet: {problem}.</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!dirty || problem !== null || saving}
            onClick={() => onSave(sameAsBuiltIn ? null : draft.trim())}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || (override === undefined && sameAsBuiltIn)}
            onClick={() => {
              setDraft(builtIn);
              if (override !== undefined) onSave(null);
            }}
          >
            Reset to built-in
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(current)}>
              Discard changes
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}
