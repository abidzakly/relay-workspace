import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ExternalLink,
  GitPullRequestCreate,
  Layers,
  Loader2,
  SendHorizontal,
  ShieldAlert,
  Smartphone,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  MR_CHAT_MAX_HISTORY,
  MR_CHAT_MAX_MESSAGE,
  type AiGeneratedBy,
  type MrChatMessage,
  type MrCreatePreview,
  type MrCreateResult,
  type MrSummaryOutput,
} from '@relay/shared';
import { Badge } from '@/components/Badge';
import { GeneratedBy } from '@/components/GeneratedBy';
import { MicButton } from '@/components/MicButton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useApplyWrite, usePreviewWrite } from '@/lib/cardApi';
import { deckPath } from '@/lib/deckApi';
import { useCreateMr, useMrChat, useMrCreatePreview, useMrSummary } from '@/lib/mrCreateApi';
import { useSettings } from '@/lib/settingsApi';
import { useWorkspaces } from '@/lib/cockpitApi';
import { useIntegrity } from '@/lib/workflowApi';
import { safeHref } from '@/lib/utils';
import { useCoarsePointer } from '@/workspace/useMedia';
import { MrSteps } from '@/testBench/MrSteps';
import { PageTitle } from '@/components/PageTitle';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** Stack picture: this MR on top of its parents (parent at the bottom), merge one at a time. */
function StackPicture({ p }: { p: MrCreatePreview }) {
  if (p.parents.length === 0) return null;
  const rows = [
    { label: p.branch, iid: null as number | null, self: true },
    ...[...p.parents].reverse().map((x) => ({ label: x.branch, iid: x.iid, self: false })),
  ];
  return (
    <div className="grid gap-1.5 rounded-xl border border-dashed p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Layers className="size-3.5" /> Position in the stack (parent at the bottom, merge one at a
        time without squash)
      </p>
      <ol className="grid gap-1">
        {rows.map((r, i) => (
          <li key={r.label} className="flex min-w-0 items-center gap-2 text-sm">
            <Badge variant={r.self ? 'warning' : 'outline'}>#{rows.length - i}</Badge>
            <span className="truncate font-mono text-xs">{r.label}</span>
            {r.self ? (
              <span className="text-xs text-muted-foreground">This MR</span>
            ) : r.iid !== null ? (
              <span className="text-xs text-muted-foreground">!{r.iid} masih open</span>
            ) : (
              <span className="text-xs text-destructive">no MR yet</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SetCardComplete({ cardId }: { cardId: string }) {
  const preview = usePreviewWrite();
  const apply = useApplyWrite();
  const done = apply.isSuccess;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        disabled={preview.isPending || apply.isPending || done}
        onClick={() =>
          preview.mutate(
            { kind: 'status', cardId, to: 'Completed' },
            {
              onSuccess: (p) =>
                apply.mutate({
                  request: { kind: 'status', cardId, to: 'Completed' },
                  confirmToken: p.confirmToken,
                }),
            },
          )
        }
      >
        {(preview.isPending || apply.isPending) && (
          <Loader2 className="size-4 motion-safe:animate-spin" />
        )}
        {done && <Check aria-hidden />}
        {done ? `Card → ${apply.data?.after ?? 'Completed'}` : 'Set card to Completed'}
      </Button>
      {(preview.error || apply.error) && (
        <span className="text-xs text-destructive">
          {describeError(preview.error ?? apply.error)}
        </span>
      )}
    </div>
  );
}

function Created({ r, cardId }: { r: MrCreateResult; cardId: string | null }) {
  const href = safeHref(r.webUrl);
  return (
    <Alert variant={r.dryRun ? 'warning' : 'success'}>
      <AlertTitle>
        {r.dryRun
          ? 'Dry-run: MR simulated'
          : r.existed
            ? 'MR already exists'
            : `MR !${r.iid ?? '?'} created`}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>Audit #{r.auditId}.</span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            Open in GitLab <ExternalLink className="size-3" />
          </a>
        )}
        {r.notion?.outcome === 'updated' && (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="size-3.5" aria-hidden />
            Notion card set to {r.notion.status ?? 'Completed'}
          </span>
        )}
        {r.notion?.outcome === 'already_completed' && (
          <span className="text-sm text-muted-foreground">
            Notion card already {r.notion.status ?? 'Completed'}
          </span>
        )}
        {r.notion?.outcome === 'failed' && (
          <span className="text-xs text-destructive">
            Notion card was not updated. {r.notion.error}
          </span>
        )}
        {!r.dryRun &&
          cardId &&
          r.notion?.outcome !== 'updated' &&
          r.notion?.outcome !== 'already_completed' && <SetCardComplete cardId={cardId} />}
      </AlertDescription>
    </Alert>
  );
}

/** One-tap integrity gate: `flutter pub get && dart analyze lib/` in the repo's workspace. */
function IntegrityGate({ wsId, wsName }: { wsId: string; wsName: string }) {
  const check = useIntegrity(wsId);
  return (
    <section className="grid gap-2 rounded-surface border p-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Integrity gate</p>
        <span className="text-xs text-muted-foreground">workspace {wsName}</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
          {check.data ? 'Cek ulang' : 'Cek'}
        </Button>
      </div>
      {check.error && <p className="text-xs text-destructive">{describeError(check.error)}</p>}
      {check.data && (
        <ul className="grid gap-1.5">
          {check.data.steps.map((st) => (
            <li key={st.name}>
              <details className="rounded-lg bg-muted/40 px-3 py-2">
                <summary
                  className={`cursor-pointer text-sm ${st.ok ? 'text-success' : 'text-destructive'}`}
                >
                  {st.ok ? (
                    <Check aria-hidden className="mr-1 inline size-3.5" />
                  ) : (
                    <X aria-hidden className="mr-1 inline size-3.5" />
                  )}{' '}
                  <span className="font-mono text-xs">{st.name}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    {Math.round(st.durationMs / 1000)} s
                  </span>
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto font-mono text-2xs whitespace-pre-wrap">
                  {st.tail || '—'}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type ShownChatMessage = MrChatMessage & { generatedBy?: AiGeneratedBy };

/** Follow-up questions about the AI summary. Lives in this component only: gone on reload or a new summary. */
function SummaryChat({
  repo,
  branch,
  summary,
}: {
  repo: string;
  branch: string;
  summary: MrSummaryOutput;
}) {
  const chat = useMrChat();
  const touch = useCoarsePointer();
  const [messages, setMessages] = useState<ShownChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const asked = chat.isPending ? chat.variables.question : null;

  const send = () => {
    const question = draft.trim();
    if (!question || chat.isPending) return;
    setDraft('');
    chat.mutate(
      {
        repo,
        branch,
        summary,
        history: messages
          .slice(-MR_CHAT_MAX_HISTORY)
          .map((m) => ({ role: m.role, text: m.text.slice(0, MR_CHAT_MAX_MESSAGE) })),
        question,
      },
      {
        onSuccess: ({ answer, generatedBy }) =>
          setMessages((prev) => [
            ...prev,
            { role: 'user', text: question },
            { role: 'assistant', text: answer, generatedBy },
          ]),
        // Keep the question so it can be retried, unless something new was typed meanwhile.
        onError: () => setDraft((current) => current || question),
      },
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const shown: ShownChatMessage[] = asked ? [...messages, { role: 'user', text: asked }] : messages;

  return (
    <div className="grid gap-2 border-t pt-3">
      <p className="text-xs font-medium text-muted-foreground">Ask about this summary</p>
      {(shown.length > 0 || chat.isPending) && (
        <ul className="grid gap-2" aria-live="polite">
          {shown.map((m, i) => (
            <li
              key={i}
              className={
                m.role === 'user'
                  ? 'max-w-[85%] justify-self-end rounded-xl bg-primary/10 px-3 py-2 whitespace-pre-wrap'
                  : 'min-w-0 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]'
              }
            >
              {m.text}
              {m.generatedBy && <GeneratedBy by={m.generatedBy} className="mt-1" />}
            </li>
          ))}
          {chat.isPending && (
            <li className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 motion-safe:animate-spin" /> Thinking…
            </li>
          )}
        </ul>
      )}
      {chat.error && <p className="text-xs text-destructive">{describeError(chat.error)}</p>}
      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. Which change is the riskiest to merge?"
          aria-label="Question about the summary"
          maxLength={2000}
          rows={1}
          className="max-h-32 min-h-9 bg-background"
        />
        <MicButton onText={(t) => setDraft((prev) => (prev ? `${prev} ${t}` : t))} />
        <Button
          size="icon"
          aria-label="Send question"
          disabled={!draft.trim() || chat.isPending}
          onClick={send}
        >
          <SendHorizontal className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** `/mr-create/:repo?branch=`: confirmation screen of "Create MR". */
export function MrCreate() {
  const { repo = '' } = useParams();
  const [search] = useSearchParams();
  const { pathname, key: locationKey } = useLocation();
  const navigate = useNavigate();
  const branch = search.get('branch') ?? '';
  const q = useMrCreatePreview(repo, branch);
  const create = useCreateMr();
  const summary = useMrSummary();
  const settings = useSettings();
  const [skip, setSkip] = useState(false);
  const workspaces = useWorkspaces();
  const repoWs = (workspaces.data ?? []).find((w) => w.repoId === repo) ?? null;
  const [reason, setReason] = useState('');
  const [skipTest, setSkipTest] = useState(false);
  const [testReason, setTestReason] = useState('');

  if (!repo || !branch) {
    return <Alert variant="destructive">Invalid address.</Alert>;
  }
  // Opened directly (a notification, a new tab) there is no app page to return to.
  const back = (
    <button
      type="button"
      className="rv-icon-btn"
      aria-label="Back"
      onClick={() => void (locationKey === 'default' ? navigate('/overview') : navigate(-1))}
    >
      <ArrowLeft className="size-4" />
    </button>
  );
  if (q.isPending)
    return (
      <div className="mx-auto flex max-w-2xl items-center gap-2 p-4 text-sm text-muted-foreground">
        {back}
        <Loader2 className="size-4 motion-safe:animate-spin" /> Checking the branch in GitLab…
      </div>
    );
  if (q.error)
    return (
      <div className="mx-auto grid max-w-2xl gap-3 p-4">
        {back}
        <Alert variant="destructive">
          <AlertTitle>Could not prepare the MR</AlertTitle>
          <AlertDescription>{describeError(q.error)}</AlertDescription>
        </Alert>
      </div>
    );

  const p = q.data;
  const t = p.template;
  const dryRun = settings.data?.dryRun === true;
  const reviewOk = p.deckCompleted || (skip && reason.trim().length >= 3);
  const testOk = !p.testRequired || p.testOk || (skipTest && testReason.trim().length >= 3);
  const canCreate =
    !p.blocked &&
    p.existingMrIid === null &&
    reviewOk &&
    testOk &&
    !create.isPending &&
    !create.data;
  const deck = deckPath({ kind: 'compare', repoId: repo, from: t.targetBranch, to: branch });
  const bench = `/test-bench/${encodeURIComponent(repo)}?branch=${encodeURIComponent(branch)}`;
  const deckState = { from: `${pathname}?branch=${encodeURIComponent(branch)}`, popOnBack: true };

  return (
    <div className="mx-auto grid w-full max-w-2xl min-w-0 gap-4 p-1 sm:p-4">
      <header className="flex min-w-0 items-end gap-2">
        {back}
        <div className="min-w-0">
          <PageTitle>Create MR</PageTitle>
          <p className="truncate font-mono text-xs text-muted-foreground">{branch}</p>
        </div>
      </header>

      {p.existingMrIid === null && (
        <MrSteps
          steps={[
            ...(p.testRequired
              ? [
                  {
                    label: 'Test on device',
                    state: p.testOk ? ('done' as const) : ('current' as const),
                    to: bench,
                  },
                ]
              : []),
            {
              label: 'Review deck',
              state: p.deckCompleted
                ? ('done' as const)
                : !p.testRequired || p.testOk
                  ? ('current' as const)
                  : ('todo' as const),
              to: deck,
            },
            {
              label: 'Create MR',
              state:
                p.deckCompleted && (!p.testRequired || p.testOk)
                  ? ('current' as const)
                  : ('todo' as const),
            },
          ]}
        />
      )}

      {p.existingMrIid !== null && (
        <Alert>
          <AlertTitle>MR already exists: !{p.existingMrIid}</AlertTitle>
          <AlertDescription>
            <Link to={`/mrs/${repo}/${p.existingMrIid}`} className="underline">
              Open MR
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <section className="grid gap-2 rounded-surface border bg-card p-4">
        <Field label="From → into">
          <span className="font-mono text-xs">
            {t.sourceBranch} → {t.targetBranch}
          </span>
        </Field>
        <Field label="Title">
          <span className="font-mono text-xs">{t.title}</span>
        </Field>
        <Field label="Description">
          {t.description ? (
            <a
              href={safeHref(t.description) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs underline"
            >
              {t.description}
            </a>
          ) : (
            <span className="text-destructive">— (no Notion URL)</span>
          )}
        </Field>
        <Field label="Assignee">
          {t.assignee ? `@${t.assignee}` : <span className="text-destructive">not set</span>}
        </Field>
        <Field label="Reviewer">{t.reviewers.map((r) => `@${r}`).join(', ') || '—'}</Field>
        <Field label="Merge options">
          <span className="flex flex-wrap gap-1.5">
            <Badge variant="success">
              <Check aria-hidden />
              Delete source branch
            </Badge>
            <Badge variant="outline">
              <X aria-hidden />
              Squash
            </Badge>
            <Badge variant="outline">Not a draft</Badge>
          </span>
        </Field>
        <Field label="Commit">
          <Badge variant="outline">{p.commitCount}</Badge>
        </Field>
        {p.card && <Field label="Card">{p.card.title}</Field>}
      </section>

      {p.warnings.length > 0 && (
        <ul className="grid gap-1.5">
          {p.warnings.map((w) => (
            <li
              key={w.code}
              className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${
                w.code === 'parent_without_mr' || w.code === 'no_notion_url'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-warning/10 text-warning'
              }`}
            >
              {w.code === 'parent_without_mr' ? (
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              ) : (
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              )}
              {w.message}
            </li>
          ))}
        </ul>
      )}
      <StackPicture p={p} />

      {repoWs && <IntegrityGate wsId={repoWs.id} wsName={repoWs.name} />}

      {p.testRequired && (
        <section className="grid gap-2 rounded-surface border p-4">
          <p className="text-sm font-medium">Device test</p>
          {p.testOk ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" /> Tested on a device against every AC, on this
              commit.
            </p>
          ) : (
            <>
              {p.testStale && (
                <p className="text-sm text-warning">The branch moved after it was tested.</p>
              )}
              <Button asChild>
                <Link to={bench}>
                  <Smartphone className="size-4" />{' '}
                  {p.testStale ? 'Test the new commit' : 'Test on device first'}
                </Link>
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={skipTest}
                  onChange={(e) => setSkipTest(e.target.checked)}
                />
                Skip the device test with a reason (written to the audit log)
              </label>
              {skipTest && (
                <Textarea
                  value={testReason}
                  onChange={(e) => setTestReason(e.target.value)}
                  placeholder="Why is the device test skipped?"
                  className="min-h-16"
                  maxLength={500}
                />
              )}
            </>
          )}
        </section>
      )}

      <section className="grid gap-2 rounded-surface border p-4">
        <p className="text-sm font-medium">Review</p>
        {p.deckCompleted ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4" /> Review Deck finished for this diff.
          </p>
        ) : (
          <>
            {p.deckStale && (
              <p className="text-sm text-warning">
                New commits arrived after the deck was finished.
              </p>
            )}
            <Button asChild>
              <Link to={deck} state={deckState}>
                <Layers className="size-4" />{' '}
                {p.deckStale ? 'Review new changes' : 'Review first (deck)'}
              </Link>
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              Skip review with a reason (written to the audit log)
            </label>
            {skip && (
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is the review skipped?"
                className="min-h-16"
                maxLength={500}
              />
            )}
          </>
        )}
      </section>

      <section className="grid gap-2">
        <Button
          variant="ghost"
          className="justify-self-start"
          disabled={summary.isPending}
          onClick={() => summary.mutate({ repo, branch })}
        >
          {summary.isPending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          AI summary
        </Button>
        {summary.error && (
          <p className="text-xs text-destructive">{describeError(summary.error)}</p>
        )}
        {summary.data && (
          <div className="grid gap-2 rounded-xl bg-muted/50 p-3 text-sm">
            <p>{summary.data.summary}</p>
            <ul className="list-disc pl-5">
              {summary.data.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            {summary.data.risks.length > 0 && (
              <ul className="list-disc pl-5 text-warning">
                {summary.data.risks.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <GeneratedBy by={summary.data.generatedBy} />
            <SummaryChat
              key={JSON.stringify(summary.data)}
              repo={repo}
              branch={branch}
              summary={summary.data}
            />
          </div>
        )}
      </section>

      {dryRun && (
        <Alert variant="warning">
          <AlertTitle>Dry-run ON</AlertTitle>
          <AlertDescription>
            The MR is not really created, only written to the audit log.
          </AlertDescription>
        </Alert>
      )}
      <Button
        size="lg"
        className="h-12 rounded-surface"
        disabled={!canCreate}
        onClick={() =>
          create.mutate({
            repoId: repo,
            branch,
            ...(!p.deckCompleted && skip ? { skipReviewReason: reason.trim() } : {}),
            ...(p.testRequired && !p.testOk && skipTest
              ? { skipTestReason: testReason.trim() }
              : {}),
          })
        }
      >
        {create.isPending ? (
          <Loader2 className="size-4 motion-safe:animate-spin" />
        ) : (
          <GitPullRequestCreate className="size-4" />
        )}
        {dryRun ? 'Simulate MR' : 'Create MR'}
      </Button>
      {create.error && <p className="text-sm text-destructive">{describeError(create.error)}</p>}
      {create.data && <Created r={create.data} cardId={p.card?.id ?? null} />}
    </div>
  );
}
