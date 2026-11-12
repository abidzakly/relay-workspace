import { useMemo, useState, type FormEvent } from 'react';
import { SECRET_MASK, type RepoConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Field, errorMap } from '@/components/Field';
import { SecretInput } from '@/components/SecretInput';
import { ApiError, describeError } from '@/lib/api';
import { useRepos, useSaveRepo, validateRepoBody } from '@/lib/settingsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { useSystem } from '@/lib/systemApi';
import { useDraft } from './drafts';
import {
  APPROVAL_MODES,
  emptyRepoDraft,
  NONE_DOMAIN,
  repoDraftToBody,
  repoToDraft,
  type RepoDraft,
} from './repoDraft';

const normDomain = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Product Domains seen on Notion cards (what the server matches against), plus the repo's current one. */
function useDomainOptions(repoId: string | undefined, current: string) {
  const stateQ = useStateSnapshot();
  const reposQ = useRepos();
  return useMemo(() => {
    const byKey = new Map<string, string>();
    for (const c of stateQ.data?.cards ?? []) {
      const d = c.productDomain?.trim();
      if (d && !byKey.has(normDomain(d))) byKey.set(normDomain(d), d);
    }
    const synced = byKey.size > 0;
    if (current && current !== NONE_DOMAIN && !byKey.has(normDomain(current))) {
      byKey.set(normDomain(current), current);
    }
    const alsoIn = new Map<string, string[]>();
    for (const r of reposQ.data ?? []) {
      if (r.id === repoId) continue;
      for (const d of r.productDomains) {
        const names = alsoIn.get(normDomain(d));
        if (names) names.push(r.name);
        else alsoIn.set(normDomain(d), [r.name]);
      }
    }
    const options = [...byKey.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([k, d]) => {
        // Informational only: a Product Domain may be shared by several repos.
        const others = alsoIn.get(k);
        return { value: d, label: others ? `${d} (also in ${others.join(', ')})` : d };
      });
    return { options, synced };
  }, [stateQ.data, reposQ.data, repoId, current]);
}

