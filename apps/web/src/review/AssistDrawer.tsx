import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  AtSign,
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
  useId,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
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
  | { role: 'user'; text: string; mentions?: string[] }
  | ({ role: 'assistant'; generatedBy: AiGeneratedBy } & ExplainChangeOutput);

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Changed files, for turning a `file.dart` mention into a jump. */
interface FileLinks {
  /** Every changed file, in diff order. */
  files: readonly string[];
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
      files,
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
          // Escape with the @ file list open closes the list (in the composer), not the drawer.
          onEscapeKeyDown={(e) => {
            const el = document.activeElement;
            if (
              el?.getAttribute('role') === 'combobox' &&
              el.getAttribute('aria-expanded') === 'true'
            ) {
              e.preventDefault();
            }
          }}
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
  if (t.role === 'user') {
    return t.mentions?.length
      ? `${t.text}\n(mentioned: ${t.mentions.map(baseName).join(', ')})`
      : t.text;
  }
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

function UserBubble({ text, mentions }: { text: string; mentions: readonly string[] }) {
  const links = useContext(FileLinksContext);
  return (
    <div className="grid max-w-[85%] justify-items-end gap-1 justify-self-end">
      <p className="rounded-2xl rounded-br-md bg-muted px-3.5 py-2 whitespace-pre-wrap text-foreground">
        {text}
      </p>
      {mentions.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {mentions.map((m) => (
            <button
              key={m}
              type="button"
              className="ax-code ax-code-link text-[0.6875rem]"
              title={`Show ${m} in the diff`}
              onClick={() => links?.jump(m)}
            >
              @{baseName(m)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The `@query` right before the caret, or null. */
function atQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([\w./-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/**
 * "@" in the composer: a list of the other changed files, filtered by what follows the "@". Arrow keys move, Enter or
 * Tab picks, Escape closes. Picking removes the "@query" text; the file becomes a chip instead.
 */
function useMentionPicker({
  files,
  draft,
  inputRef,
  onPick,
}: {
  files: readonly string[];
  draft: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPick: (path: string, nextDraft: string) => void;
}) {
  const [at, setAt] = useState<{ start: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const listId = useId();

  const matches = useMemo(() => {
    if (!at) return [];
    const q = at.query.toLowerCase();
    const scored = files
      .map((f) => {
        const b = baseName(f).toLowerCase();
        const score = !q
          ? 1
          : b.startsWith(q)
            ? 0
            : b.includes(q)
              ? 1
              : f.toLowerCase().includes(q)
                ? 2
                : -1;
        return { f, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, 8).map((x) => x.f);
  }, [at, files]);

  const open = at !== null && matches.length > 0;
  const active = Math.min(index, Math.max(matches.length - 1, 0));

  const sync = () => {
    const el = inputRef.current;
    if (!el) return;
    const next = atQuery(el.value, el.selectionStart ?? el.value.length);
    setAt((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
    if (next?.query !== at?.query) setIndex(0);
  };
  // The draft changes on every keystroke: re-read the "@" before the caret.
  useEffect(sync, [draft]);

  const pick = (path: string) => {
    if (!at) return;
    const el = inputRef.current;
    const end = at.start + 1 + at.query.length;
    const before = draft.slice(0, at.start).replace(/\s+$/, '');
    const after = draft.slice(end).replace(/^\s+/, '');
    const next = before && after ? `${before} ${after}` : before || after;
    setAt(null);
    onPick(path, next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const caret = before.length + (before && after ? 1 : 0);
      el.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((active + d + matches.length) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(matches[active]!);
      return true;
    }
    if (e.key === 'Escape') {
      // Close the list, not the drawer.
      e.preventDefault();
      e.stopPropagation();
      setAt(null);
      return true;
    }
    return false;
  };

  const openFromButton = () => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const lead = caret > 0 && !/\s/.test(draft[caret - 1]!) ? ' ' : '';
    const next = `${draft.slice(0, caret)}${lead}@${draft.slice(caret)}`;
    onPick('', next);
    requestAnimationFrame(() => {
      el.focus();
      const c = caret + lead.length + 1;
      el.setSelectionRange(c, c);
      setAt({ start: c - 1, query: '' });
    });
  };

  const list = open ? (
    <ul
      id={listId}
      role="listbox"
      aria-label="Changed files"
      className="ax-mention-list"
      onMouseDown={(e) => e.preventDefault()}
    >
      {matches.map((f, i) => (
        <li
          key={f}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === active}
          className={cn('ax-mention-opt', i === active && 'ax-mention-opt-on')}
          onMouseEnter={() => setIndex(i)}
          onClick={() => pick(f)}
        >
          <span className="truncate font-mono text-xs text-foreground">{baseName(f)}</span>
          <span className="truncate text-2xs text-muted-foreground">{f}</span>
        </li>
      ))}
    </ul>
  ) : null;

  return {
    list,
    sync,
    close: () => setAt(null),
    onKeyDown,
    openFromButton,
    inputProps: {
      role: 'combobox' as const,
      'aria-expanded': open,
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open ? `${listId}-${active}` : undefined,
      'aria-autocomplete': 'list' as const,
    },
  };
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
  const [picked, setPicked] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const links = useContext(FileLinksContext);
  const mention = useMentionPicker({
    files: (links?.files ?? []).filter((f) => f !== file && !picked.includes(f)),
    draft,
    inputRef,
    onPick: (path, nextDraft) => {
      if (path) setPicked((prev) => (prev.includes(path) ? prev : [...prev, path].slice(0, 8)));
      setDraft(nextDraft);
    },
  });

  const ask = (question?: string, mentions: string[] = []) => {
    if (chat.isPending) return;
    chat.mutate(
      {
        source,
        file,
        mentions,
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
            ...(question
              ? [
                  {
                    role: 'user' as const,
                    text: question,
                    ...(mentions.length ? { mentions } : {}),
                  },
                ]
              : []),
            { role: 'assistant', generatedBy, ...out },
          ]),
        onError: () => {
          if (question) setDraft((current) => current || question);
          if (mentions.length) setPicked((current) => (current.length ? current : mentions));
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
    const m = picked;
    setPicked([]);
    ask(q, m);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const asked = chat.isPending ? chat.variables.question : undefined;
  const askedMentions = chat.isPending ? chat.variables.mentions : [];
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
              <UserBubble key={i} text={t.text} mentions={t.mentions ?? []} />
            ) : t.answer.trim() ? (
              <div key={i} className="grid gap-2">
                <Prose text={t.answer} />
                <GeneratedBy by={t.generatedBy} />
              </div>
            ) : (
              <Brief key={i} t={t} />
            ),
          )}
          {asked && <UserBubble text={asked} mentions={askedMentions} />}
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
        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Files this question is about">
            {picked.map((p) => (
              <span key={p} className="ax-mention" title={p}>
                <AtSign className="size-3 shrink-0 opacity-60" aria-hidden />
                <span className="truncate">{baseName(p)}</span>
                <button
                  type="button"
                  className="ax-mention-x"
                  aria-label={`Remove ${p}`}
                  onClick={() => setPicked((prev) => prev.filter((x) => x !== p))}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="relative flex items-end gap-2">
          {mention.list}
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onSelect={mention.sync}
            onBlur={mention.close}
            placeholder="Ask about this change… type @ to bring in another file"
            aria-label="Follow-up question"
            maxLength={2000}
            rows={1}
            className="max-h-32 min-h-10 resize-none bg-background"
            {...mention.inputProps}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Mention a changed file"
            title="Mention a changed file (@)"
            disabled={(links?.files.length ?? 0) < 2}
            onMouseDown={(e) => e.preventDefault()}
            onClick={mention.openFromButton}
          >
            <AtSign className="size-4" aria-hidden />
          </Button>
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
