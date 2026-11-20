import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  AtSign,
  MessagesSquare,
  Plus,
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
  type MrChatMessage,
  type ReviewAssistSource,
  type ReviewProposeResult,
} from '@relay/shared';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useBranchSummary, useMrChat } from '@/lib/mrCreateApi';
import { useExplainChat, useProposeChange } from '@/lib/reviewAssistApi';
import { cn } from '@/lib/utils';
import { useCoarsePointer, useNarrow } from '@/workspace/useMedia';

/** What the drawer shows: a file's Explain chat, or Propose changes for a file (`file`) or the whole branch (null). */
export type AssistTarget =
  | { kind: 'explain'; file: string }
  | { kind: 'explain-branch' }
  | { kind: 'propose'; files: string[]; chat?: ChatContext };

/** The Explain discussion a change starts from. */
export interface ChatContext {
  from: { kind: 'file'; file: string } | { kind: 'branch' };
  conversation: MrChatMessage[];
}

/** The branch "Explain branch" summarises: Create MR's view (`base` = what it is compared with). */
export interface AssistBranch {
  repo: string;
  branch: string;
  base?: string;
}

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
  branch,
  target,
  files,
  onJumpToFile,
  onTarget,
  onClose,
}: {
  source: ReviewAssistSource;
  /** For "Explain branch"; null hides it. */
  branch: AssistBranch | null;
  target: AssistTarget | null;
  /** Paths of the changed files. */
  files: readonly string[];
  onJumpToFile: (path: string) => void;
  /** Switches the drawer to another view (Explain → Propose and back). */
  onTarget: (t: AssistTarget) => void;
  onClose: () => void;
}) {
  const narrow = useNarrow();
  const [chats, setChats] = useState<ReadonlyMap<string, Turn[]>>(() => new Map());
  const [branchTurns, setBranchTurns] = useState<BranchTurn[]>([]);
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
            const listOpen =
              el?.getAttribute('role') === 'combobox' &&
              el.getAttribute('aria-expanded') === 'true';
            if (listOpen || el?.hasAttribute('data-esc-local')) e.preventDefault();
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
                onMakeChange={onTarget}
              />
            )}
            {shown?.kind === 'explain-branch' && branch && (
              <BranchExplainPane
                branch={branch}
                turns={branchTurns}
                setTurns={setBranchTurns}
                onMakeChange={onTarget}
              />
            )}
            {shown?.kind === 'propose' && (
              <ProposePane
                key={`${shown.files.join('\n')}|${shown.chat ? JSON.stringify(shown.chat.from) : ''}`}
                source={source}
                initialFiles={shown.files}
                chat={shown.chat}
                onBackToChat={(from) =>
                  onTarget(
                    from.kind === 'file'
                      ? { kind: 'explain', file: from.file }
                      : { kind: 'explain-branch' },
                  )
                }
              />
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
function Checklist({
  points,
  label = 'Before you approve',
}: {
  points: readonly string[];
  label?: string;
}) {
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  if (points.length === 0) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="ax-label flex items-center justify-between">
        {label}
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

/**
 * The follow-up box shared by the Explain panes: suggestion chips, optional @-mentions of other changed files, and
 * Enter to send. On a failed send, `restore` puts the question (and its files) back.
 */
function Composer({
  pending,
  suggestions,
  onAsk,
  mentionFiles,
  placeholder,
  actions,
}: {
  pending: boolean;
  suggestions: readonly string[];
  onAsk: (question: string, mentions: string[], restore: () => void) => void;
  /** Files that can be @-mentioned; absent = no mentions (the whole branch is already in view). */
  mentionFiles?: readonly string[];
  placeholder: string;
  /** Extra actions under the box (e.g. "Change this…"). */
  actions?: ReactNode;
}) {
  const touch = useCoarsePointer();
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canMention = (mentionFiles?.length ?? 0) > 0;
  const mention = useMentionPicker({
    files: (mentionFiles ?? []).filter((f) => !picked.includes(f)),
    draft,
    inputRef,
    onPick: (path, nextDraft) => {
      if (path) setPicked((prev) => (prev.includes(path) ? prev : [...prev, path].slice(0, 8)));
      setDraft(nextDraft);
    },
  });

  const ask = (q: string, m: string[]) => {
    if (pending) return;
    onAsk(q, m, () => {
      setDraft((current) => current || q);
      if (m.length) setPicked((current) => (current.length ? current : m));
    });
  };
  const send = () => {
    const q = draft.trim();
    if (!q || pending) return;
    setDraft('');
    const m = picked;
    setPicked([]);
    ask(q, m);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (canMention && mention.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const shown = pending ? [] : suggestions.slice(0, 3);

  return (
    <footer className="grid gap-2 border-t border-hairline px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
          {shown.map((q) => (
            <button key={q} type="button" className="ax-suggest" onClick={() => ask(q, [])}>
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
        {canMention && mention.list}
        <Textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          {...(canMention
            ? { onSelect: mention.sync, onBlur: mention.close, ...mention.inputProps }
            : {})}
          placeholder={placeholder}
          aria-label="Follow-up question"
          maxLength={2000}
          rows={1}
          className="max-h-32 min-h-10 resize-none bg-background"
        />
        {canMention && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Mention a changed file"
            title="Mention a changed file (@)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={mention.openFromButton}
          >
            <AtSign className="size-4" aria-hidden />
          </Button>
        )}
        <Button
          size="icon"
          aria-label="Send question"
          disabled={!draft.trim() || pending}
          onClick={send}
        >
          <SendHorizontal className="size-4" />
        </Button>
      </div>
      {actions}
    </footer>
  );
}

/** Under an Explain chat: turn what was learned into a change (Propose, with this chat attached). */
function MakeChangeAction({ onClick, hint }: { onClick: () => void; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-3 pt-0.5">
      <span className="min-w-0 truncate text-2xs text-muted-foreground">{hint}</span>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onClick}>
        <Wand2 className="size-3.5" aria-hidden /> Change this…
      </Button>
    </div>
  );
}

/** The scrolling conversation area; follows new turns to the bottom. */
function ChatScroll({
  count,
  pending,
  children,
}: {
  count: number;
  pending: boolean;
  children: ReactNode;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (count > 1 || pending) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [count, pending]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5">
      <div className="grid gap-6 text-sm leading-relaxed text-foreground/85" aria-live="polite">
        {children}
      </div>
      <div ref={endRef} />
    </div>
  );
}

function FailedFirst({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
      {describeError(error)}
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden /> Try again
        </Button>
      )}
    </div>
  );
}

const historyOf = (
  turns: readonly { role: 'user' | 'assistant' }[],
  text: (i: number) => string,
): MrChatMessage[] =>
  turns
    .slice(-MR_CHAT_MAX_HISTORY)
    .map((t, i, all) => ({
      role: t.role,
      text: text(turns.length - all.length + i).slice(0, MR_CHAT_MAX_MESSAGE),
    }))
    .filter((m) => m.text.trim());

function ExplainPane({
  source,
  file,
  turns,
  setTurns,
  onMakeChange,
}: {
  source: ReviewAssistSource;
  file: string;
  turns: Turn[];
  setTurns: (fn: (prev: Turn[]) => Turn[]) => void;
  onMakeChange: (t: AssistTarget) => void;
}) {
  const chat = useExplainChat();
  const links = useContext(FileLinksContext);

  const ask = (question?: string, mentions: string[] = [], restore?: () => void) => {
    if (chat.isPending) return;
    chat.mutate(
      {
        source,
        file,
        mentions,
        history: historyOf(turns, (i) => turnText(turns[i]!)),
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
        onError: () => restore?.(),
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

  const asked = chat.isPending ? chat.variables.question : undefined;
  const askedMentions = chat.isPending ? chat.variables.mentions : [];
  const lastAi = [...turns].reverse().find((t) => t.role === 'assistant');

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
      <ChatScroll count={turns.length} pending={chat.isPending}>
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
          <FailedFirst error={chat.error} onRetry={turns.length === 0 ? () => ask() : undefined} />
        )}
      </ChatScroll>
      <Composer
        pending={chat.isPending}
        suggestions={lastAi?.role === 'assistant' ? lastAi.followUps : []}
        onAsk={(q, m, restore) => ask(q, m, restore)}
        mentionFiles={(links?.files ?? []).filter((f) => f !== file)}
        placeholder="Ask about this change… type @ to bring in another file"
        actions={
          lastAi && (
            <MakeChangeAction
              hint="Learned something? Turn it into a change."
              onClick={() => {
                const mentioned = turns.flatMap((t) =>
                  t.role === 'user' ? (t.mentions ?? []) : [],
                );
                onMakeChange({
                  kind: 'propose',
                  files: [...new Set([file, ...mentioned])],
                  chat: {
                    from: { kind: 'file', file },
                    conversation: historyOf(turns, (i) => turnText(turns[i]!)),
                  },
                });
              }}
            />
          )
        }
      />
    </>
  );
}

/** A turn of the whole-branch chat (Create MR's `mr-chat`). */
export type BranchTurn =
  { role: 'user'; text: string } | { role: 'assistant'; text: string; generatedBy: AiGeneratedBy };

/**
 * "Explain branch": Create MR's AI summary of the branch, then a chat about it. Same templates, model choice and AI
 * cache as Create MR, so a branch summarised there opens here at once (and the other way round).
 */
function BranchExplainPane({
  branch,
  turns,
  setTurns,
  onMakeChange,
}: {
  branch: AssistBranch;
  turns: BranchTurn[];
  setTurns: (fn: (prev: BranchTurn[]) => BranchTurn[]) => void;
  onMakeChange: (t: AssistTarget) => void;
}) {
  const summary = useBranchSummary(branch.repo, branch.branch, branch.base);
  const chat = useMrChat();
  const s = summary.data;

  const ask = (question: string, restore: () => void) => {
    if (!s || chat.isPending) return;
    chat.mutate(
      {
        repo: branch.repo,
        branch: branch.branch,
        ...(branch.base ? { base: branch.base } : {}),
        summary: { summary: s.summary, bullets: s.bullets, risks: s.risks },
        history: historyOf(turns, (i) => turns[i]!.text),
        question,
      },
      {
        onSuccess: ({ answer, generatedBy }) =>
          setTurns((prev) => [
            ...prev,
            { role: 'user', text: question },
            { role: 'assistant', text: answer, generatedBy },
          ]),
        onError: restore,
      },
    );
  };
  const asked = chat.isPending ? chat.variables.question : undefined;

  return (
    <>
      <PaneHeader
        icon={<Sparkles className="size-3.5" aria-hidden />}
        title={
          <>
            What <span className="font-mono text-[0.8125rem]">{branch.branch}</span> does
          </>
        }
        file={null}
      />
      <ChatScroll count={turns.length} pending={chat.isPending}>
        {summary.isPending && <Thinking first />}
        {summary.error && (
          <FailedFirst error={summary.error} onRetry={() => void summary.refetch()} />
        )}
        {s && (
          <article className="grid gap-5">
            <p className="text-[0.9375rem] leading-relaxed font-medium text-pretty text-foreground">
              <Inline text={s.summary} />
            </p>
            <Section label="Main changes" points={s.bullets} />
            <Checklist label="Before you merge" points={s.risks} />
            <GeneratedBy by={s.generatedBy} />
          </article>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <UserBubble key={i} text={t.text} mentions={[]} />
          ) : (
            <div key={i} className="grid gap-2">
              <Prose text={t.text} />
              <GeneratedBy by={t.generatedBy} />
            </div>
          ),
        )}
        {asked && <UserBubble text={asked} mentions={[]} />}
        {chat.isPending && <Thinking first={false} />}
        {chat.error && <FailedFirst error={chat.error} />}
      </ChatScroll>
      <Composer
        pending={chat.isPending || !s}
        suggestions={[]}
        onAsk={(q, _m, restore) => ask(q, restore)}
        placeholder="Ask about this branch…"
        actions={
          s && (
            <MakeChangeAction
              hint="Rework the branch based on this?"
              onClick={() => {
                const brief = [
                  s.summary,
                  ...s.bullets.map((b) => `- ${b}`),
                  ...(s.risks.length ? ['Risks:', ...s.risks.map((r) => `- ${r}`)] : []),
                ].join('\n');
                onMakeChange({
                  kind: 'propose',
                  files: [],
                  chat: {
                    from: { kind: 'branch' },
                    conversation: [
                      { role: 'assistant' as const, text: brief.slice(0, MR_CHAT_MAX_MESSAGE) },
                      ...historyOf(turns, (i) => turns[i]!.text),
                    ].slice(-MR_CHAT_MAX_HISTORY),
                  },
                });
              }}
            />
          )
        }
      />
    </>
  );
}

/** "+ Add file": a filterable list of the changed files not picked yet. */
function AddFile({ files, onAdd }: { files: readonly string[]; onAdd: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const listId = useId();
  const shown = files.filter((f) => f.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  if (files.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        className="ax-suggest"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus className="size-3" aria-hidden /> Add file
      </button>
      {open && (
        <div className="ax-mention-list top-[calc(100%+0.4rem)] bottom-auto w-[min(22rem,80vw)]">
          <input
            autoFocus
            data-esc-local
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
              if (e.key === 'Enter' && shown[0]) {
                e.preventDefault();
                onAdd(shown[0]);
                setQ('');
              }
            }}
            placeholder="Filter changed files"
            aria-label="Filter changed files"
            className="mb-1 h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <ul id={listId} role="listbox" aria-label="Changed files" className="grid gap-px">
            {shown.map((f) => (
              <li
                key={f}
                role="option"
                aria-selected={false}
                className="ax-mention-opt hover:bg-muted"
                onClick={() => {
                  onAdd(f);
                  setQ('');
                }}
              >
                <span className="truncate font-mono text-xs text-foreground">{baseName(f)}</span>
                <span className="truncate text-2xs text-muted-foreground">{f}</span>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">No matching file.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProposePane({
  source,
  initialFiles,
  chat,
  onBackToChat,
}: {
  source: ReviewAssistSource;
  initialFiles: readonly string[];
  /** The Explain discussion this change starts from, if any. */
  chat: ChatContext | undefined;
  onBackToChat: (from: ChatContext['from']) => void;
}) {
  const links = useContext(FileLinksContext);
  const propose = useProposeChange();
  const [scope, setScope] = useState<'files' | 'branch'>(initialFiles.length ? 'files' : 'branch');
  const [files, setFiles] = useState<string[]>(() => [...initialFiles]);
  const [useChat, setUseChat] = useState(Boolean(chat));
  const [request, setRequest] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<ReviewProposeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = propose.isPending;
  const sending = pending && propose.variables.send;
  const conversation = useChat && chat ? chat.conversation : [];
  const canWrite =
    (request.trim().length > 0 || conversation.length > 0) &&
    (scope === 'branch' || files.length > 0);

  const base = () => ({
    source,
    scope,
    files: scope === 'files' ? files : [],
    request: request.trim(),
    conversation,
  });

  const write = () => {
    if (!canWrite || pending) return;
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

  const fromLabel = chat?.from.kind === 'file' ? `${baseName(chat.from.file)} chat` : 'branch chat';
  const answers = chat ? chat.conversation.filter((m) => m.role === 'assistant').length : 0;

  return (
    <>
      <PaneHeader
        icon={<Wand2 className="size-3.5" aria-hidden />}
        title="Propose changes"
        file={scope === 'files' && files.length === 1 ? files[0]! : null}
      />
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-5 text-sm sm:px-5">
        {chat && (
          <div className={cn('ax-from', !useChat && 'ax-from-off')}>
            <MessagesSquare className="size-4 shrink-0 opacity-70" aria-hidden />
            <div className="grid min-w-0 flex-1">
              <span className="truncate text-xs font-medium text-foreground">
                {useChat ? 'Using your' : 'Not using your'} {fromLabel}
              </span>
              <span className="text-2xs text-muted-foreground">
                {chat.conversation.length} messages · {answers} AI{' '}
                {answers === 1 ? 'answer' : 'answers'}
              </span>
            </div>
            <button type="button" className="ax-link" onClick={() => onBackToChat(chat.from)}>
              <ArrowLeft className="size-3" aria-hidden /> Back to chat
            </button>
            <button
              type="button"
              className="ax-link"
              aria-pressed={useChat}
              onClick={() => setUseChat((u) => !u)}
            >
              {useChat ? 'Detach' : 'Attach'}
            </button>
          </div>
        )}

        <section className="grid gap-2">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Scope">
            {(
              [
                {
                  id: 'files',
                  label: files.length > 1 ? `These ${files.length} files` : 'These files',
                },
                { id: 'branch', label: 'Whole branch' },
              ] as const
            ).map((c) => (
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
          {scope === 'files' ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {files.map((f) => (
                <span key={f} className="ax-mention" title={f}>
                  <button
                    type="button"
                    className="truncate hover:underline"
                    onClick={() => links?.jump(f)}
                    title={`Show ${f} in the diff`}
                  >
                    {baseName(f)}
                  </button>
                  <button
                    type="button"
                    className="ax-mention-x"
                    aria-label={`Remove ${f}`}
                    onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <AddFile
                files={(links?.files ?? []).filter((f) => !files.includes(f))}
                onAdd={(f) => setFiles((prev) => (prev.includes(f) ? prev : [...prev, f]))}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              The agent may touch any file on the branch, e.g. for a refactor of how the logic
              works.
            </p>
          )}
        </section>

        <label className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            What should change?{conversation.length > 0 && ' (optional)'}
          </span>
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={
              conversation.length > 0
                ? 'Leave empty to apply what you concluded in the chat, or add details.'
                : scope === 'files'
                  ? 'e.g. Handle the empty list before mapping, and log the failure instead of swallowing it.'
                  : 'e.g. Move the trail state into one place and drop the duplicated flags.'
            }
            maxLength={8000}
            className="min-h-24 bg-background"
          />
        </label>
        <Button
          size="sm"
          variant={prompt ? 'outline' : 'default'}
          className="justify-self-start"
          disabled={!canWrite || pending}
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
