import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { SECRET_MASK, type GitlabProjectOption, type RepoConfigPublic } from '@relay/shared';
import { ConnectionChecklist } from '@/components/ConnectionChecklist';
import { Field, errorMap } from '@/components/Field';
import { SecretInput } from '@/components/SecretInput';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ChoiceCard,
  StepDialog,
  SummaryRow,
  type WizardStep,
} from '@/components/wizard/StepDialog';
import { ApiError, describeError } from '@/lib/api';
import { usePickFlutter, usePickMe, type PickWho } from '@/lib/gitlabPickerApi';
import { useOAuthStatus } from '@/lib/oauthApi';
import { useReviewToken } from '@/lib/reviewsApi';
import {
  useRepos,
  useSaveRepo,
  useSettings,
  useTestDrive,
  useTestRepo,
  validateRepoBody,
} from '@/lib/settingsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { useSystem } from '@/lib/systemApi';
import { useRegisterWebhooks } from '@/lib/webhookApi';
import { splitList, useDraft } from '../drafts';
import { OAuthConnect } from '../OAuthConnect';
import {
  APPROVAL_MODES,
  emptyRepoDraft,
  NONE_DOMAIN,
  repoDraftToBody,
  repoToDraft,
  type RepoDraft,
} from '../repoDraft';
import { DriveFolderList } from '../googleParts';
import { ErrorAlert } from '../SectionCard';
import { Advanced, ExtLink, Steps, Ui } from '../SetupGuide';
import {
  cleanWhatsapp,
  isCloneUrl,
  isRepoId,
  parseDriveFolder,
  previewQaMessage,
  previewRelease,
  QA_PLACEHOLDERS,
  uniqueRepoId,
} from './derive';
import { BranchList, MemberList, ProjectList } from './pickers';

type StepKey = 'project' | 'clone' | 'people' | 'release' | 'build' | 'review';
type CloneKind = 'https' | 'ssh' | 'custom';

const LABEL: Record<StepKey, string> = {
  project: 'Project',
  clone: 'Branch & clone',
  people: 'People',
  release: 'Release',
  build: 'Build & QA',
  review: 'Review',
};
const ORDER: StepKey[] = ['project', 'clone', 'people', 'release', 'build', 'review'];

const PREFIXES = ['release/v', 'release/', 'v'];
const TAG_FORMATS = ['v{commitVersion}', '{commitVersion}'];

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
    return { options, synced, loaded: !!stateQ.data };
  }, [stateQ.data, reposQ.data, repoId, current]);
}

function cloneOf(p: GitlabProjectOption, kind: CloneKind): string | null {
  if (kind === 'https') return p.httpUrlToRepo;
  if (kind === 'ssh') return p.sshUrlToRepo ?? null;
  return null;
}

const H = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-sm font-semibold">{children}</h3>
);
const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
);

/**
 * Add or edit a repository as a walk through six steps. Nearly everything is picked from GitLab or worked out: the
 * project, its name and Relay id, the base branch, the clone URL, reviewers, the commit identity, the Flutter flavor.
 * What is left to type (a project token in Advanced mode, the QA contact) links to where it is found.
 */
