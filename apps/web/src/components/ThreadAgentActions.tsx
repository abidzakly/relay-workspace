import { Bot, Check, Copy, Loader2, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AGENT_MODEL_CHOICES, type ExplainThreadResult } from '@relay/shared';
import { describeError } from '@/lib/api';
import { useSettings } from '@/lib/settingsApi';
import { useThreadAgent, useThreadExplain, type ThreadAgentMode } from '@/lib/workflowApi';
import { Badge } from '@/components/Badge';
import { GeneratedBy } from '@/components/GeneratedBy';
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

/**
 * A reviewer thread's actions (Code Review and MR Detail). "Explain" checks the comment against the MR's commits and
 * changes and gives me something to tell the reviewer. "Review" / "Fix with agent" each start a NEW session in the
 * Cockpit: "Review" only reads and advises, "Fix with agent" commits the change. The server reads the thread, its
 * code and attachments.
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
  const start = useThreadAgent();
  const explain = useThreadExplain();
  const settings = useSettings().data;
  const [agentPick, setAgentPick] = useState<'claude' | 'cursor' | null>(null);
  const [modelPick, setModelPick] = useState<string | null>(null);
  const [context, setContext] = useState('');
  const [showContext, setShowContext] = useState(false);
  const agent = agentPick ?? settings?.agentPreference ?? 'claude';
  const models = AGENT_MODEL_CHOICES[agent];
  const cfg = settings?.agentModels;
  const defaultModel = agent === 'claude' ? cfg?.planModel : cfg?.cursorModel;
  const model =
    modelPick && models.some((m) => m.id === modelPick)
      ? modelPick
      : (defaultModel ?? models[0].id);
  const go = (mode: ThreadAgentMode) =>
    start.mutate(
      { repoId: repo, iid, discussionId, mode, agent, model },
      {
        onSuccess: (r) =>
          void navigate(
            `/cockpit?ws=${encodeURIComponent(r.workspaceId)}&session=${r.sessionId}&tab=agent`,
          ),
      },
    );
  const busy = start.isPending || explain.isPending;
  const pendingMode = start.isPending ? start.variables?.mode : null;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          title="AI checks this comment against the commits and changes of this MR, so you can explain it to the reviewer"
          onClick={() =>
            explain.mutate({
              repoId: repo,
              iid,
              discussionId,
              ...(context.trim() ? { context: context.trim() } : {}),
            })
          }
        >
          {explain.isPending ? (
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-3.5" aria-hidden />
          )}
          Explain
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={showContext}
          onClick={() => setShowContext((v) => !v)}
        >
          {context.trim() ? 'Context added' : 'Add context'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          title="New agent session that explains this comment and proposes a fix, without changing files"
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
          disabled={busy}
          title="New agent session that makes this change as a new commit on the MR's branch"
          onClick={() => go('fix')}
        >
          {pendingMode === 'fix' ? (
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Wrench className="size-3.5" aria-hidden />
          )}
          Fix with agent
        </Button>
        <Select
          aria-label="Agent for Review and Fix"
          className="h-8 w-auto text-xs"
          value={agent}
          disabled={busy}
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
          disabled={busy}
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
          {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
        </Select>
      </div>
      {showContext && (
        <Textarea
          aria-label="Extra context for Explain"
          rows={3}
          maxLength={8000}
          value={context}
          disabled={busy}
          placeholder="Extra context for Explain: background, intent, or links (GitLab, Notion, docs). The AI also reads the whole diff and every comment in this MR."
          onChange={(e) => setContext(e.target.value)}
        />
      )}
      {start.error && <p className="text-xs text-destructive">{describeError(start.error)}</p>}
      {explain.error && <p className="text-xs text-destructive">{describeError(explain.error)}</p>}
      {explain.data && <ThreadExplanation r={explain.data} />}
    </div>
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
    <div className="mt-1 grid gap-2 rounded-surface border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-primary-ink" aria-hidden />
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
