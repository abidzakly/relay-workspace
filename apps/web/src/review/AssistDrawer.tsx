import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Check,
  Copy,
  CornerDownRight,
  Loader2,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import {
  MR_CHAT_MAX_HISTORY,
  MR_CHAT_MAX_MESSAGE,
  type AiGeneratedBy,
  type ExplainChangeOutput,
  type ReviewAssistSource,
  type ReviewProposeResult,
} from '@relay/shared';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useExplainChat, useProposeChange } from '@/lib/reviewAssistApi';
import { cn } from '@/lib/utils';
import { useCoarsePointer, useNarrow } from '@/workspace/useMedia';

/** What the drawer shows: a file's Explain chat, or Propose changes for a file (`file`) or the whole branch (null). */
export type AssistTarget =
  { kind: 'explain'; file: string } | { kind: 'propose'; file: string | null };

type Turn =
  | { role: 'user'; text: string }
  | ({ role: 'assistant'; generatedBy: AiGeneratedBy } & ExplainChangeOutput);

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Changed files, for turning a `file.dart` mention into a jump. */
interface FileLinks {
  find: (name: string) => string | null;
  jump: (path: string) => void;
}
const FileLinksContext = createContext<FileLinks | null>(null);

/**
 * The Code Review assist drawer. On a wide screen it sits beside the diff without dimming it, so the reviewer can
 * read the code while reading the explanation; on a phone it covers the screen. Stays mounted while the review is
 * open, so each file's Explain conversation survives closing and reopening it.
 */
export function AssistDrawer({
  source,
  target,
  files,
  onJumpToFile,
  onClose,
}: {
  source: ReviewAssistSource;
  target: AssistTarget | null;
  /** Paths of the changed files. */
  files: readonly string[];
  onJumpToFile: (path: string) => void;
  onClose: () => void;
}) {
  const narrow = useNarrow();
  const [chats, setChats] = useState<ReadonlyMap<string, Turn[]>>(() => new Map());
  const last = useRef<AssistTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  const links = useMemo<FileLinks>(() => {
    const byKey = new Map<string, string>();
    for (const f of files) {
      byKey.set(f, f);
      const b = baseName(f);
      // An ambiguous base name (two `index.ts`) only links by full path.
      byKey.set(b, byKey.has(b) && byKey.get(b) !== f ? '' : f);
    }
    return {
      find: (name) => byKey.get(name.replace(/^\.?\//, '')) || null,
      jump: (path) => {
        if (narrow) onClose();
        onJumpToFile(path);
      },
    };
  }, [files, narrow, onClose, onJumpToFile]);

  return (
    <DialogPrimitive.Root
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      modal={narrow}
    >
      <DialogPrimitive.Portal>
        {narrow && (
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-scrim/45 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        )}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // Beside the diff: clicking or scrolling the code must not close it.
          onInteractOutside={(e) => !narrow && e.preventDefault()}
          className={cn(
            'fixed inset-y-0 right-0 z-[60] flex w-full flex-col bg-popover outline-none sm:w-[min(36rem,46vw)]',
            'border-l border-hairline shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.18)]',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300 data-[state=open]:ease-out',
            'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-200',
          )}
        >
          <FileLinksContext.Provider value={links}>
            {shown?.kind === 'explain' && (
              <ExplainPane
                key={shown.file}
                source={source}
                file={shown.file}
                turns={chats.get(shown.file) ?? []}
                setTurns={(fn) =>
                  setChats((prev) => new Map(prev).set(shown.file, fn(prev.get(shown.file) ?? [])))
                }
              />
            )}
            {shown?.kind === 'propose' && (
              <ProposePane key={shown.file ?? '\0branch'} source={source} file={shown.file} />
            )}
          </FileLinksContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaneHeader({
  icon,
  title,
  file,
}: {
  icon: ReactNode;
  title: ReactNode;
  file: string | null;
}) {
  const links = useContext(FileLinksContext);
  return (
    <header className="flex items-start gap-3 border-b border-hairline px-4 py-3 sm:px-5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        {icon}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <DialogPrimitive.Title className="text-sm leading-snug font-semibold text-balance">
          {title}
        </DialogPrimitive.Title>
        {file ? (
          <button
            type="button"
            onClick={() => links?.jump(file)}
            className="min-w-0 justify-self-start truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            title={`Show ${file} in the diff`}
          >
            {file}
          </button>
        ) : (
          <DialogPrimitive.Description className="text-xs text-muted-foreground">
            All changes on this branch.
          </DialogPrimitive.Description>
        )}
      </div>
      <DialogPrimitive.Close className="rv-icon-btn -mt-1 -mr-2 shrink-0" aria-label="Close">
        <X className="size-4" aria-hidden />
      </DialogPrimitive.Close>
    </header>
  );
}

// ───────────────────────────── inline text ─────────────────────────────

/** `code` and **bold** in an AI sentence, as React nodes (never HTML). A changed file's name becomes a jump. */
function Inline({ text }: { text: string }) {
  const links = useContext(FileLinksContext);
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          const code = part.slice(1, -1);
          const path = links?.find(code);
          if (path) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => links!.jump(path)}
                title={`Show ${path} in the diff`}
                className="ax-code ax-code-link"
              >
                {code}
              </button>
            );
          }
          return (
            <code key={i} className="ax-code">
              {code}
            </code>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

/** A follow-up answer: paragraphs, and `- ` lines as a list. */
function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="grid gap-2.5">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="ax-list">
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*[-*]\s+/, '')} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            <Inline text={b} />
          </p>
        );
      })}
    </div>
  );
}

