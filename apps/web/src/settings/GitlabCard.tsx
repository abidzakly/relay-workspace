import type { GlobalConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, errorMap } from '@/components/Field';
import { ApiError } from '@/lib/api';
import { useSaveGlobal } from '@/lib/settingsApi';
import { opt, useDraft } from './drafts';
import { ErrorAlert, SectionCard } from './SectionCard';

export function toGitlabDraft(s: GlobalConfigPublic) {
  return {
    host: s.gitlab.host ?? '',
    myUsername: s.gitlab.myUsername ?? '',
    publicBaseUrl: s.publicBaseUrl ?? '',
  };
}

/** GitLab host / your username / public ngrok URL (global; repo tokens live in each repo). */
export function GitlabCard({ settings }: { settings: GlobalConfigPublic }) {
  const initial = toGitlabDraft(settings);
  const { draft, set, dirty } = useDraft(initial);
  const save = useSaveGlobal();
  const errs = errorMap(save.error instanceof ApiError ? save.error.issues : []);

  return (
    <SectionCard
      id="gitlab"
      title="GitLab & public URL"
      description="Per-repo token, project and reviewers are set on each repository, under Repos."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="GitLab host"
          htmlFor="gl-host"
          error={errs['gitlab.host']}
          hint="e.g. https://gitlab.example.com"
        >
          <Input
            id="gl-host"
            inputMode="url"
            value={draft.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder="https://gitlab.example.com"
          />
        </Field>
        <Field
          label="Your GitLab username"
          htmlFor="gl-user"
          error={errs['gitlab.myUsername']}
          hint="Used for “mine” filters and as the default version-MR assignee."
        >
          <Input
            id="gl-user"
            value={draft.myUsername}
            onChange={(e) => set('myUsername', e.target.value)}
          />
        </Field>
        <Field
          label="Public base URL (ngrok)"
          htmlFor="gl-public"
          error={errs['publicBaseUrl']}
          hint="Only POST /webhook/:repoId on :3001 is exposed through it."
          className="sm:col-span-2"
        >
          <Input
            id="gl-public"
            inputMode="url"
            value={draft.publicBaseUrl}
            onChange={(e) => set('publicBaseUrl', e.target.value)}
            placeholder="https://your-static.ngrok-free.app"
          />
        </Field>
      </div>
      <ErrorAlert error={save.error && Object.keys(errs).length === 0 ? save.error : null} />
      <div>
        <Button
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate({
              patch: (s) => ({
                ...s,
                publicBaseUrl: opt(draft.publicBaseUrl),
                gitlab: { ...s.gitlab, host: opt(draft.host), myUsername: opt(draft.myUsername) },
              }),
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </SectionCard>
  );
}
