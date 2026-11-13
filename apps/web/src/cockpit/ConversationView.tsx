import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleStop,
  Layers,
  Loader2,
  SendHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { agentModelLabel, type ConversationCommand, type ConversationMode } from '@relay/shared';
import { Markdown } from '@/components/Markdown';
import { MicButton } from '@/components/MicButton';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { type DocAsk, type DocItem, type DocTool, useConversation } from '@/lib/conversation';
import { deckPath } from '@/lib/deckApi';
import { describeError } from '@/lib/api';
import { sendInput, sendPrompt, useKillSession, type SessionView } from '@/lib/sessionApi';
import { IS_MAC } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useCoarsePointer } from '@/workspace/useMedia';

/**
 * An agent session (Claude or Cursor) as a calm document: one reading column, the agent's words as prose, tool activity folded into a quiet
 * line, and at most one decision at a time. The editor at the bottom behaves like an editor: Enter is a new line.
 */

const MODE_LABEL: Record<ConversationMode, string> = {
  plan: 'Plan first',
  acceptEdits: 'Allow everything',
};

const MODELS = [
  { value: 'default', label: 'Default model' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

/** The picker's options, plus the session's model when it is a full id the list doesn't name. */
function modelOptions(current: string | null) {
  if (!current || MODELS.some((m) => m.value === current)) return MODELS;
  return [...MODELS, { value: current, label: agentModelLabel(current) }];
}

/** Long prompts (a card's rules, a whole review thread) start folded. */
const USER_FOLD_LINES = 6;

function statusOf(s: SessionView, mode: ConversationMode, deciding: boolean) {
  if (s.state === 'exited') return { label: 'Session ended', dot: 'bg-muted-foreground' };
  if (deciding) return { label: 'Waiting for your decision', dot: 'bg-primary' };
  if (s.state === 'running') {
    return {
      label: mode === 'plan' ? 'Planning…' : 'Working…',
      dot: 'bg-moss motion-safe:animate-pulse',
    };
  }
  return { label: 'Your turn', dot: 'bg-moss' };
}

function UserBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  const long = lines.length > USER_FOLD_LINES;
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl bg-muted/60 px-4 py-3 text-base leading-7">
      <p className="break-words whitespace-pre-wrap">
        {long && !open ? `${lines.slice(0, USER_FOLD_LINES).join('\n')}…` : text}
      </p>
      {long && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function toolsLine(tools: DocTool[]): string {
  const count = (names: string[]) => tools.filter((t) => names.includes(t.name)).length;
  const parts = [
    [count(['Read']), 'read'],
    [count(['Edit', 'Write', 'NotebookEdit']), 'changed'],
    [count(['Grep', 'Glob']), 'search'],
    [count(['Bash']), 'command'],
  ] as const;
  const known = parts
    .filter(([n]) => n > 0)
    .map(([n, what]) =>
      what === 'read'
        ? `Read ${n} file${n === 1 ? '' : 's'}`
        : what === 'changed'
          ? `changed ${n} file${n === 1 ? '' : 's'}`
          : what === 'search'
            ? `ran ${n} search${n === 1 ? '' : 'es'}`
            : `ran ${n} command${n === 1 ? '' : 's'}`,
    );
  const other = tools.length - parts.reduce((sum, [n]) => sum + n, 0);
  if (other > 0) known.push(`${other} other step${other === 1 ? '' : 's'}`);
  const line = known.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function ToolsLine({ tools }: { tools: DocTool[] }) {
  const running = tools.some((t) => t.state === 'running');
  const failed = tools.filter((t) => t.state === 'error').length;
  return (
    <details className="group text-sm text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        {running ? (
          <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
        ) : (
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            aria-hidden
          />
        )}
        <span>{toolsLine(tools)}</span>
        {failed > 0 && <span className="text-destructive">· {failed} failed</span>}
      </summary>
      <ul className="mt-1 grid gap-1 border-l pl-4">
        {tools.map((t) => (
          <li key={t.id} className="min-w-0">
            <span
              className={cn('[overflow-wrap:anywhere]', t.state === 'error' && 'text-destructive')}
            >
              {t.summary}
            </span>
            {t.output && t.state === 'error' && (
              <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                {t.output}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

const ASK_DONE_LABEL: Record<NonNullable<DocAsk['outcome']>, string> = {
  approved: 'Plan approved',
  revised: 'Plan sent back with your changes',
  rejected: 'Plan rejected',
  allowed: 'Allowed',
  denied: 'Denied',
  answered: 'Answered',
  cancelled: 'No longer needed',
};

function PlanActions({
  answer,
  exec,
}: {
  answer: (a: { allow: boolean; message?: string; execModel?: boolean }) => void;
  exec?: { model: string; effort: string | null } | null;
}) {
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  if (revising) {
    return (
      <div className="grid gap-2">
        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What should change in this plan?"
          aria-label="What should change in this plan?"
          className="min-h-24 text-base"
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={!note.trim()} onClick={() => answer({ allow: false, message: note })}>
            Send changes
          </Button>
          <Button variant="ghost" onClick={() => setRevising(false)}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {exec ? (
          <>
            <Button onClick={() => answer({ allow: true, execModel: true })}>
              <Check className="size-4" aria-hidden /> Approve, run on {agentModelLabel(exec.model)}
              {exec.effort ? ` (${exec.effort})` : ''}
            </Button>
            <Button variant="outline" onClick={() => answer({ allow: true, execModel: false })}>
              <Check className="size-4" aria-hidden /> Approve, keep current model
            </Button>
          </>
        ) : (
          <Button onClick={() => answer({ allow: true })}>
            <Check className="size-4" aria-hidden /> Approve
          </Button>
        )}
        <Button variant="outline" onClick={() => setRevising(true)}>
          Propose Changes
        </Button>
        <Button variant="ghost" onClick={() => answer({ allow: false })}>
          Reject
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        After approval, the agent carries out the plan without asking.
      </p>
    </div>
  );
}

function QuestionActions({
  ask,
  answer,
}: {
  ask: DocAsk;
  answer: (a: { allow: boolean; answers?: Record<string, string> }) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const toggle = (q: string, label: string, multi: boolean) =>
    setPicked((prev) => {
      const cur = prev[q] ?? [];
      if (!multi) return { ...prev, [q]: [label] };
      return {
        ...prev,
        [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  const complete = ask.questions.every((q) => (picked[q.question]?.length ?? 0) > 0);
  return (
    <div className="grid gap-4">
      {ask.questions.map((q) => (
        <fieldset key={q.question} className="grid gap-2">
          <legend className="mb-1 text-base leading-6">{q.question}</legend>
          {q.options.map((o) => {
            const on = picked[q.question]?.includes(o.label) ?? false;
            return (
              <button
                key={o.label}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(q.question, o.label, q.multiSelect)}
                className={cn(
                  'rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                  on ? 'border-primary bg-primary/10' : 'hover:bg-accent/50',
                )}
              >
                <span className="block font-medium">{o.label}</span>
                {o.description && (
                  <span className="block text-xs text-muted-foreground">{o.description}</span>
                )}
              </button>
            );
          })}
        </fieldset>
      ))}
      <div>
        <Button
          disabled={!complete}
          onClick={() =>
            answer({
              allow: true,
              answers: Object.fromEntries(
                Object.entries(picked).map(([q, labels]) => [q, labels.join(', ')]),
              ),
            })
          }
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}

function AskCard({ ask, onCommand }: { ask: DocAsk; onCommand: (c: ConversationCommand) => void }) {
  if (ask.outcome) {
    return (
      <div className="grid gap-2">
        {ask.plan && <Markdown source={ask.plan} className="text-base leading-7" />}
        <p className="text-sm text-muted-foreground">
          {ask.ask === 'permission' ? `${ask.summary}: ` : ''}
          {ASK_DONE_LABEL[ask.outcome]}
        </p>
      </div>
    );
  }
  const answer = (a: {
    allow: boolean;
    message?: string;
    remember?: boolean;
    execModel?: boolean;
    answers?: Record<string, string>;
  }) => onCommand({ type: 'answer', id: ask.id, ...a });
  return (
    <section
      className="grid gap-3 rounded-surface border border-primary/40 bg-primary/5 p-4"
      aria-label={ask.summary}
    >
      <p className="text-sm font-medium">{ask.summary}</p>
      {ask.plan && <Markdown source={ask.plan} className="text-base leading-7" />}
      {ask.detail && (
        <pre className="overflow-x-auto rounded-lg bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {ask.detail}
        </pre>
      )}
      {ask.ask === 'plan' && <PlanActions answer={answer} exec={ask.exec} />}
      {ask.ask === 'question' && <QuestionActions ask={ask} answer={answer} />}
      {ask.ask === 'permission' && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => answer({ allow: true })}>Allow</Button>
          {ask.canRemember && (
            <Button variant="outline" onClick={() => answer({ allow: true, remember: true })}>
              Allow for this session
            </Button>
          )}
          <Button variant="ghost" onClick={() => answer({ allow: false })}>
            Deny
          </Button>
        </div>
      )}
    </section>
  );
}

function Block({
  item,
  onCommand,
}: {
  item: DocItem;
  onCommand: (c: ConversationCommand) => void;
}) {
  switch (item.kind) {
    case 'user':
      return <UserBlock text={item.text} />;
    case 'text':
      return <Markdown source={item.text} className="text-base leading-7" />;
    case 'tools':
      return <ToolsLine tools={item.tools} />;
    case 'ask':
      return <AskCard ask={item.ask} onCommand={onCommand} />;
    case 'notice':
      return (
        <p
          className={cn(
            'flex items-start gap-1.5 text-sm [overflow-wrap:anywhere]',
            item.level === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {item.level === 'error' && (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          )}
          {item.text}
        </p>
      );
  }
}

const readDraft = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const writeDraft = (key: string, text: string): void => {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    /* the draft only lives on screen */
  }
};

function Editor({
  sessionId,
  placeholder,
  size,
  onSend,
}: {
  sessionId: string;
  placeholder: string;
  /** Small while a decision waits above it, so the decision stays the one thing to look at. */
  size: 'small' | 'normal' | 'large';
  onSend: (text: string) => void;
}) {
  const key = `cockpit-draft:${sessionId}`;
  const [text, setText] = useState(() => readDraft(key));
  const touch = useCoarsePointer();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, size]);
  const change = (v: string) => {
    setText(v);
    writeDraft(key, v);
  };
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    change('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="rounded-surface border bg-card shadow-rest transition-shadow focus-within:shadow-lift focus-within:ring-1 focus-within:ring-ring/40">
      <textarea
        ref={ref}
        value={text}
        rows={size === 'small' ? 1 : size === 'large' ? 5 : 3}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Message to the agent"
        className="block max-h-[40dvh] w-full resize-none overflow-y-auto bg-transparent px-4 pt-3.5 pb-1 text-base leading-7 outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        {!touch && (
          <span className="pl-1.5 text-xs text-muted-foreground">
            {IS_MAC ? '⌘↵' : 'Ctrl+Enter'} to send
          </span>
        )}
        <span className="ml-auto" />
        <MicButton onText={(t) => change(text ? `${text} ${t}` : t)} />
        <Button size="sm" className="rounded-xl" disabled={!text.trim()} onClick={submit}>
          <SendHorizontal className="size-4" aria-hidden /> Send
        </Button>
      </div>
    </div>
  );
}

export function ConversationView({ s }: { s: SessionView }) {
  const doc = useConversation(s.id);
  const kill = useKillSession();
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const exited = s.state === 'exited';
  const deciding = doc.items.some((it) => it.kind === 'ask' && !it.ask.outcome);
  const status = statusOf(s, doc.mode, deciding);
  const working = !exited && s.state === 'running';
  const turn = s.turn;
  const empty = doc.items.length === 0;

  // Follow the newest text, unless the reader scrolled up to read something.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [doc.items]);

  const fail = (e: unknown) => setError(describeError(e));
  const onCommand = (c: ConversationCommand) => {
    setError(null);
    void sendInput(s.id, JSON.stringify(c)).catch(fail);
  };
  const onSend = (text: string) => {
    setError(null);
    stick.current = true;
    void sendPrompt(s.id, text).catch(fail);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-2 shrink-0 rounded-full', status.dot)} aria-hidden />
        <span className="text-sm text-foreground" role="status">
          {status.label}
        </span>
        <span className="ml-auto" />
        {!exited && (
          <>
            <Select
              aria-label="How the agent works"
              className="h-8 w-auto text-xs"
              value={doc.mode}
              onChange={(e) =>
                onCommand({ type: 'mode', mode: e.target.value as ConversationMode })
              }
            >
              {Object.entries(MODE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            {s.kind === 'cursor' ? (
              // Cursor keeps the model it started on (one headless run per turn, no live switch).
              <span className="text-xs text-muted-foreground" title="Cursor model">
                {doc.model ?? 'Cursor'}
              </span>
            ) : (
              <Select
                aria-label="Model"
                className="h-8 w-auto text-xs"
                value={doc.model ?? 'default'}
                onChange={(e) =>
                  onCommand({
                    type: 'model',
                    model: e.target.value as Extract<
                      ConversationCommand,
                      { type: 'model' }
                    >['model'],
                  })
                }
              >
                {modelOptions(doc.model).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}
        {working && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => onCommand({ type: 'interrupt' })}
          >
            <CircleStop className="size-3.5" aria-hidden /> Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2"
          disabled={kill.isPending}
          onClick={() => kill.mutate(s.id)}
        >
          <X className="size-3.5" aria-hidden /> {exited ? 'Close' : 'End session'}
        </Button>
      </div>

      {/* A new session: the question and the editor sit together in the middle, like an empty page. */}
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-3', empty && 'justify-center')}>
        <div
          ref={scroller}
          className={cn('min-h-0 overflow-y-auto', !empty && 'flex-1')}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto grid w-full max-w-2xl grid-cols-[minmax(0,1fr)] gap-5 px-1 py-2">
            {empty && (
              <div className="grid gap-1 pb-3 text-center">
                <p className="text-xl font-medium tracking-tight">What should we work on?</p>
                <p className="text-sm text-muted-foreground">
                  The agent reads the code and brings you a plan first. Nothing changes until you
                  approve it.
                </p>
              </div>
            )}
            {doc.items.map((item, i) => (
              <Block key={i} item={item} onCommand={onCommand} />
            ))}
            {working && doc.items.length > 0 && doc.items.at(-1)?.kind !== 'tools' && (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                {status.label}
              </p>
            )}
          </div>
        </div>

        <div className="mx-auto grid w-full max-w-2xl grid-cols-[minmax(0,1fr)] gap-2">
          {s.waiting && turn && !turn.reviewed && (turn.files ?? 0) > 0 && (
            <Link
              to={deckPath({
                kind: 'local',
                workspaceId: s.workspaceId,
                mode: 'turn',
                ...(turn.checkpoint ? { base: String(turn.checkpoint) } : {}),
              })}
              state={{ from: `/cockpit?session=${s.id}` }}
              className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm hover:bg-accent/50"
            >
              <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {turn.headline ??
                  `${turn.files} file${turn.files === 1 ? '' : 's'} changed in this turn`}
              </span>
              <span className="shrink-0 font-medium text-primary-ink">Review →</span>
            </Link>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {exited ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              This session has ended. Start a new one to continue.
            </p>
          ) : (
            <Editor
              sessionId={s.id}
              onSend={onSend}
              size={deciding ? 'small' : empty ? 'large' : 'normal'}
              placeholder={
                deciding
                  ? 'Decide above, or add a note for the agent…'
                  : working
                    ? 'Add something for the agent to pick up next…'
                    : empty
                      ? 'Describe the task…'
                      : 'Reply to the agent…'
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