// ───────────────────────────── explain ─────────────────────────────

function Section({ label, points }: { label: string; points: readonly string[] }) {
  if (points.length === 0) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="ax-label">{label}</h3>
      <ul className="ax-list">
        {points.map((p, i) => (
          <li key={i}>
            <Inline text={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Before you approve": the reviewer ticks what they checked (kept with the conversation's turn). */
function Checklist({ points }: { points: readonly string[] }) {
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  if (points.length === 0) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="ax-label flex items-center justify-between">
        Before you approve
        <span className="tabular-nums normal-case">
          {done.size}/{points.length}
        </span>
      </h3>
      <ul className="grid gap-0.5">
        {points.map((p, i) => {
          const on = done.has(i);
          return (
            <li key={i}>
              <label className={cn('ax-check', on && 'ax-check-on')}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  onChange={() =>
                    setDone((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <span className="ax-box" aria-hidden>
                  <Check className="size-3" strokeWidth={3} />
                </span>
                <span className="min-w-0">
                  <Inline text={p} />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Brief({ t }: { t: Extract<Turn, { role: 'assistant' }> }) {
  return (
    <article className="grid gap-5">
      {t.tldr && (
        <p className="text-[0.9375rem] leading-relaxed font-medium text-foreground text-pretty">
          <Inline text={t.tldr} />
        </p>
      )}
      <Section label="What changed" points={t.changed} />
      <Section label="Why" points={t.why} />
      <Section label="Side effects" points={t.effects} />
      <Checklist points={t.checks} />
      <GeneratedBy by={t.generatedBy} />
    </article>
  );
}

/** What the AI said, as plain text for the conversation history it gets back. */
function turnText(t: Turn): string {
  if (t.role === 'user') return t.text;
  if (t.answer.trim()) return t.answer;
  const list = (title: string, xs: readonly string[]) =>
    xs.length ? [`${title}:`, ...xs.map((x) => `- ${x}`)] : [];
  return [
    t.tldr,
    ...list('Changed', t.changed),
    ...list('Why', t.why),
    ...list('Side effects', t.effects),
    ...list('Check', t.checks),
  ].join('\n');
}

function Thinking({ first }: { first: boolean }) {
  return (
    <div className="grid gap-3" role="status">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
        {first ? 'Reading the diff and the commit messages…' : 'Thinking…'}
      </p>
      {first && (
        <div className="grid gap-2" aria-hidden>
          <span className="ax-skel w-11/12" />
          <span className="ax-skel w-3/4" />
          <span className="ax-skel mt-3 w-1/4" />
          <span className="ax-skel w-5/6" />
          <span className="ax-skel w-2/3" />
        </div>
      )}
    </div>
  );
}

function ExplainPane({
  source,
  file,
  turns,
  setTurns,
}: {
  source: ReviewAssistSource;
  file: string;
  turns: Turn[];
  setTurns: (fn: (prev: Turn[]) => Turn[]) => void;
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
        history: turns
          .slice(-MR_CHAT_MAX_HISTORY)
          .map((t) => ({ role: t.role, text: turnText(t).slice(0, MR_CHAT_MAX_MESSAGE) }))
          .filter((m) => m.text.trim()),
        ...(question ? { question } : {}),
      },
      {
        onSuccess: ({ generatedBy, ...out }) =>
          setTurns((prev) => [
            ...prev,
            ...(question ? [{ role: 'user' as const, text: question }] : []),
            { role: 'assistant', generatedBy, ...out },
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
    if (started.current || turns.length > 0) return;
    started.current = true;
    ask();
  }, []);

  useEffect(() => {
    if (turns.length > 1 || chat.isPending) {
      endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }, [turns.length, chat.isPending]);

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
  const lastAi = [...turns].reverse().find((t) => t.role === 'assistant');
  const suggestions =
    !chat.isPending && lastAi?.role === 'assistant' ? lastAi.followUps.slice(0, 3) : [];

  return (
    <>
      <PaneHeader
        icon={<Sparkles className="size-3.5" aria-hidden />}
        title={
          <>
            Why <span className="font-mono text-[0.8125rem]">{baseName(file)}</span> changed
          </>
        }
        file={file}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5">
        <div className="grid gap-6 text-sm leading-relaxed text-foreground/85" aria-live="polite">
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <p
                key={i}
                className="max-w-[85%] justify-self-end rounded-2xl rounded-br-md bg-muted px-3.5 py-2 whitespace-pre-wrap text-foreground"
              >
                {t.text}
              </p>
            ) : t.answer.trim() ? (
              <div key={i} className="grid gap-2">
                <Prose text={t.answer} />
                <GeneratedBy by={t.generatedBy} />
              </div>
            ) : (
              <Brief key={i} t={t} />
            ),
          )}
          {asked && (
            <p className="max-w-[85%] justify-self-end rounded-2xl rounded-br-md bg-muted px-3.5 py-2 whitespace-pre-wrap text-foreground">
              {asked}
            </p>
          )}
          {chat.isPending && <Thinking first={turns.length === 0} />}
          {chat.error && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
              {describeError(chat.error)}
              {turns.length === 0 && (
                <Button size="sm" variant="outline" onClick={() => ask()}>
                  <RotateCcw className="size-3.5" aria-hidden /> Try again
                </Button>
              )}
            </div>
          )}
        </div>
        <div ref={endRef} />
      </div>
      <footer className="grid gap-2 border-t border-hairline px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
            {suggestions.map((q) => (
              <button key={q} type="button" className="ax-suggest" onClick={() => ask(q)}>
                <CornerDownRight className="size-3 shrink-0 opacity-60" aria-hidden />
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about this change…"
            aria-label="Follow-up question"
            maxLength={2000}
            rows={1}
            className="max-h-32 min-h-10 resize-none bg-background"
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
      </footer>
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
        icon={<Wand2 className="size-3.5" aria-hidden />}
        title="Propose changes"
        file={scope === 'file' ? file : null}
      />
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 py-5 text-sm sm:px-5">
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
