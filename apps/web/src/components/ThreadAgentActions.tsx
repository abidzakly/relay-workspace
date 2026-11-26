import {
  Bot,
  Check,
  ChevronUp,
  Copy,
  Loader2,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  AGENT_MODEL_CHOICES,
  agentModelLabel,
  MR_CHAT_MAX_HISTORY,
  MR_CHAT_MAX_MESSAGE,
  type AiGeneratedBy,
  type ExplainThreadResult,
  type MrChatMessage,
} from '@relay/shared';
import { describeError } from '@/lib/api';
import { sessionHref, sessionStateLabel, useMrSessions } from '@/lib/mrSessions';
import { useSettings } from '@/lib/settingsApi';
import {
  useThreadAgent,
  useThreadChat,
  useThreadExplain,
  type ThreadAgentMode,
} from '@/lib/workflowApi';
import { Badge } from '@/components/Badge';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const VERDICT: Record<
  ExplainThreadResult['verdict'],
  { label: string; variant: 'success' | 'warning' | 'secondary' | 'outline' }
> = {
  valid: { label: 'Reviewer is right', variant: 'warning' },
  partly: { label: 'Partly right', variant: 'warning' },
  addressed: { label: 'Already addressed', variant: 'success' },
  mismatch: { label: "Doesn't match the changes", variant: 'secondary' },
  unclear: { label: 'Not enough evidence', variant: 'outline' },
};

type ChatTurn =
  { role: 'user'; text: string } | { role: 'assistant'; text: string; generatedBy: AiGeneratedBy };

