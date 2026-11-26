import { Check, ClipboardCopy, Download, FileDown, FileText } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DocItem } from '@/lib/conversation';
import { FADE_RISE } from '@/lib/motion/patterns';
import { saveBlob } from '@/lib/saveFile';

/**
 * Export a chat session as markdown: the agent itself is asked to write it, because it holds the session's context.
 * A handoff is context for the next agent or session; a report is a summary for a person. The request is a normal
 * prompt whose first line is a marker, so the transcript (rebuilt from events on reload) still knows which reply is
 * the export.
 */

export type ExportMode = 'handoff' | 'report';

const MARKER: Record<ExportMode, string> = {
  handoff: '[Relay handoff]',
  report: '[Relay report]',
};

const LABEL: Record<ExportMode, { menu: string; chip: string; file: string }> = {
  handoff: { menu: 'Handoff for the next agent', chip: 'Handoff requested', file: 'handoff' },
  report: { menu: 'Report for a person', chip: 'Report requested', file: 'report' },
};

const RULES = [
  'Do not use tools and do not change any files. Answer from what you already know in this session.',
  'Reply with only the markdown document: no preamble, no closing remarks.',
  'Keep it short: plain sentences, one idea each, no filler. Use exact file paths, names and commands.',
  'Leave out a section when there is nothing for it.',
].join('\n');

const SECTIONS: Record<ExportMode, string> = {
  handoff: [
    'Write a handoff of this session so another agent can continue the work without this chat.',
    'Sections: # Handoff: <topic>, ## Goal, ## Current state, ## Decisions (with the reason),',
    '## Files touched, ## Next steps, ## Gotchas.',
  ].join('\n'),
  report: [
    'Write a report of this session for a person who was not in it.',
    'Sections: # Report: <topic>, ## Summary (2-3 sentences), ## What changed,',
    '## Verification (what was checked, what was not), ## Open items.',
  ].join('\n'),
};

export function exportPrompt(mode: ExportMode): string {
  return `${MARKER[mode]}\n${SECTIONS[mode]}\n\n${RULES}`;
}

/** The export a user message asked for, or null for an ordinary message. */
export function exportModeOf(text: string): ExportMode | null {
  const t = text.trimStart();
  if (t.startsWith(MARKER.handoff)) return 'handoff';
  if (t.startsWith(MARKER.report)) return 'report';
  return null;
}

/** The agent's words after the request at `userIndex`, up to the next user message. */
export function collectExport(items: readonly DocItem[], userIndex: number): string {
  const parts: string[] = [];
  for (let i = userIndex + 1; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'user') break;
    if (it.kind === 'text') parts.push(it.text.trim());
  }
  return parts.filter(Boolean).join('\n\n');
}

/** True once the reply to the request at `userIndex` is complete. */
export function exportDone(
  items: readonly DocItem[],
  userIndex: number,
  working: boolean,
): boolean {
  return !working || items.slice(userIndex + 1).some((it) => it.kind === 'user');
}

function fileName(mode: ExportMode, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const date = new Date().toISOString().slice(0, 10);
  return `${LABEL[mode].file}${slug ? `-${slug}` : ''}-${date}.md`;
}

/** The request in the transcript: a quiet chip instead of the long prompt. */
export function ExportRequestChip({ mode }: { mode: ExportMode }) {
  return (
    <p className="flex items-center gap-1.5 justify-self-end rounded-full bg-muted/60 px-3 py-1 text-sm text-muted-foreground">
      <FileText className="size-3.5" aria-hidden />
      {LABEL[mode].chip}
    </p>
  );
}

/** Under a finished export: copy it, or save it as a .md file. */
export function ExportCard({
  mode,
  markdown,
  title,
}: {
  mode: ExportMode;
  markdown: string;
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!markdown) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: the text stays selectable */
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm">
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {mode === 'handoff' ? 'Handoff ready' : 'Report ready'}
      </span>
      <Button size="sm" variant="outline" className="h-8" onClick={() => void copy()}>
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <ClipboardCopy className="size-3.5" aria-hidden />
        )}{' '}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-8"
        onClick={() =>
          saveBlob(new Blob([markdown], { type: 'text/markdown' }), fileName(mode, title))
        }
      >
        <Download className="size-3.5" aria-hidden /> Save .md
      </Button>
    </div>
  );
}

/** The header action: pick handoff or report, and the request goes to the agent. */
export function ExportMenu({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (mode: ExportMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="h-8 px-2"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export this chat as markdown"
        onClick={() => setOpen((v) => !v)}
      >
        <FileDown className="size-3.5" aria-hidden /> Export
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            variants={FADE_RISE}
            initial="hidden"
            animate="shown"
            exit="gone"
            className="absolute top-full right-0 z-30 mt-1.5 grid w-56 origin-top-right gap-0.5 rounded-sheet border border-hairline bg-popover p-1 shadow-float"
          >
            {(Object.keys(LABEL) as ExportMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onExport(mode);
                }}
                className="rounded-control px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                {LABEL[mode].menu}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
