import { Bot, Copy, Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import type { DeckHunk, DeckNote } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { HunkView, lineNo } from './HunkView';
import { MicButton } from '@/components/MicButton';

/**
 * "Bermasalah" (swipe up): tap the gutter to mark lines, write notes, then "Save for later" or
 * "Send to agent now" (request-change prompt → the workspace's agent session).
 * Rendered as a bottom sheet on phones.
 */
export function IssueSheet({
  hunk,
  open,
  onClose,
  onSave,
  canSend,
  sending,
}: {
  hunk: DeckHunk;
  open: boolean;
  onClose: () => void;
  onSave: (note: DeckNote, send: boolean) => void;
  canSend: boolean;
  sending: boolean;
}) {
  const [lines, setLines] = useState<Set<number>>(new Set());
  const [anchors, setAnchors] = useState<Map<number, string>>(new Map());
  const [text, setText] = useState('');

  const save = (send: boolean) => {
    const sorted = [...lines].sort((a, b) => a - b);
    onSave(
      {
        id: crypto.randomUUID(),
        file: hunk.file,
        hunkId: hunk.id,
        lines: sorted,
        text: text.trim(),
        status: 'saved',
        anchorText: sorted.length ? (anchors.get(sorted[0]!) ?? null) : null,
        createdAt: Date.now(),
      },
      send,
    );
    setLines(new Set());
    setText('');
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-auto bottom-0 max-h-[88dvh] max-w-none translate-y-0 rounded-t-sheet rounded-b-none p-4 sm:bottom-auto sm:top-1/2 sm:max-w-2xl sm:-translate-y-1/2 sm:rounded-sheet">
        <DialogHeader>
          <DialogTitle>Mark an issue</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{hunk.file}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Tap line numbers to mark them (optional).</p>
        <HunkView
          path={hunk.file}
          text={hunk.text}
          selected={lines}
          className="max-h-[38dvh] overflow-y-auto"
          onLine={(l) => {
            const no = lineNo(l);
            if (!no || l.kind === 'del') return;
            setLines((prev) => {
              const next = new Set(prev);
              if (next.has(no)) next.delete(no);
              else next.add(no);
              return next;
            });
            setAnchors((prev) => new Map(prev).set(no, l.text));
          }}
        />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What is wrong? What should change?"
          className="min-h-24"
          maxLength={4000}
        />
        <MicButton
          onText={(t) => setText((prev) => (prev ? `${prev} ${t}` : t))}
          className="justify-self-start"
        />
        {text.trim() && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => save(false)} disabled={sending}>
              <Save className="size-4" /> Save for later
            </Button>
            <Button onClick={() => save(true)} disabled={sending}>
              {sending ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : canSend ? (
                <Bot className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
              {canSend ? 'Send to the agent now' : 'Create a prompt for the agent'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