/** The verdict card as plain text, so a follow-up (and the agent) knows what was said first. */
function explanationText(r: ExplainThreadResult): string {
  return [
    `Verdict: ${VERDICT[r.verdict].label}.`,
    r.summary,
    r.whatChanged ? `What the MR changed: ${r.whatChanged}` : '',
    `Suggested reply to the reviewer: ${r.suggestedReply}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * "Ask AI" on a reviewer's thread (Code Review and MR Detail). One button opens a panel: the AI first checks the
 * comment against the MR's commits and changes (verdict + a reply for the reviewer), then I can ask follow-ups or add
 * context (links are opened) in the same conversation. When it needs code, "Hand to agent" gives the conversation so
 * far to the MR's Cockpit session (a new one when none runs, or when asked): "Review" only reads and advises, "Fix"
 * commits the change. The server re-reads the thread, its code and attachments.
 */
export function ThreadAgentActions({
  repo,
  iid,
  discussionId,
}: {
  repo: string;
  iid: number;
  discussionId: string;
}) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const here = `${pathname}${search}`;
  const mrSession = useMrSessions(repo, iid)[0];
  const [fresh, setFresh] = useState(false);
  const start = useThreadAgent();
  const explain = useThreadExplain();
  const chat = useThreadChat();
  const settings = useSettings().data;
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [agentPick, setAgentPick] = useState<'claude' | 'cursor' | null>(null);
  const [modelPick, setModelPick] = useState<string | null>(null);
  const agent = agentPick ?? settings?.agentPreference ?? 'claude';
  const models = AGENT_MODEL_CHOICES[agent];
  const cfg = settings?.agentModels;
  const defaultModel = agent === 'claude' ? cfg?.planModel : cfg?.cursorModel;
  const model =
    modelPick && models.some((m) => m.id === modelPick)
      ? modelPick
      : (defaultModel ?? models[0].id);
  const ids = { repoId: repo, iid, discussionId };

  /** The conversation as the AI and the agent get it: the first explanation, then every turn. */
  const history = (): MrChatMessage[] =>
    [
      ...(explain.data
        ? [{ role: 'assistant' as const, text: explanationText(explain.data) }]
        : []),
      ...turns.map((t) => ({ role: t.role, text: t.text })),
    ]
      .slice(-MR_CHAT_MAX_HISTORY)
      .map((m) => ({ ...m, text: m.text.slice(0, MR_CHAT_MAX_MESSAGE) }));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !explain.data && !explain.isPending) explain.mutate(ids);
  };
  const ask = () => {
    const q = draft.trim();
    if (!q || chat.isPending) return;
    const before = history();
    setDraft('');
    setTurns((t) => [...t, { role: 'user', text: q }]);
    chat.mutate(
      { ...ids, question: q, history: before },
      {
        onSuccess: (r) =>
          setTurns((t) => [
            ...t,
            { role: 'assistant', text: r.answer, generatedBy: r.generatedBy },
          ]),
        onError: () => {
          // Put the question back so it can be sent again.
          setTurns((t) => t.slice(0, -1));
          setDraft((d) => d || q);
        },
      },
    );
  };
  const go = (mode: ThreadAgentMode) => {
    const conversation = history();
    start.mutate(
      {
        ...ids,
        mode,
        agent,
        model,
        ...(conversation.length ? { conversation } : {}),
        ...(fresh ? { newSession: true } : {}),
      },
      {
        onSuccess: (r) =>
          void navigate(sessionHref({ id: r.sessionId, workspaceId: r.workspaceId }, here)),
      },
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
    }
  };
  const pendingMode = start.isPending ? start.variables?.mode : null;

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {mrSession?.mr?.discussionId === discussionId && (
          <Link
            to={sessionHref(mrSession, here)}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-xs font-medium hover:bg-accent"
            title="The agent session working on this thread"
          >
            <Bot className="size-3.5" aria-hidden />
            Agent · {sessionStateLabel(mrSession)}
          </Link>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={false}
          title="AI checks this comment against the MR's commits and changes. Then ask follow-ups, add context, or hand it to an agent."
          onClick={toggle}
        >
          <Sparkles className="size-3.5" aria-hidden />
          {explain.data || turns.length ? 'Show AI' : 'Ask AI'}
        </Button>
      </div>
    );
  }

  return (
    <section
      aria-label="Ask AI about this thread"
      className="grid gap-2 rounded-surface border border-primary/30 bg-primary/5 p-3 text-sm"
    >
      <header className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-primary-ink">
          <Sparkles className="size-3.5" aria-hidden /> Ask AI
        </p>
        <Button type="button" size="sm" variant="ghost" aria-expanded onClick={toggle}>
          <ChevronUp className="size-3.5" aria-hidden /> Hide
        </Button>
      </header>

      {explain.isPending && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          Checking the comment against the MR’s commits and changes…
        </p>
      )}
      {explain.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-destructive">{describeError(explain.error)}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => explain.mutate(ids)}>
            <RotateCcw className="size-3.5" aria-hidden /> Try again
          </Button>
        </div>
      )}
      {explain.data && <ThreadExplanation r={explain.data} />}

      {turns.map((t, i) =>
        t.role === 'user' ? (
          <p
            key={i}
            className="ml-auto max-w-[85%] rounded-control bg-background/80 px-2.5 py-1.5 leading-relaxed whitespace-pre-wrap"
          >
            {t.text}
          </p>
        ) : (
          <div key={i} className="grid gap-1">
            <Markdown source={t.text} repo={repo} className="leading-relaxed" />
            <GeneratedBy by={t.generatedBy} />
          </div>
        ),
      )}
      {chat.isPending && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> Thinking…
        </p>
      )}
      {chat.error && <p className="text-xs text-destructive">{describeError(chat.error)}</p>}

      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Ask a follow-up or add context"
          rows={2}
          maxLength={8000}
          value={draft}
          placeholder="Ask a follow-up, or add context: background, intent, links (GitLab, Notion, docs)…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          type="button"
          size="sm"
          aria-label="Send"
          disabled={!draft.trim() || chat.isPending}
          onClick={ask}
        >
          <SendHorizontal className="size-3.5" aria-hidden />
        </Button>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-primary/20 pt-2">
        <span className="text-xs text-muted-foreground">Hand to agent</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={start.isPending}
          title="Agent session with this conversation: explains the comment and proposes a fix, without changing files"
          onClick={() => go('review')}
        >
          {pendingMode === 'review' ? (
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Bot className="size-3.5" aria-hidden />
          )}
          Review
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={start.isPending}
          title="Agent session with this conversation: plans, then makes the change as a new commit on the MR's branch"
          onClick={() => go('fix')}
        >
          {pendingMode === 'fix' ? (
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Wrench className="size-3.5" aria-hidden />
          )}
          Fix
        </Button>
        <Select
          aria-label="Agent for Review and Fix"
          className="h-8 w-auto text-xs"
          value={agent}
          disabled={start.isPending}
          onChange={(e) => {
            setAgentPick(e.target.value as 'claude' | 'cursor');
            setModelPick(null);
          }}
        >
          <option value="claude">Claude</option>
          <option value="cursor">Cursor</option>
        </Select>
        <Select
          aria-label="Model for Review and Fix"
          className="h-8 w-auto text-xs"
          value={model}
          disabled={start.isPending}
          title={
            agent === 'claude' && cfg && model === cfg.planModel && cfg.execModel !== model
              ? `Plans on this model, then switches to ${cfg.execModel} (${cfg.execEffort}) when you approve the plan`
              : undefined
          }
          onChange={(e) => setModelPick(e.target.value)}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!models.some((m) => m.id === model) && (
            <option value={model}>{agentModelLabel(model)}</option>
          )}
        </Select>
      </footer>
      {mrSession && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {fresh
              ? 'Review and Fix start a new session.'
              : `Review and Fix continue this MR's agent session (${sessionStateLabel(mrSession)}).`}
          </span>
          <Link
            to={sessionHref(mrSession, here)}
            className="font-medium text-primary-ink hover:underline"
          >
            Open session →
          </Link>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={fresh}
              onChange={(e) => setFresh(e.target.checked)}
            />
            New session
          </label>
        </div>
      )}
      {start.error && <p className="text-xs text-destructive">{describeError(start.error)}</p>}
    </section>
  );
}

function ThreadExplanation({ r }: { r: ExplainThreadResult }) {
  const [copied, setCopied] = useState(false);
  const v = VERDICT[r.verdict];
  const copy = () => {
    void navigator.clipboard.writeText(r.suggestedReply).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Badge variant={v.variant}>{v.label}</Badge>
      </div>
      <p className="leading-relaxed whitespace-pre-wrap">{r.summary}</p>
      {r.whatChanged && (
        <div className="grid gap-0.5">
          <p className="text-xs font-medium text-muted-foreground">What the MR changed</p>
          <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {r.whatChanged}
          </p>
        </div>
      )}
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            Suggested reply to the reviewer
          </p>
          <Button type="button" size="sm" variant="ghost" onClick={copy}>
            {copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="rounded-control bg-background/60 p-2 leading-relaxed whitespace-pre-wrap">
          {r.suggestedReply}
        </p>
      </div>
      <GeneratedBy by={r.generatedBy} />
    </div>
  );
}
