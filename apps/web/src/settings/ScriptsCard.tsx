import { useState } from 'react';
import { SCRIPT_FIELDS, SCRIPT_TOOLS, type ScriptNeed } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TimeAgo } from '@/components/TimeAgo';
import { useSaveScripts, useScripts } from '@/lib/scriptsApi';
import { ScriptFieldInputs } from '@/scripts/ScriptFieldInputs';
import { ErrorAlert, SectionCard } from './SectionCard';

const GROUPS: { need: ScriptNeed; title: string; note: string }[] = [
  {
    need: 'release',
    title: 'Needed to release',
    note: 'A release through the scripts asks for any of these that are still empty.',
  },
  {
    need: 'notion',
    title: 'Notion step',
    note: 'Used when you run vu, vcheck or nts in a terminal. The dashboard updates Notion itself.',
  },
  { need: 'optional', title: 'Optional', note: 'Leave empty to use the scripts’ defaults.' },
];

/**
 * Release scripts (tools/bin). Most values come from Settings; typing one here overrides it. Everything is written to
 * one env file the scripts read, so a terminal run and a dashboard run use the same values.
 */
export function ScriptsCard() {
  const q = useScripts();
  const save = useSaveScripts();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const s = q.data;
  const changed = Object.entries(draft).filter(([, v]) => v.trim() !== '');
  const saved = s?.fields.filter((f) => f.saved) ?? [];

  return (
    <SectionCard
      id="scripts"
      title="Release scripts"
      description="Settings for vu, mrc, vcheck, nts and reauthor. Asked only when a release needs them; kept for terminal runs too."
    >
      {s && (
        <div className="grid gap-1 text-xs text-muted-foreground">
          <p>
            Runs{' '}
            <code className="font-mono text-2xs text-foreground">
              {s.vu.path ?? 'vu (not found)'}
            </code>
            {s.vu.path
              ? s.vu.bundled
                ? ' (bundled with the dashboard)'
                : ' (your own copy)'
              : null}
            .
          </p>
          {s.envFile && (
            <p>
              Values file <code className="font-mono text-2xs text-foreground">{s.envFile}</code>
              {s.writtenAt ? (
                <>
                  , written <TimeAgo at={s.writtenAt} />
                </>
              ) : null}
              . Plain text, readable by your user only (mode 600), like glab’s own config.
            </p>
          )}
        </div>
      )}
      {s?.fileError && (
        <Alert variant="warning">
          <AlertDescription>{s.fileError}</AlertDescription>
        </Alert>
      )}
      {s && s.missingTools.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Not installed: {s.missingTools.join(', ')}</AlertTitle>
          <AlertDescription>
            The scripts call these. Install steps: docs/GUIDE.md, “Release scripts”.
          </AlertDescription>
        </Alert>
      )}

      {s &&
        GROUPS.map((g) => {
          const keys = SCRIPT_FIELDS.filter((f) => f.need === g.need).map((f) => f.key);
          return (
            <div key={g.need} className="grid gap-3 border-t border-hairline pt-4">
              <div>
                <p className="type-micro text-foreground">{g.title}</p>
                <p className="text-xs text-muted-foreground">{g.note}</p>
              </div>
              <ScriptFieldInputs
                keys={keys}
                states={s.fields}
                draft={draft}
                idPrefix="scripts"
                onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
              />
            </div>
          );
        })}

      <ErrorAlert error={save.error ?? q.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={changed.length === 0 || save.isPending}
          onClick={() =>
            save.mutate(Object.fromEntries(changed), { onSuccess: () => setDraft({}) })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {saved.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            title="Forget what you typed here: every field uses Settings again."
            onClick={() => save.mutate(Object.fromEntries(saved.map((f) => [f.key, null])))}
          >
            Use Settings for all ({saved.length} typed)
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Scripts: {SCRIPT_TOOLS.map((t) => t.id).join(', ')}.
      </p>
    </SectionCard>
  );
}
