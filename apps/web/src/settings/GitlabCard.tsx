import { useQueryClient } from '@tanstack/react-query';
import type { GlobalConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, errorMap } from '@/components/Field';
import { ApiError } from '@/lib/api';
import { useSaveGlobal } from '@/lib/settingsApi';
import { opt, useDraft } from './drafts';
import { OAuthConnect } from './OAuthConnect';
import { ErrorAlert, SectionCard } from './SectionCard';
import { ModeSwitch } from './SetupGuide';

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
  const advanced = settings.gitlab.authMode === 'token';
  const mode = useSaveGlobal();
  const qc = useQueryClient();
  // Every GitLab reader changes with the mode (repos, Reviews, pickers): refetch them all.
  const setMode = (on: boolean) =>
    mode.mutate(
      { patch: (s) => ({ ...s, gitlab: { ...s.gitlab, authMode: on ? 'token' : 'connect' } }) },
      { onSuccess: () => void qc.invalidateQueries() },
    );

  return (
    <SectionCard
      id="gitlab"
      title="GitLab & public URL"
      description={
        advanced
          ? 'Advanced mode: each repo uses its own project token (set under Repos), Reviews a personal token (Reviewer access).'
          : 'One GitLab sign-in for every repo, Reviews and git over HTTPS.'
      }
      action={
        <ModeSwitch
          id="gl-advanced"
          advanced={advanced}
          pending={mode.isPending}
          onChange={setMode}
        />
      }
    >
      <ErrorAlert error={mode.error} />
      {advanced ? (
        <p className="rounded-control border border-hairline px-4 py-3 text-sm text-muted-foreground">
          Relay uses only the tokens you paste: a project access token on each repository (Repos
          &gt; Edit), and a personal access token under Reviewer access. The GitLab sign-in, if any,
          is kept but not used.
        </p>
      ) : (
        <OAuthConnect
          provider="gitlab"
          gitlabHost={settings.gitlab.host}
          what="One sign-in for every repo, for Reviews and for git over HTTPS. What Relay writes (merge requests, comments, approvals) shows under your name. Project and personal tokens, if any, are kept but not used."
        />
      )}
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