function RepoForm({
  repo,
  onDone,
}: {
  /** undefined = create */
  repo: RepoConfigPublic | undefined;
  onDone: () => void;
}) {
  const mode = repo ? 'edit' : 'create';
  // Edition presets (if any) pre-fill a new repo; the system query is already loaded by the first-start dialog.
  const repoDefaults = useSystem().data?.repoDefaults;
  const { draft, set } = useDraft<RepoDraft>(
    repo ? repoToDraft(repo) : emptyRepoDraft(repoDefaults),
  );
  const save = useSaveRepo();
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const serverErrors = errorMap(save.error instanceof ApiError ? save.error.issues : []);
  const errs = { ...serverErrors, ...clientErrors };
  const hasFieldErrors = Object.keys(errs).length > 0;
  const domainOptions = useDomainOptions(repo?.id, draft.productDomain);

  function submit(e: FormEvent) {
    e.preventDefault();
    setClientErrors({});
    const body = repoDraftToBody(draft);
    const invalid = validateRepoBody(body);
    const found = errorMap(invalid?.issues ?? []);
    if (draft.productDomain === '') {
      found['productDomains'] = 'Choose a Product Domain, or None';
    }
    if (mode === 'create' && (draft.token.trim() === '' || draft.token === SECRET_MASK)) {
      found['gitlab.token'] = 'A GitLab token is required';
    }
    if ((draft.identityName.trim() === '') !== (draft.identityEmail.trim() === '')) {
      found['commitIdentity.name'] = 'Set both name and email, or neither';
    }
    if (Object.keys(found).length > 0) {
      setClientErrors(found);
      return;
    }
    save.mutate({ mode, id: body.id, body }, { onSuccess: onDone });
  }

  const text = (key: keyof RepoDraft) => ({
    value: draft[key] as string,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as never),
  });

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>
          {mode === 'create' ? 'Add repository' : `Edit ${repo?.name ?? ''}`}
        </DialogTitle>
        <DialogDescription>
          Secrets are encrypted at rest and never shown again. The webhook secret is generated for
          you: don’t create the hook in GitLab by hand. Save, then use Register under Webhook health
          (it creates the hook with the secret), then “Test connection” on the repo row.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Identity</legend>
        <Field
          label="Repo id"
          htmlFor="r-id"
          error={errs['id']}
          hint={
            mode === 'edit'
              ? 'Immutable (used in the webhook URL and clone path).'
              : 'a-z, 0-9, “-”; used in /webhook/:id.'
          }
        >
          <Input id="r-id" {...text('id')} disabled={mode === 'edit'} autoComplete="off" />
        </Field>
        <Field label="Name" htmlFor="r-name" error={errs['name']}>
          <Input id="r-name" {...text('name')} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">GitLab</legend>
        <Field label="Project id" htmlFor="r-pid" error={errs['gitlab.projectId']}>
          <Input id="r-pid" inputMode="numeric" {...text('projectId')} />
        </Field>
        <Field
          label="Access token"
          htmlFor="r-token"
          error={errs['gitlab.token']}
          hint={
            mode === 'edit'
              ? 'Stored encrypted. Type to replace it; leave as is to keep it. Needs the `api` scope.'
              : 'Needs the `api` scope (comment, merge, webhooks, branch).'
          }
        >
          <SecretInput
            id="r-token"
            value={draft.token}
            onChange={(v) => set('token', v)}
            placeholder="glpat-…"
          />
        </Field>
        <Field label="Base branch" htmlFor="r-base" error={errs['baseBranch']}>
          <Input id="r-base" {...text('baseBranch')} />
        </Field>
        <Field
          label="Reviewers (merge gate)"
          htmlFor="r-rev"
          error={errs['reviewers']}
          hint="Comma-separated GitLab usernames; approval by ANY of them is required to merge."
        >
          <Input id="r-rev" {...text('reviewers')} placeholder="alice, bob" />
        </Field>
        <Field
          label="Notion Product Domain"
          htmlFor="r-domains"
          error={errs['productDomains']}
          hint={
            domainOptions.synced
              ? 'Cards with this Product Domain belong to this repo. Several repos can share one. Choose None if it has none.'
              : 'No Product Domains found yet: Notion has not synced cards with one. Choose None for now.'
          }
        >
          <Select
            id="r-domains"
            value={draft.productDomain}
            onChange={(e) => set('productDomain', e.target.value)}
            aria-required="true"
          >
            <option value="" disabled>
              — Choose a Product Domain —
            </option>
            <option value={NONE_DOMAIN}>None (this repo has no Product Domain)</option>
            {domainOptions.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Approval mode"
          htmlFor="r-appr"
          error={errs['approvalMode']}
          hint="Use a fallback only if your GitLab tier has no Approvals API."
        >
          <Select
            id="r-appr"
            value={draft.approvalMode}
            onChange={(e) => set('approvalMode', e.target.value as RepoDraft['approvalMode'])}
          >
            {APPROVAL_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Version-MR assignee"
          htmlFor="r-assignee"
          error={errs['assignee']}
          hint="Falls back to your GitLab username."
        >
          <Input id="r-assignee" {...text('assignee')} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Release & clone</legend>
        <Field label="Version branch prefix" htmlFor="r-vbp" error={errs['versionBranchPrefix']}>
          <Input id="r-vbp" {...text('versionBranchPrefix')} />
        </Field>
        <Field
          label="Tag format"
          htmlFor="r-tag"
          error={errs['tagFormat']}
          hint="Must contain {commitVersion}."
        >
          <Input id="r-tag" {...text('tagFormat')} />
        </Field>
        <Field
          label="Clone URL"
          htmlFor="r-clone"
          error={errs['cloneUrl']}
          hint="https, ssh, git@host:path, file:// or an absolute path."
          className="sm:col-span-2"
        >
          <Input
            id="r-clone"
            {...text('cloneUrl')}
            placeholder="git@gitlab.example.com:team/app.git"
          />
        </Field>
        <Field
          label="Local path (optional)"
          htmlFor="r-path"
          error={errs['localPath']}
          hint="Empty = auto-managed bot clone. Or point at an existing clone."
          className="sm:col-span-2"
        >
          <Input id="r-path" {...text('localPath')} />
        </Field>
        <div className="flex items-center justify-between gap-4 sm:col-span-2">
          <Label htmlFor="r-vmr-gate">Version MRs also need reviewer approval</Label>
          <Switch
            id="r-vmr-gate"
            checked={draft.requireVersionMrApproval}
            onCheckedChange={(v) => set('requireVersionMrApproval', v)}
          />
        </div>
        <div className="flex items-center justify-between gap-4 sm:col-span-2">
          <Label htmlFor="r-partial">Partial clone (faster, smaller)</Label>
          <Switch
            id="r-partial"
            checked={draft.partialClone}
            onCheckedChange={(v) => set('partialClone', v)}
          />
        </div>
        <Field
          label="Commit identity name"
          htmlFor="r-idn"
          error={errs['commitIdentity.name']}
          hint="Required to release with the node engine."
        >
          <Input id="r-idn" {...text('identityName')} />
        </Field>
        <Field
          label="Commit identity email"
          htmlFor="r-ide"
          error={errs['commitIdentity.email']}
          hint="Required to release with the node engine."
        >
          <Input id="r-ide" type="email" {...text('identityEmail')} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Flutter build</legend>
        <Field
          label="Staging flavor"
          htmlFor="r-flavor"
          error={errs['flutter.stagingFlavor']}
          hint="“auto” detects it from lib/main_*.dart."
        >
          <Input id="r-flavor" {...text('stagingFlavor')} />
        </Field>
        <Field label="App name (optional)" htmlFor="r-app" error={errs['flutter.appName']}>
          <Input id="r-app" {...text('appName')} />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="r-fvm">Use FVM</Label>
          <Switch id="r-fvm" checked={draft.useFvm} onCheckedChange={(v) => set('useFvm', v)} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="r-clean">Clean after upload</Label>
          <Switch
            id="r-clean"
            checked={draft.cleanAfterUpload}
            onCheckedChange={(v) => set('cleanAfterUpload', v)}
          />
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Drive & QA (staging builds only)</legend>
        <Field
          label="Drive folder id"
          htmlFor="r-drive"
          error={errs['drive.folderId']}
          hint="A Shared Drive folder the service account can add to."
          className="sm:col-span-2"
        >
          <Input id="r-drive" {...text('driveFolderId')} />
        </Field>
        <Field label="QA name" htmlFor="r-qan" error={errs['qa.name']}>
          <Input id="r-qan" {...text('qaName')} />
        </Field>
        <Field
          label="QA WhatsApp"
          htmlFor="r-qaw"
          error={errs['qa.whatsapp']}
          hint="Digits only, international format, no “+”."
        >
          <Input id="r-qaw" inputMode="numeric" {...text('qaWhatsapp')} />
        </Field>
        <Field
          label="Message template"
          htmlFor="r-qat"
          error={errs['qa.template']}
          hint="Placeholders: {qa} {repo} {version} {drive} {changes}"
          className="sm:col-span-2"
        >
          <Textarea id="r-qat" rows={4} {...text('qaTemplate')} />
        </Field>
      </fieldset>

      {save.error && !hasFieldErrors ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(save.error)}
        </p>
      ) : hasFieldErrors ? (
        <p role="alert" className="text-sm text-destructive">
          Fix the highlighted fields and try again.
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : mode === 'create' ? 'Add repository' : 'Save changes'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RepoDialog({
  open,
  onOpenChange,
  repo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: RepoConfigPublic | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {/* Mounted only while open, so the form state resets every time. */}
        <RepoForm repo={repo} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
