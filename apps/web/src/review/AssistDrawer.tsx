import { Check, Copy, Loader2, RotateCcw, SendHorizontal, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  MR_CHAT_MAX_HISTORY,
  MR_CHAT_MAX_MESSAGE,
  type AiGeneratedBy,
  type MrChatMessage,
  type ReviewAssistSource,
  type ReviewProposeResult,
} from '@relay/shared';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useExplainChat, useProposeChange } from '@/lib/reviewAssistApi';
import { cn } from '@/lib/utils';
import { useCoarsePointer } from '@/workspace/useMedia';

/** What the drawer shows: a file's Explain chat, or Propose changes for a file (`file`) or the whole branch (null). */
export type AssistTarget =
  { kind: 'explain'; file: string } | { kind: 'propose'; file: string | null };

type Shown = MrChatMessage & { generatedBy?: AiGeneratedBy };

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * The Code Review assist drawer (right side, full screen on a phone). Stays mounted while the review is open, so each
 * file's Explain conversation and the Propose draft survive closing and reopening it.
 */
export function AssistDrawer({
  source,
  target,
  onClose,
}: {
  source: ReviewAssistSource;
  target: AssistTarget | null;
  onClose: () => void;
}) {
  const [chats, setChats] = useState<ReadonlyMap<string, Shown[]>>(() => new Map());
  const last = useRef<AssistTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          'top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none border-y-0 border-r-0 p-4 sm:max-w-xl sm:p-5',
          'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
        )}
        aria-describedby={undefined}
      >
        {shown?.kind === 'explain' && (
          <ExplainPane
            key={shown.file}
            source={source}
            file={shown.file}
            messages={chats.get(shown.file) ?? []}
            setMessages={(fn) =>
              setChats((prev) => new Map(prev).set(shown.file, fn(prev.get(shown.file) ?? [])))
            }
          />
        )}
        {shown?.kind === 'propose' && (
          <ProposePane key={shown.file ?? '\0branch'} source={source} file={shown.file} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PaneHeader({
  icon,
  title,
  file,
}: {
  icon: ReactNode;
  title: string;
  file: string | null;
}) {
  return (
    <div className="grid gap-1 pr-8">
      <DialogTitle className="flex items-center gap-2 text-base tracking-normal normal-case">
        {icon}
        {title}
      </DialogTitle>
      {file ? (
        <p className="truncate font-mono text-xs text-muted-foreground" title={file}>
          {file}
        </p>
      ) : (
        <DialogDescription className="text-xs">All changes on this branch.</DialogDescription>
      )}
    </div>
  );
}

function ExplainPane({
  source,
  file,
  messages,
  setMessages,
}: {
  source: ReviewAssistSource;
  file: string;
  messages: Shown[];
  setMessages: (fn: (prev: Shown[]) => Shown[]) => void;
}) {
  const chat = useExplainChat();
  const touch = useCoarsePointer();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const ask = (question?: string) => {
    if (chat.isPending) return;
    chat.mutate(
      {
        source,
        file,
        history: messages
          .slice(-MR_CHAT_MAX_HISTORY)
          .map((m) => ({ role: m.role, text: m.text.slice(0, MR_CHAT_MAX_MESSAGE) })),
        ...(question ? { question } : {}),
      },
      {
        onSuccess: ({ answer, generatedBy }) =>
          setMessages((prev) => [
            ...prev,
            ...(question ? [{ role: 'user' as const, text: question }] : []),
            { role: 'assistant', text: answer, generatedBy },
          ]),
        onError: () => {
          if (question) setDraft((current) => current || question);
        },
      },
    );
  };

  // The first explanation runs on open; a reopened file keeps its conversation.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || messages.length > 0) return;
    started.current = true;
    ask();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, chat.isPending]);

  const send = () => {
    const q = draft.trim();
    if (!q || chat.isPending) return;
    setDraft('');
    ask(q);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const asked = chat.isPending ? chat.variables.question : undefined;
  const list: Shown[] = asked ? [...messages, { role: 'user', text: asked }] : messages;

  return (
    <>
      <PaneHeader
        icon={<Sparkles className="size-4 text-primary" aria-hidden />}
        title={`Why ${baseName(file)} changed`}
        file={file}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="grid gap-3 text-sm" aria-live="polite">
          {list.map((m, i) => (
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
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> Thinking…
            </li>
          )}
        </ul>
        {chat.error && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
            {describeError(chat.error)}
            {messages.length === 0 && (
              <Button size="sm" variant="outline" onClick={() => ask()}>
                <RotateCcw className="size-3.5" aria-hidden /> Retry
              </Button>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2 border-t pt-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a follow-up, e.g. What breaks if the token is null?"
          aria-label="Follow-up question"
          maxLength={2000}
          rows={1}
          className="max-h-32 min-h-9 bg-background"
        />
        <Button
          size="icon"
          aria-label="Send question"
          disabled={!draft.trim() || chat.isPending}
          onClick={send}
        >
          <SendHorizontal className="size-4" />
        </Button>
      </div>
    </>
  );
}

function ProposePane({ source, file }: { source: ReviewAssistSource; file: string | null }) {
  const propose = useProposeChange();
  const [scope, setScope] = useState<'file' | 'branch'>(file ? 'file' : 'branch');
  const [request, setRequest] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<ReviewProposeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = propose.isPending;
  const sending = pending && propose.variables.send;

  const base = () => ({
    source,
    scope,
    ...(scope === 'file' && file ? { file } : {}),
    request: request.trim(),
  });

  const write = () => {
    if (!request.trim() || pending) return;
    propose.mutate(
      { ...base(), send: false },
      {
        onSuccess: (r) => {
          setPrompt(r.prompt);
          setResult(r);
        },
      },
    );
  };
  const send = () => {
    if (!prompt.trim() || pending) return;
    propose.mutate({ ...base(), prompt: prompt.trim(), send: true }, { onSuccess: setResult });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: the text stays selectable */
    }
  };

  const choices = [
    ...(file ? [{ id: 'file' as const, label: 'This file' }] : []),
    { id: 'branch' as const, label: 'Whole branch' },
  ];

  return (
    <>
      <PaneHeader
        icon={<Wand2 className="size-4 text-primary" aria-hidden />}
        title="Propose changes"
        file={scope === 'file' ? file : null}
      />
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto text-sm">
        {choices.length > 1 && (
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Scope">
            {choices.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={scope === c.id}
                onClick={() => setScope(c.id)}
                className={cn(
                  'rounded-control border px-2 py-1 text-xs',
                  scope === c.id
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <label className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">What should change?</span>
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={
              scope === 'file'
                ? 'e.g. Handle the empty list before mapping, and log the failure instead of swallowing it.'
                : 'e.g. Rename fetchLock to readLockState everywhere and drop the unused retry flag.'
            }
            maxLength={8000}
            className="min-h-24 bg-background"
          />
        </label>
        <Button
          size="sm"
          variant={prompt ? 'outline' : 'default'}
          className="justify-self-start"
          disabled={!request.trim() || pending}
          onClick={write}
        >
          {pending && !sending ? (
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-3.5" aria-hidden />
          )}
          {prompt ? 'Write again' : 'Write agent prompt'}
        </Button>

        {prompt && (
          <div className="grid gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Agent prompt (you can edit it before sending)
            </span>
            <Textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setResult((r) => (r?.sent ? null : r));
              }}
              className="min-h-56 bg-background font-mono text-xs"
              aria-label="Agent prompt"
            />
            {result?.generatedBy && <GeneratedBy by={result.generatedBy} />}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!prompt.trim() || pending} onClick={send}>
                {sending ? (
                  <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <SendHorizontal className="size-3.5" aria-hidden />
                )}
                Send to agent
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}

        {propose.error && (
          <p className="text-xs text-destructive">{describeError(propose.error)}</p>
        )}
        {result && !result.sent && result.reason && (
          <p className="text-xs text-warning">Not sent: {result.reason} Copy the prompt instead.</p>
        )}
        {result?.sent && (
          <p className="text-xs text-success">
            Sent to the agent on this branch.{' '}
            {result.workspaceId && (
              <Link
                className="underline underline-offset-4"
                to={`/cockpit?ws=${encodeURIComponent(result.workspaceId)}${result.sessionId ? `&session=${result.sessionId}` : ''}&tab=agent`}
              >
                Open the session
              </Link>
            )}
          </p>
        )}
      </div>
    </>
  );
}