export function RepoWizard({
  repo,
  onDone,
}: {
  /** undefined = create */
  repo: RepoConfigPublic | undefined;
  onDone: () => void;
}) {
  const mode = repo ? 'edit' : 'create';
  const repoDefaults = useSystem().data?.repoDefaults;
  const { draft, set } = useDraft<RepoDraft>(
    repo ? repoToDraft(repo) : emptyRepoDraft(repoDefaults),
  );
  const repos = useRepos();
  const settings = useSettings().data;
  const signedIn = !!useOAuthStatus().data?.gitlab.connected;
  const reviewerTokenSet = !!useReviewToken().data?.tokenSet;
  const host = settings?.gitlab.host?.replace(/\/+$/, '');
  const advanced = settings?.gitlab.authMode === 'token';
  const driveAdvanced = settings?.google.authMode === 'token';

  const [at, setAt] = useState(0);
  const [project, setProject] = useState<GitlabProjectOption | null>(null);
  const [kindPicked, setCloneKind] = useState<CloneKind>(repo ? 'custom' : 'https');
  // Without a picked project there is no URL to offer: the URL is typed.
  const cloneKind: CloneKind = project ? kindPicked : 'custom';
  const [editId, setEditId] = useState(false);
  const [driveMode, setDriveMode] = useState<'auto' | 'existing'>(
    repo?.drive.folderId ? 'existing' : 'auto',
  );
  const [driveInput, setDriveInput] = useState(repo?.drive.folderId ?? '');
  const [saved, setSaved] = useState<RepoConfigPublic | null>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const save = useSaveRepo();
  const serverErrors = errorMap(save.error instanceof ApiError ? save.error.issues : []);
  const errs = { ...serverErrors, ...clientErrors };

  const typedToken = draft.token.trim() !== '' && draft.token !== SECRET_MASK;
  // Which token reads GitLab for the pickers.
  const who: PickWho = advanced
    ? typedToken
      ? { token: draft.token.trim() }
      : repo
        ? { repoId: repo.id }
        : {}
    : {};
  const canRead = !!host && (advanced ? typedToken || !!repo || reviewerTokenSet : signedIn);
  const projectId = /^\d+$/.test(draft.projectId.trim()) ? Number(draft.projectId) : undefined;

  const me = usePickMe(who, canRead);
  const flutter = usePickFlutter(who, canRead ? projectId : undefined, draft.baseBranch.trim());
  const domainOptions = useDomainOptions(repo?.id, draft.productDomain);
  const reviewers = splitList(draft.reviewers);
  const driveId = driveMode === 'auto' ? '' : (parseDriveFolder(driveInput) ?? '');

  // A new repo commits as the person by default.
  const identityFilled = useRef(false);
  useEffect(() => {
    if (repo || identityFilled.current || !me.data) return;
    identityFilled.current = true;
    if (!draft.identityName && !draft.identityEmail && me.data.name && me.data.email) {
      set('identityName', me.data.name);
      set('identityEmail', me.data.email);
    }
  }, [me.data, repo, draft.identityName, draft.identityEmail, set]);

  const takenIds = (repos.data ?? []).map((r) => r.id);

  const pickProject = (p: GitlabProjectOption) => {
    const prev = project;
    setProject(p);
    set('projectId', String(p.id));
    if (!draft.name.trim() || (prev && draft.name === prev.name)) set('name', p.name);
    if (!repo && !editId) {
      set('id', uniqueRepoId(p.path ?? p.pathWithNamespace, takenIds));
    }
    if (p.defaultBranch && (!repo || !draft.baseBranch.trim())) set('baseBranch', p.defaultBranch);
    const kind = kindPicked === 'custom' && !repo ? 'https' : kindPicked;
    const url = cloneOf(p, kind === 'custom' ? 'https' : kind);
    if (url && (kind !== 'custom' || !draft.cloneUrl.trim())) {
      setCloneKind(kind === 'custom' ? 'https' : kind);
      set('cloneUrl', url);
    }
  };

  const chooseClone = (k: CloneKind) => {
    setCloneKind(k);
    const url = project ? cloneOf(project, k) : null;
    if (url) set('cloneUrl', url);
  };

  const toggleReviewer = (u: string) =>
    set(
      'reviewers',
      (reviewers.includes(u) ? reviewers.filter((x) => x !== u) : [...reviewers, u]).join(', '),
    );

  const identityHalf = (draft.identityName.trim() === '') !== (draft.identityEmail.trim() === '');
  const whatsappOk = draft.qaWhatsapp === '' || /^\d{6,15}$/.test(draft.qaWhatsapp);
  const tokenMissing = mode === 'create' && advanced && !typedToken;
  // Connect mode: a new repo uses the sign-in, so it has to be there.
  const signInMissing = mode === 'create' && !advanced && !signedIn;

  // No Product Domain synced yet: None is the only real answer, so take it.
  useEffect(() => {
    if (!repo && draft.productDomain === '' && domainOptions.loaded && !domainOptions.synced) {
      set('productDomain', NONE_DOMAIN);
    }
  }, [repo, draft.productDomain, domainOptions.loaded, domainOptions.synced, set]);

  const steps: WizardStep<StepKey>[] = [
    {
      key: 'project',
      label: LABEL.project,
      done:
        !!projectId &&
        draft.name.trim() !== '' &&
        isRepoId(draft.id) &&
        !tokenMissing &&
        !signInMissing,
    },
    {
      key: 'clone',
      label: LABEL.clone,
      done: draft.baseBranch.trim() !== '' && isCloneUrl(draft.cloneUrl),
    },
    {
      key: 'people',
      label: LABEL.people,
      done: reviewers.length > 0 && draft.productDomain !== '',
    },
    {
      key: 'release',
      label: LABEL.release,
      done:
        !identityHalf &&
        draft.versionBranchPrefix.trim() !== '' &&
        draft.tagFormat.includes('{commitVersion}'),
    },
    {
      key: 'build',
      label: LABEL.build,
      done: (driveMode === 'auto' || driveId !== '') && whatsappOk,
    },
    { key: 'review', label: LABEL.review, done: true },
  ];
  const step = ORDER[at]!;
  const goTo = (k: StepKey) => setAt(ORDER.indexOf(k));

  function submit() {
    setClientErrors({});
    const body = repoDraftToBody({ ...draft, driveFolderId: driveId });
    const invalid = validateRepoBody(body);
    const found = errorMap(invalid?.issues ?? []);
    if (draft.productDomain === '') found['productDomains'] = 'Choose a Product Domain, or None';
    if (tokenMissing) found['gitlab.token'] = 'A project access token is required in Advanced mode';
    if (identityHalf) found['commitIdentity.name'] = 'Set both name and email, or neither';
    if (Object.keys(found).length > 0) {
      setClientErrors(found);
      return;
    }
    save.mutate(
      { mode, id: body.id, body },
      { onSuccess: (r) => (mode === 'create' ? setSaved(r) : onDone()) },
    );
  }

  if (saved) return <AfterSave repo={saved} onDone={onDone} />;

  const errorKeys = Object.keys(errs);
  const status =
    save.error && errorKeys.length === 0 ? (
      <span role="alert" className="text-destructive">
        {describeError(save.error)}
      </span>
    ) : errorKeys.length > 0 ? (
      <span role="alert" className="text-destructive">
        {Object.values(errs)[0]} ({errorKeys[0]})
      </span>
    ) : null;

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>
          {mode === 'create' ? 'Add repository' : `Edit ${repo?.name ?? ''}`}
        </DialogTitle>
        <DialogDescription>
          {mode === 'create'
            ? 'Pick the project in GitLab; Relay fills in the rest. Every choice can be changed later.'
            : 'Jump to any step, change what you need, and save.'}
        </DialogDescription>
      </DialogHeader>

      <StepDialog
        steps={steps}
        at={at}
        onAt={setAt}
        free={mode === 'edit'}
        status={status}
        finish={
          <Button type="button" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : mode === 'create' ? 'Add repository' : 'Save changes'}
          </Button>
        }
      >
        {step === 'project' ? (
          <>
            {!host ? (
              <p className="rounded-control border border-hairline px-4 py-3 text-sm">
                Set the GitLab host first, under{' '}
                <Link to="/settings#gitlab" onClick={onDone} className="underline">
                  Settings &gt; GitLab
                </Link>
                .
              </p>
            ) : !advanced && !signedIn ? (
              <OAuthConnect
                provider="gitlab"
                gitlabHost={host}
                what="Sign in once: Relay then lists your projects here, and this repo uses the sign-in for git and merge requests."
              />
            ) : null}

            {advanced ? (
              <div className="grid gap-2">
                <H>Project access token</H>
                <Steps>
                  <li>
                    Open the project in GitLab
                    {project?.webUrl ? (
                      <>
                        {' '}
                        (
                        <ExtLink href={`${project.webUrl}/-/settings/access_tokens`}>
                          its Access tokens page
                        </ExtLink>
                        )
                      </>
                    ) : host ? (
                      <>
                        {' '}
                        (<ExtLink href={`${host}/dashboard/projects`}>your projects</ExtLink>)
                      </>
                    ) : null}
                    , then <Ui>Settings &gt; Access tokens</Ui> &gt; <Ui>Add new token</Ui>.
                  </li>
                  <li>
                    Role <Ui>Maintainer</Ui>, scope <code>api</code>. Copy the token and paste it
                    here: Relay then finds its project.
                  </li>
                </Steps>
                <SecretInput
                  id="rw-token"
                  aria-label="Project access token"
                  value={draft.token}
                  onChange={(v) => set('token', v)}
                  placeholder="glpat-…"
                />
                {errs['gitlab.token'] ? (
                  <p className="text-xs text-destructive">{errs['gitlab.token']}</p>
                ) : mode === 'edit' ? (
                  <Note>Stored encrypted. Type to replace it; leave as is to keep it.</Note>
                ) : null}
              </div>
            ) : null}

            {canRead ? (
              <div className="grid gap-2">
                <H>Which project?</H>
                <ProjectList
                  who={who}
                  enabled={canRead}
                  selectedId={project?.id ?? projectId}
                  onPick={pickProject}
                />
              </div>
            ) : null}

            {projectId ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Name"
                  htmlFor="rw-name"
                  error={errs['name']}
                  hint="How Relay shows it."
                >
                  <Input
                    id="rw-name"
                    value={draft.name}
                    onChange={(e) => {
                      set('name', e.target.value);
                      // Typed by hand (no project picked): the id follows the name.
                      if (!repo && !editId && !project && e.target.value.trim()) {
                        set('id', uniqueRepoId(e.target.value, takenIds));
                      }
                    }}
                  />
                </Field>
                <Field
                  label="Relay id"
                  htmlFor="rw-id"
                  error={errs['id']}
                  hint={
                    mode === 'edit'
                      ? 'Fixed: it is in the webhook URL and the clone path.'
                      : `Made for you. Webhook: /webhook/${draft.id || '…'}`
                  }
                >
                  {editId && mode === 'create' ? (
                    <Input
                      id="rw-id"
                      value={draft.id}
                      autoComplete="off"
                      onChange={(e) => set('id', e.target.value.toLowerCase())}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-control border border-hairline px-2.5 py-2 font-mono text-xs">
                        {draft.id || '…'}
                      </code>
                      {mode === 'create' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditId(true)}
                        >
                          Change
                        </Button>
                      ) : null}
                    </div>
                  )}
                </Field>
              </div>
            ) : null}

            <Advanced summary="Enter the project id by hand" open={!canRead && !!host}>
              <Field
                label="Project id"
                htmlFor="rw-pid"
                error={errs['gitlab.projectId']}
                hint="On the project's overview page in GitLab, under its name."
              >
                <Input
                  id="rw-pid"
                  inputMode="numeric"
                  value={draft.projectId}
                  onChange={(e) => {
                    const pid = e.target.value.replace(/\D+/g, '');
                    set('projectId', pid);
                    if (!repo && !editId && !project && !draft.name.trim() && pid) {
                      set('id', uniqueRepoId(`repo-${pid}`, takenIds));
                    }
                  }}
                />
              </Field>
            </Advanced>
          </>
        ) : null}

        {step === 'clone' ? (
          <>
            <div className="grid gap-2">
              <H>Base branch</H>
              <Note>Where merge requests go and releases are cut from.</Note>
              {canRead && projectId ? (
                <BranchList
                  who={who}
                  projectId={projectId}
                  value={draft.baseBranch}
                  onPick={(b) => set('baseBranch', b)}
                />
              ) : (
                <Input
                  aria-label="Base branch"
                  value={draft.baseBranch}
                  onChange={(e) => set('baseBranch', e.target.value)}
                />
              )}
              {errs['baseBranch'] ? (
                <p className="text-xs text-destructive">{errs['baseBranch']}</p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <H>How Relay clones it</H>
              <div role="radiogroup" aria-label="Clone URL" className="grid gap-2 sm:grid-cols-3">
                <ChoiceCard
                  selected={cloneKind === 'https'}
                  onSelect={() => chooseClone('https')}
                  disabled={!project}
                  title="HTTPS"
                  badge={<span className="text-2xs text-muted-foreground">recommended</span>}
                  detail={
                    advanced
                      ? 'Uses the project token.'
                      : 'Uses your GitLab sign-in. Nothing to set up.'
                  }
                />
                <ChoiceCard
                  selected={cloneKind === 'ssh'}
                  onSelect={() => chooseClone('ssh')}
                  disabled={!project?.sshUrlToRepo}
                  title="SSH"
                  detail="Needs an SSH key on this machine, added to GitLab."
                />
                <ChoiceCard
                  selected={cloneKind === 'custom'}
                  onSelect={() => setCloneKind('custom')}
                  title="Other"
                  detail="A mirror, file:// or a path."
                />
              </div>
              {cloneKind === 'custom' ? (
                <Input
                  aria-label="Clone URL"
                  value={draft.cloneUrl}
                  onChange={(e) => set('cloneUrl', e.target.value)}
                  placeholder="git@gitlab.example.com:team/app.git"
                />
              ) : (
                <code className="truncate rounded-control border border-hairline px-2.5 py-2 font-mono text-xs">
                  {draft.cloneUrl || 'Pick the project first.'}
                </code>
              )}
              {errs['cloneUrl'] ? (
                <p className="text-xs text-destructive">{errs['cloneUrl']}</p>
              ) : cloneKind === 'ssh' && host ? (
                <Note>
                  No key yet?{' '}
                  <ExtLink href={`${host}/-/user_settings/ssh_keys`}>Add one in GitLab</ExtLink>.
                </Note>
              ) : null}
            </div>

            <Advanced summary="Clone details">
              <Field
                label="Local path (optional)"
                htmlFor="rw-path"
                error={errs['localPath']}
                hint="Empty = Relay keeps its own clone. Or point at an existing clone."
              >
                <Input
                  id="rw-path"
                  value={draft.localPath}
                  onChange={(e) => set('localPath', e.target.value)}
                />
              </Field>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="rw-partial">Partial clone (faster, smaller)</Label>
                <Switch
                  id="rw-partial"
                  checked={draft.partialClone}
                  onCheckedChange={(v) => set('partialClone', v)}
                />
              </div>
            </Advanced>
          </>
        ) : null}

        {step === 'people' ? (
          <>
            <div className="grid gap-2">
              <H>Reviewers (merge gate)</H>
              <Note>An approval by any one of them is needed to merge. Pick at least one.</Note>
              {canRead && projectId ? (
                <MemberList
                  who={who}
                  projectId={projectId}
                  selected={reviewers}
                  onToggle={toggleReviewer}
                  multi
                />
              ) : null}
              <Field
                label="Reviewers by username"
                htmlFor="rw-rev"
                error={errs['reviewers']}
                hint={
                  canRead && projectId
                    ? 'Filled by the list above. Type here only for someone not in it.'
                    : 'Comma-separated GitLab usernames.'
                }
              >
                <Input
                  id="rw-rev"
                  value={draft.reviewers}
                  onChange={(e) => set('reviewers', e.target.value)}
                  placeholder="alice, bob"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Notion Product Domain"
                htmlFor="rw-domains"
                error={errs['productDomains']}
                hint={
                  domainOptions.synced
                    ? 'Cards with this Product Domain belong to this repo.'
                    : 'None found yet: Notion has not synced cards with one. Choose None for now.'
                }
              >
                <Select
                  id="rw-domains"
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
                label="Version-MR assignee"
                htmlFor="rw-assignee"
                error={errs['assignee']}
                hint="Who release merge requests are assigned to."
              >
                <Select
                  id="rw-assignee"
                  value={draft.assignee}
                  onChange={(e) => set('assignee', e.target.value)}
                >
                  <option value="">
                    Me{me.data ? ` (@${me.data.username})` : ''}, the default
                  </option>
                  {reviewers.map((u) => (
                    <option key={u} value={u}>
                      @{u}
                    </option>
                  ))}
                  {draft.assignee && !reviewers.includes(draft.assignee) ? (
                    <option value={draft.assignee}>@{draft.assignee}</option>
                  ) : null}
                </Select>
              </Field>
            </div>

            <Advanced summary="Approvals">
              <Field
                label="Approval mode"
                htmlFor="rw-appr"
                error={errs['approvalMode']}
                hint="Use a fallback only if your GitLab tier has no Approvals API."
              >
                <Select
                  id="rw-appr"
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
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="rw-vmr-gate">Version MRs also need reviewer approval</Label>
                <Switch
                  id="rw-vmr-gate"
                  checked={draft.requireVersionMrApproval}
                  onCheckedChange={(v) => set('requireVersionMrApproval', v)}
                />
              </div>
            </Advanced>
          </>
        ) : null}

        {step === 'release' ? (
          <ReleaseStep
            draft={draft}
            set={set}
            errs={errs}
            me={me.data ?? null}
            meLoading={me.isFetching}
          />
        ) : null}

        {step === 'build' ? (
          <>
            <div className="grid gap-3">
              <H>Flutter build</H>
              {flutter.data && !flutter.data.isFlutter ? (
                <Note>
                  No pubspec.yaml on <code>{draft.baseBranch}</code>: this is not a Flutter app, so
                  these only matter if it becomes one.
                </Note>
              ) : null}
              <div
                role="radiogroup"
                aria-label="Staging flavor"
                className="grid gap-2 sm:grid-cols-3"
              >
                <ChoiceCard
                  selected={draft.stagingFlavor === 'auto'}
                  onSelect={() => set('stagingFlavor', 'auto')}
                  title="Detect it"
                  detail="From lib/main_*.dart at build time."
                />
                {(flutter.data?.flavors ?? []).map((f) => (
                  <ChoiceCard
                    key={f}
                    selected={draft.stagingFlavor === f}
                    onSelect={() => set('stagingFlavor', f)}
                    title={f}
                    detail={`lib/main_${f}.dart`}
                  />
                ))}
                {draft.stagingFlavor !== 'auto' &&
                !(flutter.data?.flavors ?? []).includes(draft.stagingFlavor) ? (
                  <ChoiceCard
                    selected
                    onSelect={() => undefined}
                    title={draft.stagingFlavor}
                    detail="Saved before"
                  />
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="App name (optional)"
                  htmlFor="rw-app"
                  error={errs['flutter.appName']}
                  hint={
                    flutter.data?.appName && draft.appName !== flutter.data.appName ? (
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => set('appName', flutter.data?.appName ?? '')}
                      >
                        Use “{flutter.data.appName}” from pubspec.yaml
                      </button>
                    ) : (
                      'Used in the build file name.'
                    )
                  }
                >
                  <Input
                    id="rw-app"
                    value={draft.appName}
                    onChange={(e) => set('appName', e.target.value)}
                  />
                </Field>
                <div className="grid content-end gap-3">
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor="rw-fvm">Use FVM</Label>
                    <Switch
                      id="rw-fvm"
                      checked={draft.useFvm}
                      onCheckedChange={(v) => set('useFvm', v)}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor="rw-clean">Clean after upload</Label>
                    <Switch
                      id="rw-clean"
                      checked={draft.cleanAfterUpload}
                      onCheckedChange={(v) => set('cleanAfterUpload', v)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <DriveChoice
              mode={driveMode}
              onMode={setDriveMode}
              input={driveInput}
              onInput={setDriveInput}
              folderId={driveId}
              repoName={draft.name}
              serviceAccount={driveAdvanced}
              error={errs['drive.folderId']}
            />

            <QaPart draft={draft} set={set} errs={errs} />
          </>
        ) : null}

        {step === 'review' ? (
          <div className="grid">
            <SummaryRow
              label="Project"
              value={
                <>
                  {draft.name}{' '}
                  <span className="text-muted-foreground">
                    ({project?.pathWithNamespace ?? `#${draft.projectId}`}, id {draft.id})
                  </span>
                </>
              }
              onEdit={() => goTo('project')}
            />
            <SummaryRow
              label="Base branch"
              value={<code className="font-mono text-xs">{draft.baseBranch}</code>}
              onEdit={() => goTo('clone')}
            />
            <SummaryRow
              label="Clone URL"
              value={<code className="font-mono text-xs break-all">{draft.cloneUrl}</code>}
              onEdit={() => goTo('clone')}
            />
            <SummaryRow
              label="Reviewers"
              value={reviewers.map((r) => `@${r}`).join(', ') || '—'}
              onEdit={() => goTo('people')}
            />
            <SummaryRow
              label="Product Domain"
              value={draft.productDomain === NONE_DOMAIN ? 'None' : draft.productDomain || '—'}
              onEdit={() => goTo('people')}
            />
            <SummaryRow
              label="Commits as"
              value={
                draft.identityName
                  ? `${draft.identityName} <${draft.identityEmail}>`
                  : 'Not set (needed to release with the node engine)'
              }
              onEdit={() => goTo('release')}
            />
            <SummaryRow
              label="Releases"
              value={(() => {
                const p = previewRelease(draft.versionBranchPrefix, draft.tagFormat);
                return `${p.branch}, tag ${p.tag}`;
              })()}
              onEdit={() => goTo('release')}
            />
            <SummaryRow
              label="Drive"
              value={driveMode === 'auto' ? `Relay makes “Relay builds · ${draft.name}”` : driveId}
              onEdit={() => goTo('build')}
            />
            <SummaryRow
              label="QA"
              value={
                draft.qaName || draft.qaWhatsapp
                  ? `${draft.qaName || 'QA'}${draft.qaWhatsapp ? `, +${draft.qaWhatsapp}` : ''}`
                  : 'Nobody is messaged'
              }
              onEdit={() => goTo('build')}
            />
          </div>
        ) : null}
      </StepDialog>
    </div>
  );
}

type SetDraft = <K extends keyof RepoDraft>(k: K, v: RepoDraft[K]) => void;

function ReleaseStep({
  draft,
  set,
  errs,
  me,
  meLoading,
}: {
  draft: RepoDraft;
  set: SetDraft;
  errs: Record<string, string>;
  me: { username: string; name: string | null; email: string | null } | null;
  meLoading: boolean;
}) {
  const preview = previewRelease(draft.versionBranchPrefix, draft.tagFormat);
  const mine = me?.name && me.email;
  const usingMine = mine && draft.identityName === me.name && draft.identityEmail === me.email;
  return (
    <>
      <div className="grid gap-2">
        <H>Commit identity</H>
        <Note>The name and email on release commits (needed by the node release engine).</Note>
        {mine ? (
          <ChoiceCard
            selected={!!usingMine}
            onSelect={() => {
              set('identityName', me.name ?? '');
              set('identityEmail', me.email ?? '');
            }}
            title={`${me.name} <${me.email}>`}
            detail="Your GitLab identity"
          />
        ) : meLoading ? (
          <Note>Reading your GitLab profile…</Note>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="rw-idn" error={errs['commitIdentity.name']}>
            <Input
              id="rw-idn"
              value={draft.identityName}
              onChange={(e) => set('identityName', e.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="rw-ide" error={errs['commitIdentity.email']}>
            <Input
              id="rw-ide"
              type="email"
              value={draft.identityEmail}
              onChange={(e) => set('identityEmail', e.target.value)}
            />
          </Field>
        </div>
      </div>

      <div className="grid gap-2">
        <H>Release names</H>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Version branch prefix" htmlFor="rw-vbp" error={errs['versionBranchPrefix']}>
            <Presets
              options={PREFIXES}
              value={draft.versionBranchPrefix}
              onPick={(v) => set('versionBranchPrefix', v)}
            />
            <Input
              id="rw-vbp"
              value={draft.versionBranchPrefix}
              onChange={(e) => set('versionBranchPrefix', e.target.value)}
            />
          </Field>
          <Field
            label="Tag format"
            htmlFor="rw-tag"
            error={errs['tagFormat']}
            hint="Must contain {commitVersion}."
          >
            <Presets
              options={TAG_FORMATS}
              value={draft.tagFormat}
              onPick={(v) => set('tagFormat', v)}
            />
            <Input
              id="rw-tag"
              value={draft.tagFormat}
              onChange={(e) => set('tagFormat', e.target.value)}
            />
          </Field>
        </div>
        <Note>
          Version 1.4.0 makes branch <code>{preview.branch}</code> and tag{' '}
          <code>{preview.tag}</code>.
        </Note>
      </div>
    </>
  );
}

function Presets({
  options,
  value,
  onPick,
}: {
  options: string[];
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          onClick={() => onPick(o)}
          className={
            o === value
              ? 'rounded-full border border-foreground bg-foreground px-2.5 py-0.5 font-mono text-2xs text-background'
              : 'rounded-full border border-hairline px-2.5 py-0.5 font-mono text-2xs text-muted-foreground hover:text-foreground'
          }
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function DriveChoice({
  mode,
  onMode,
  input,
  onInput,
  folderId,
  repoName,
  serviceAccount,
  error,
}: {
  mode: 'auto' | 'existing';
  onMode: (m: 'auto' | 'existing') => void;
  input: string;
  onInput: (v: string) => void;
  folderId: string;
  repoName: string;
  serviceAccount: boolean;
  error: string | undefined;
}) {
  const test = useTestDrive();
  const bad = mode === 'existing' && input.trim() !== '' && !folderId;
  return (
    <div className="grid gap-2">
      <H>Drive folder for staging builds</H>
      <div role="radiogroup" aria-label="Drive folder" className="grid gap-2 sm:grid-cols-2">
        <ChoiceCard
          selected={mode === 'auto'}
          onSelect={() => onMode('auto')}
          title="Relay makes one"
          badge={<span className="text-2xs text-muted-foreground">recommended</span>}
          detail={`“Relay builds · ${repoName || 'this repo'}”, on the first upload.`}
        />
        <ChoiceCard
          selected={mode === 'existing'}
          onSelect={() => onMode('existing')}
          title="Use a folder I have"
          detail="Paste its link from Drive."
        />
      </div>
      {mode === 'existing' ? (
        <div className="grid gap-2">
          {serviceAccount ? <DriveFolderList value={folderId} onPick={onInput} /> : null}
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Drive folder link"
              className="min-w-0 flex-1"
              value={input}
              onChange={(e) => onInput(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/…"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!folderId || test.isPending}
              onClick={() => test.mutate(folderId)}
            >
              {test.isPending ? 'Testing…' : 'Test folder'}
            </Button>
          </div>
          {error || bad ? (
            <p className="text-xs text-destructive">
              {error ??
                'That is not a Drive folder link. Open the folder in Drive and copy the address bar.'}
            </p>
          ) : (
            <Note>
              Open the folder in{' '}
              <ExtLink href="https://drive.google.com/drive/my-drive">Drive</ExtLink> and copy the
              address bar.{' '}
              {serviceAccount
                ? 'Share it with the service account as Editor.'
                : 'With the Google sign-in, Relay can only add to folders it made: an existing folder needs Advanced mode (a service account shared on it).'}
              {folderId ? (
                <>
                  {' '}
                  Folder id <code>{folderId}</code>.
                </>
              ) : null}
            </Note>
          )}
          {test.error ? <ErrorAlert error={test.error} /> : null}
          {test.data ? <ConnectionChecklist result={test.data} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function QaPart({
  draft,
  set,
  errs,
}: {
  draft: RepoDraft;
  set: SetDraft;
  errs: Record<string, string>;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (ph: string) => {
    const el = area.current;
    const token = `{${ph}}`;
    if (!el) return set('qaTemplate', draft.qaTemplate + token);
    const { selectionStart: a, selectionEnd: b } = el;
    set('qaTemplate', draft.qaTemplate.slice(0, a) + token + draft.qaTemplate.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };
  const wa = draft.qaWhatsapp;
  return (
    <div className="grid gap-3">
      <H>Tell QA (optional)</H>
      <Note>After a staging build, Relay opens a WhatsApp message to QA with the Drive link.</Note>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="QA name" htmlFor="rw-qan" error={errs['qa.name']}>
          <Input id="rw-qan" value={draft.qaName} onChange={(e) => set('qaName', e.target.value)} />
        </Field>
        <Field
          label="QA WhatsApp"
          htmlFor="rw-qaw"
          error={errs['qa.whatsapp']}
          hint={
            wa && /^\d{6,15}$/.test(wa) ? (
              <ExtLink href={`https://wa.me/${wa}`}>Check the number in WhatsApp</ExtLink>
            ) : wa.startsWith('0') ? (
              'Use the country code instead of the leading 0 (62… for Indonesia).'
            ) : (
              'With the country code, e.g. +62 812 3456 7890.'
            )
          }
        >
          <Input
            id="rw-qaw"
            inputMode="tel"
            value={wa}
            onChange={(e) => set('qaWhatsapp', cleanWhatsapp(e.target.value))}
            placeholder="+62 812 3456 7890"
          />
        </Field>
      </div>
      <Field label="Message" htmlFor="rw-qat" error={errs['qa.template']}>
        <div className="flex flex-wrap gap-1.5">
          {QA_PLACEHOLDERS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => insert(p)}
              className="rounded-full border border-hairline px-2 py-0.5 font-mono text-2xs text-muted-foreground hover:text-foreground"
            >
              + {`{${p}}`}
            </button>
          ))}
        </div>
        <Textarea
          id="rw-qat"
          ref={area}
          rows={4}
          value={draft.qaTemplate}
          onChange={(e) => set('qaTemplate', e.target.value)}
        />
      </Field>
      <pre className="rounded-control border border-dashed border-hairline px-3 py-2 font-sans text-xs whitespace-pre-wrap text-muted-foreground">
        {previewQaMessage(draft.qaTemplate, draft.name, draft.qaName)}
      </pre>
    </div>
  );
}

/** After Add: hook the repo up to GitLab and check it, without leaving the dialog. */
function AfterSave({ repo, onDone }: { repo: RepoConfigPublic; onDone: () => void }) {
  const settings = useSettings().data;
  const register = useRegisterWebhooks();
  const test = useTestRepo();
  const reg = register.data?.[0];
  const publicUrl = settings?.publicBaseUrl;
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{repo.name} is added</DialogTitle>
        <DialogDescription>
          Two last clicks: let GitLab tell Relay about merge requests, then check everything.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 rounded-control border border-hairline p-4">
        <H>1. Register the webhook</H>
        {publicUrl ? (
          <Note>
            Relay creates the hook in GitLab with its secret, pointing at{' '}
            <code>
              {publicUrl.replace(/\/+$/, '')}/webhook/{repo.id}
            </code>
            .
          </Note>
        ) : (
          <Note>
            Set the public URL first under{' '}
            <Link to="/settings#gitlab" onClick={onDone} className="underline">
              Settings &gt; GitLab
            </Link>
            : GitLab needs an address it can reach.
          </Note>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!publicUrl || register.isPending}
            onClick={() => register.mutate(repo.id)}
          >
            {register.isPending ? 'Registering…' : 'Register webhook'}
          </Button>
          {reg ? (
            <span className={reg.error ? 'text-sm text-destructive' : 'text-sm text-success'}>
              {reg.error
                ? reg.error.message
                : `${reg.dryRun ? 'Dry run: would be ' : ''}${reg.outcome.replace(/_/g, ' ')}.`}
            </span>
          ) : null}
        </div>
        <ErrorAlert error={register.error} />
      </div>
      <div className="grid gap-3 rounded-control border border-hairline p-4">
        <H>2. Test the connection</H>
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={test.isPending}
            onClick={() => test.mutate(repo.id)}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        <ErrorAlert error={test.error} />
        {test.data ? <ConnectionChecklist result={test.data} /> : null}
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
