import { ChevronDown, FileText, Loader2, Paperclip, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { parseFigmaUrl, type CardStartAttachment } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { toBase64 } from '@/lib/base64';
import { cn } from '@/lib/utils';
import { useCardContent } from '@/lib/workflowApi';

export const BRIEF_FILES_MAX = 10;
export const BRIEF_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const BRIEF_PROMPT_MAX = 8_000;

export interface BriefFile {
  id: string;
  file: File;
  /** Object URL for an image thumbnail. */
  preview: string | null;
}

export interface Brief {
  extraPrompt: string;
  /** Figma node links (space or newline separated), on top of the card's own. */
  figmaUrl: string;
  files: BriefFile[];
}

export const EMPTY_BRIEF: Brief = { extraPrompt: '', figmaUrl: '', files: [] };

/** Why the typed Figma links cannot be used, or null. A link must point at a node: a whole file is too big. */
export function figmaLinkProblem(text: string): string | null {
  const links = text.split(/\s+/).filter(Boolean);
  for (const l of links) {
    const p = parseFigmaUrl(l);
    if (!p) return `Not a Figma design link: ${l.slice(0, 60)}`;
    if (!p.nodeId) {
      return 'This link has no node. In Figma, select the frame and use Copy link to selection.';
    }
  }
  return null;
}

/** The files as the API takes them. Pasted screenshots come without a useful name. */
export async function briefAttachments(
  files: readonly BriefFile[],
): Promise<CardStartAttachment[]> {
  return Promise.all(
    files.map(async (f, n) => ({
      name: f.file.name && f.file.name !== 'image.png' ? f.file.name : `pasted-${n + 1}.png`,
      dataBase64: await toBase64(f.file),
    })),
  );
}

const sizeLabel = (b: number) =>
  b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(b / 1024))} KB`;

/**
 * What the agent gets on top of the card title: a preview of the card body it will read (whole body, parent card as
 * background, embedded images), the user's own instructions, and files to open (paste, drop or pick).
 */
export function CardBrief({
  cardId,
  value,
  onChange,
  disabled,
}: {
  cardId: string | null;
  value: Brief;
  onChange: (b: Brief) => void;
  disabled?: boolean;
}) {
  const content = useCardContent(cardId);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;

  // Thumbnails are object URLs: released when the dialog unmounts.
  useEffect(
    () => () => {
      for (const f of latest.current.files) if (f.preview) URL.revokeObjectURL(f.preview);
    },
    [],
  );

  const add = (list: Iterable<File>) => {
    const files = [...value.files];
    const problems: string[] = [];
    for (const file of list) {
      if (files.length >= BRIEF_FILES_MAX) {
        problems.push(`At most ${BRIEF_FILES_MAX} files.`);
        break;
      }
      if (file.size > BRIEF_FILE_MAX_BYTES) {
        problems.push(`${file.name || 'The pasted file'} is over 5 MB.`);
        continue;
      }
      if (file.size === 0) continue;
      files.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        file,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    }
    setError(problems.length > 0 ? problems.join(' ') : null);
    onChange({ ...value, files });
  };

  const remove = (id: string) => {
    const f = value.files.find((x) => x.id === id);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    onChange({ ...value, files: value.files.filter((x) => x.id !== id) });
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    add(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) add(e.dataTransfer.files);
  };

  const c = content.data;
  const figmaProblem = figmaLinkProblem(value.figmaUrl);
  return (
    <div className="grid gap-3" onPaste={onPaste}>
      <section className="rounded-surface border border-hairline">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          disabled={!cardId}
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">What the agent reads</span>
            <span className="block text-xs text-muted-foreground">
              {!cardId
                ? 'Pick a card first.'
                : content.isPending
                  ? 'Reading the card from Notion…'
                  : content.error
                    ? 'Could not read the card. The agent gets the title and the Notion link.'
                    : c
                      ? [
                          c.chars > 0 ? `${c.chars.toLocaleString()} chars` : 'Empty body',
                          c.imageCount > 0 &&
                            `${c.imageCount} image${c.imageCount === 1 ? '' : 's'}`,
                          c.fileCount > 0 && `${c.fileCount} file${c.fileCount === 1 ? '' : 's'}`,
                          c.parent && `parent: ${c.parent.title}`,
                          c.truncated && 'cut to fit',
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : ''}
            </span>
          </span>
          {content.isPending && cardId ? (
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          ) : (
            <ChevronDown
              className={cn('size-4 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          )}
        </button>
        {open && cardId && (
          <div className="grid gap-2 border-t border-hairline px-3 py-2">
            {content.error && (
              <p className="text-xs text-destructive">{describeError(content.error)}</p>
            )}
            {c && (
              <>
                <pre className="max-h-48 overflow-y-auto font-mono text-2xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                  {c.excerpt || '(empty)'}
                  {c.chars > c.excerpt.length ? '\n…' : ''}
                </pre>
                {c.parentError && (
                  <p className="text-xs text-muted-foreground">
                    Parent card unreadable: {c.parentError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  The agent gets the whole body, the parent card as background, and the card images
                  as files. It lists the requirements it derived before its plan.
                </p>
              </>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 justify-self-start text-xs"
              disabled={content.isFetching}
              onClick={() => void content.refetch()}
            >
              <RefreshCw
                className={cn('size-3.5', content.isFetching && 'motion-safe:animate-spin')}
                aria-hidden
              />
              Re-read
            </Button>
          </div>
        )}
      </section>

      <label className="grid gap-1 text-xs text-muted-foreground">
        Your instructions (optional)
        <Textarea
          value={value.extraPrompt}
          maxLength={BRIEF_PROMPT_MAX}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, extraPrompt: e.target.value })}
          placeholder="Context the card does not say: scope limits, where to look, what to avoid…"
          className="min-h-24 text-sm text-foreground"
        />
      </label>

      <label className="grid gap-1 text-xs text-muted-foreground">
        Figma link (optional)
        <Input
          value={value.figmaUrl}
          maxLength={4_000}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, figmaUrl: e.target.value })}
          placeholder="https://www.figma.com/design/…?node-id=12-34"
          aria-invalid={!!figmaProblem}
          className="text-sm text-foreground"
        />
        {figmaProblem ? (
          <span className="text-destructive">{figmaProblem}</span>
        ) : (
          <span>
            The agent gets every layer's properties and a render, read from the Figma plugin and
            kept for this card until its MR is merged. Figma links in the card are included too.
          </span>
        )}
      </label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'grid gap-2 rounded-surface border border-dashed px-3 py-2',
          dragging ? 'border-foreground bg-accent/50' : 'border-hairline',
        )}
      >
        <div className="flex items-center gap-2">
          <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            Drop, paste or pick files (images, PDF, logs). {BRIEF_FILES_MAX} max, 5 MB each.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={disabled || value.files.length >= BRIEF_FILES_MAX}
            onClick={() => input.current?.click()}
          >
            Add files
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) add(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {value.files.length > 0 && (
          <ul className="grid gap-1">
            {value.files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2 border-t border-hairline pt-1 first:border-t-0 first:pt-0"
              >
                {f.preview ? (
                  <img
                    src={f.preview}
                    alt=""
                    className="size-8 shrink-0 rounded-control border border-hairline object-cover"
                  />
                ) : (
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-xs">
                  {f.file.name || 'Pasted image'}
                </span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {sizeLabel(f.file.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name || 'pasted image'}`}
                  className="rounded-control p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  disabled={disabled}
                  onClick={() => remove(f.id)}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
