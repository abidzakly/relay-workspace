import { useQueryClient } from '@tanstack/react-query';
import {
  Bold,
  Code,
  GitMerge,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Plus,
  Strikethrough,
  Table,
  TextQuote,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { UPLOAD_IMAGE_MAX_BYTES, UPLOAD_IMAGE_TYPES, type MrInbox } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { Avatar } from '@/components/mr/Avatar';
import { describeError } from '@/lib/api';
import {
  codeBlock,
  DETAILS_BLOCK,
  insertBlock,
  link,
  MERMAID_BLOCK,
  PLANTUML_BLOCK,
  prefixLines,
  safeFilename,
  TABLE_BLOCK,
  TOC_BLOCK,
  triggerAt,
  wrap,
  type Edit,
  type Sel,
} from '@/lib/composerEdit';
import { FADE_RISE } from '@/lib/motion/patterns';
import { mrKeys, useUpload } from '@/lib/mrApi';
import { IS_MAC } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const SEND_HINT = IS_MAC ? '⌘↵ to send' : 'Ctrl+Enter to send';
const IMAGE_TYPES: readonly string[] = UPLOAD_IMAGE_TYPES;

export interface Person {
  username: string;
  name: string | null;
  avatar?: string | null;
}

type Tool = { label: string; icon: LucideIcon; keys?: string; run: (v: string, s: Sel) => Edit };

const TOOLS: Tool[][] = [
  [
    {
      label: 'Bold',
      icon: Bold,
      keys: `${MOD}B`,
      run: (v, s) => wrap(v, s, '**', '**', 'bold text'),
    },
    {
      label: 'Italic',
      icon: Italic,
      keys: `${MOD}I`,
      run: (v, s) => wrap(v, s, '_', '_', 'italic text'),
    },
    { label: 'Strikethrough', icon: Strikethrough, run: (v, s) => wrap(v, s, '~~', '~~', 'text') },
  ],
  [
    { label: 'Quote', icon: TextQuote, run: (v, s) => prefixLines(v, s, '> ') },
    { label: 'Inline code', icon: Code, run: (v, s) => wrap(v, s, '`', '`', 'code') },
    { label: 'Link', icon: Link2, keys: `${MOD}K`, run: link },
  ],
  [
    { label: 'Bulleted list', icon: List, run: (v, s) => prefixLines(v, s, '- ') },
    {
      label: 'Numbered list',
      icon: ListOrdered,
      run: (v, s) => prefixLines(v, s, (i) => `${i + 1}. `),
    },
    { label: 'Task list', icon: ListChecks, run: (v, s) => prefixLines(v, s, '- [ ] ') },
  ],
  [{ label: 'Table', icon: Table, run: (v, s) => insertBlock(v, s, TABLE_BLOCK, [2, 8]) }],
];

/** The "+" menu, GitLab's "More options". */
const MORE: { label: string; run: (v: string, s: Sel) => Edit }[] = [
  { label: 'Code block', run: (v, s) => codeBlock(v, s) },
  { label: 'Details block', run: (v, s) => insertBlock(v, s, DETAILS_BLOCK, 46) },
  { label: 'Horizontal rule', run: (v, s) => insertBlock(v, s, '---', 3) },
  { label: 'Mermaid diagram', run: (v, s) => insertBlock(v, s, MERMAID_BLOCK, 11) },
  { label: 'PlantUML diagram', run: (v, s) => insertBlock(v, s, PLANTUML_BLOCK, 12) },
  { label: 'Table of contents', run: (v, s) => insertBlock(v, s, TOC_BLOCK, TOC_BLOCK.length) },
];

/**
 * Apply an edit through the browser's own editing so Undo still works, then set the selection. Falls back to a
 * plain value change where `insertText` is not supported.
 */
function applyEdit(el: HTMLTextAreaElement, e: Edit, setValue: (v: string) => void) {
  el.focus();
  el.setSelectionRange(e.from, e.to);
  // `execCommand` is deprecated but still the only way to keep the textarea's undo stack.
  const ok = document.execCommand?.('insertText', false, e.text);
  if (!ok) {
    const v = el.value.slice(0, e.from) + e.text + el.value.slice(e.to);
    setValue(v);
  }
  requestAnimationFrame(() => el.setSelectionRange(e.selStart, e.selEnd));
}

interface Suggestion {
  key: string;
  insert: string;
  primary: string;
  secondary: string | null;
  person?: Person;
}

/**
 * GitLab-style markdown comment box: Write / Preview, a formatting toolbar with a "+" menu, images by button,
 * paste or drop (uploaded to GitLab, audited), and `@` / `!` autocomplete. Plain markdown underneath, like GitLab's
 * plain-text mode; the caller decides what Send does.
 */
export function Composer({
  repo,
  iid,
  people = [],
  placeholder,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  autoFocus,
  className,
}: {
  repo: string;
  iid: number;
  people?: readonly Person[];
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: string, done: () => void) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [more, setMore] = useState(false);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<ReturnType<typeof triggerAt>>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const upload = useUpload(repo, iid);
  const qc = useQueryClient();
  const uploading = upload.isPending;

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Grow with the text, up to a cap; the box then scrolls.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, [text, tab]);

  useEffect(() => {
    if (!more) return;
    const close = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [more]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === '@') {
      return people
        .filter((p) => p.username.toLowerCase().includes(q) || p.name?.toLowerCase().includes(q))
        .slice(0, 6)
        .map((p) => ({
          key: p.username,
          insert: `@${p.username} `,
          primary: p.name ?? `@${p.username}`,
          secondary: p.name ? `@${p.username}` : null,
          person: p,
        }));
    }
    // `!`: MRs of this repo the inbox already knows (any of its cached filters), newest first.
    const seen = new Map<number, string>();
    for (const [, data] of qc.getQueriesData<MrInbox>({ queryKey: mrKeys.inboxRoot })) {
      for (const m of data?.items ?? []) {
        if (m.repoId === repo && m.iid !== iid) seen.set(m.iid, m.title);
      }
    }
    return [...seen]
      .filter(([n, title]) => String(n).startsWith(q) || (q === '' && title))
      .sort((a, b) => b[0] - a[0])
      .slice(0, 6)
      .map(([n, title]) => ({
        key: String(n),
        insert: `!${n} `,
        primary: `!${n}`,
        secondary: title,
      }));
  }, [trigger, people, qc, repo, iid]);
  const open = tab === 'write' && suggestions.length > 0;

  const sel = (): Sel => {
    const el = ref.current!;
    return { start: el.selectionStart, end: el.selectionEnd };
  };
  const run = (fn: (v: string, s: Sel) => Edit) => {
    const el = ref.current;
    if (!el) return;
    setTab('write');
    applyEdit(el, fn(el.value, sel()), setText);
  };

  const pick = (s: Suggestion) => {
    const el = ref.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart;
    const e: Edit = {
      from: trigger.from,
      to: caret,
      text: s.insert,
      selStart: trigger.from + s.insert.length,
      selEnd: trigger.from + s.insert.length,
    };
    applyEdit(el, e, setText);
    setTrigger(null);
  };

  const addImages = (files: readonly File[]) => {
    const el = ref.current;
    if (!el) return;
    for (const f of files) {
      if (!IMAGE_TYPES.includes(f.type)) {
        setNote(`${f.name || 'That file'} is not a PNG, JPEG, GIF or WebP image.`);
        continue;
      }
      if (f.size > UPLOAD_IMAGE_MAX_BYTES) {
        setNote(`${f.name || 'That image'} is larger than 5 MB.`);
        continue;
      }
      const filename = safeFilename(f.name || 'pasted', f.type);
      const marker = `![Uploading ${filename}…]()`;
      const s = sel();
      applyEdit(
        el,
        insertBlock(el.value, { start: s.end, end: s.end }, marker, marker.length),
        setText,
      );
      setNote(null);
      upload.mutate(
        { filename, type: f.type, file: f },
        {
          onSuccess: (r) => {
            const md = r.markdown ?? '';
            setText((v) => v.replace(marker, md));
            if (r.dryRun) setNote('Dry-run: the image was not uploaded (logged in the audit log).');
          },
          onError: () => setText((v) => v.replace(marker, '')),
        },
      );
    }
  };

  const send = () => {
    const body = text.trim();
    if (!body || pending || uploading) return;
    onSubmit(body, () => {
      setText('');
      setTab('write');
      setNote(null);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestions.length;
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[Math.min(active, suggestions.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (mod && !e.shiftKey && !e.altKey && ['b', 'i', 'k'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      run(TOOLS.flat().find((t) => t.keys === `${MOD}${k.toUpperCase()}`)!.run);
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  const syncTrigger = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setTrigger(null);
    const t = triggerAt(el.value, el.selectionStart);
    setTrigger(t);
    setActive(0);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addImages(files);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDrag(false);
    const files = [...e.dataTransfer.files];
    if (files.length) {
      e.preventDefault();
      addImages(files);
    }
  };

  const toolBtn =
    'inline-flex size-8 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97] disabled:opacity-40';

  return (
    <div className={cn('grid min-w-0 gap-2', className)}>
      <div
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
        }}
        onDrop={onDrop}
        className={cn(
          'relative min-w-0 rounded-control border border-input bg-card/60 transition-[border-color,box-shadow] duration-150 focus-within:border-foreground focus-within:ring-1 focus-within:ring-ring',
          drag && 'border-dashed border-foreground ring-1 ring-ring',
        )}
      >
        {/* Toolbar: Write / Preview, then the formatting groups. Scrolls sideways on a phone. */}
        <div className="flex min-w-0 items-center gap-1 border-b border-hairline px-1.5 py-1">
          <div role="tablist" aria-label="Comment mode" className="flex shrink-0 items-center">
            {(['write', 'preview'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  'relative h-8 px-2.5 text-micro font-semibold tracking-[0.06em] uppercase transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  tab === t ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
                {tab === t && (
                  <motion.span
                    layoutId={`${listId}-tab`}
                    className="absolute inset-x-2 -bottom-1 h-px bg-foreground"
                    transition={{ type: 'spring', visualDuration: 0.28, bounce: 0 }}
                  />
                )}
              </button>
            ))}
          </div>
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-hairline" />
          <div
            role="toolbar"
            aria-label="Formatting"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            {TOOLS.map((group, gi) => (
              <div key={gi} className="flex shrink-0 items-center gap-0.5">
                {gi > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-hairline" />}
                {group.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    className={toolBtn}
                    title={t.keys ? `${t.label} (${t.keys})` : t.label}
                    aria-label={t.label}
                    disabled={pending}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(t.run)}
                  >
                    <t.icon className="size-4" aria-hidden />
                  </button>
                ))}
              </div>
            ))}
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hairline" />
            <button
              type="button"
              className={toolBtn}
              title="Attach an image (or paste / drop one)"
              aria-label="Attach an image"
              disabled={pending}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-4" aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={UPLOAD_IMAGE_TYPES.join(',')}
              multiple
              hidden
              onChange={(e) => {
                addImages([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>
          <div ref={moreRef} className="relative shrink-0">
            <button
              type="button"
              className={cn(toolBtn, 'w-auto gap-0.5 px-1.5', more && 'bg-accent text-foreground')}
              title="More options"
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={more}
              disabled={pending}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMore((m) => !m)}
            >
              <Plus className="size-4" aria-hidden />
            </button>
            <AnimatePresence>
              {more && (
                <motion.div
                  role="menu"
                  variants={FADE_RISE}
                  initial="hidden"
                  animate="shown"
                  exit="gone"
                  className="absolute top-full right-0 z-30 mt-1.5 grid w-52 origin-top-right gap-0.5 rounded-sheet border border-hairline bg-popover p-1 shadow-float"
                >
                  {MORE.map((m) => (
                    <button
                      key={m.label}
                      type="button"
                      role="menuitem"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setMore(false);
                        run(m.run);
                      }}
                      className="rounded-control px-2.5 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {m.label}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {tab === 'write' ? (
          <div className="relative">
            <textarea
              ref={ref}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                requestAnimationFrame(syncTrigger);
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => {
                if (
                  e.key === 'ArrowLeft' ||
                  e.key === 'ArrowRight' ||
                  e.key === 'Home' ||
                  e.key === 'End'
                )
                  syncTrigger();
              }}
              onClick={syncTrigger}
              onBlur={() => setTimeout(() => setTrigger(null), 120)}
              onPaste={onPaste}
              placeholder={placeholder}
              aria-label={placeholder}
              disabled={pending}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open ? `${listId}-${active}` : undefined}
              className="block max-h-[420px] min-h-24 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            <AnimatePresence>
              {open && (
                <motion.ul
                  id={listId}
                  role="listbox"
                  aria-label={trigger?.kind === '@' ? 'People' : 'Merge requests'}
                  variants={FADE_RISE}
                  initial="hidden"
                  animate="shown"
                  exit="gone"
                  className="absolute top-full left-2 z-30 -mt-1 grid w-[min(20rem,calc(100%-1rem))] gap-0.5 rounded-sheet border border-hairline bg-popover p-1 shadow-float"
                >
                  {suggestions.map((s, i) => (
                    <li
                      key={s.key}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(s);
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={cn(
                        'flex min-w-0 cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm',
                        i === active && 'bg-accent',
                      )}
                    >
                      {s.person ? (
                        <Avatar
                          name={s.person.name ?? s.person.username}
                          src={s.person.avatar}
                          size="sm"
                        />
                      ) : (
                        <GitMerge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="shrink-0 font-medium">{s.primary}</span>
                      {s.secondary && (
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {s.secondary}
                        </span>
                      )}
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="min-h-24 px-3 py-2.5">
            {text.trim() ? (
              <Markdown source={text} repo={repo} />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to preview.</p>
            )}
          </div>
        )}

        {drag && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-control bg-background/70 text-micro font-semibold tracking-[0.06em] uppercase">
            Drop the image to attach it
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {uploading ? 'Uploading image…' : `Markdown · paste or drop images · ${SEND_HINT}`}
        </span>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={pending || uploading || !text.trim()}
          onClick={send}
        >
          {pending ? 'Sending…' : submitLabel}
        </Button>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {[upload.error, error].map(
        (e, i) =>
          e != null && (
            <Alert key={i} variant="destructive">
              <AlertTitle>{i === 0 ? 'Image upload failed' : 'Sending failed'}</AlertTitle>
              <AlertDescription>{describeError(e)}</AlertDescription>
            </Alert>
          ),
      )}
    </div>
  );
}
