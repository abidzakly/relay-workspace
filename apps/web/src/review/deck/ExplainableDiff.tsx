import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { DeckExplainRequest } from '@relay/shared';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useExplain } from '@/lib/deckApi';
import { cn } from '@/lib/utils';
import { HunkView, lineNo } from './HunkView';

type Scope = DeckExplainRequest['scope'];

/**
 * A diff with "Explain with AI": the whole hunk, every change of the file, or the lines the reader marked by tapping
 * the line numbers. Used on a hunk card (`hunkId` set) and in the full-file view (no `hunkId`).
 */
export function ExplainableDiff({
  deckId,
  aiReady,
  file,
  text,
  hunkId,
  className,
}: {
  deckId: string;
  aiReady: boolean;
  file: string;
  text: string;
  hunkId?: string;
  className?: string;
}) {
  const explain = useExplain(deckId);
  const [lines, setLines] = useState<ReadonlySet<number>>(new Set());
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<Scope>(hunkId ? 'hunk' : 'file');

  const toggle = (no: number) =>
    setLines((prev) => {
      const next = new Set(prev);
      if (next.has(no)) next.delete(no);
      else next.add(no);
      return next;
    });

  // Selecting lines is the strongest signal of what the reader wants explained.
  const effective: Scope = lines.size > 0 && scope !== 'file' ? 'selection' : scope;
  const run = () => {
    const q = question.trim();
    const base = q ? { question: q } : {};
    const req: DeckExplainRequest =
      effective === 'hunk' && hunkId
        ? { scope: 'hunk', hunkId, ...base }
        : effective === 'selection'
          ? { scope: 'selection', file, lines: [...lines].sort((a, b) => a - b), ...base }
          : { scope: 'file', file, ...base };
    explain.mutate(req);
  };

  const choices: { id: Scope; label: string; disabled?: boolean }[] = [
    ...(hunkId ? [{ id: 'hunk' as const, label: 'This hunk' }] : []),
    { id: 'file', label: 'Whole file' },
    {
      id: 'selection',
      label: `Selected lines${lines.size ? ` (${lines.size})` : ''}`,
      disabled: lines.size === 0,
    },
  ];

  return (
    <div className="grid gap-2">
      <HunkView
        path={file}
        text={text}
        selected={lines}
        onLine={(l) => {
          if (l.kind !== 'del') toggle(lineNo(l));
        }}
        className={className}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!aiReady}
          title={aiReady ? 'Explain this change with AI' : 'AI is not available'}
          onClick={() => setOpen((o) => !o)}
        >
          <Sparkles className="size-3.5" aria-hidden /> Explain with AI
        </Button>
        {lines.size > 0 && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setLines(new Set())}
          >
            Clear {lines.size} selected {lines.size === 1 ? 'line' : 'lines'}
          </button>
        )}
        {lines.size === 0 && (
          <span className="text-2xs text-muted-foreground">Tap line numbers to pick lines.</span>
        )}
      </div>

      {open && aiReady && (
        <div className="grid gap-2 rounded-surface border border-primary/30 bg-primary/5 p-3">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What to explain">
            {choices.map((c) => {
              const active = effective === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={c.disabled}
                  onClick={() => setScope(c.id)}
                  className={cn(
                    'rounded-control border px-2 py-1 text-xs disabled:opacity-40',
                    active
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Optional: what is unclear?"
            className="min-h-14"
          />
          <Button
            size="sm"
            className="justify-self-start"
            disabled={explain.isPending}
            onClick={run}
          >
            {explain.isPending ? (
              <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
            Explain
          </Button>
          {explain.isError && (
            <p className="text-sm text-destructive">{describeError(explain.error)}</p>
          )}
          {explain.data && (
            <div className="grid gap-2 text-sm">
              <p className="text-base font-semibold">{explain.data.tldr}</p>
              <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {explain.data.detail}
              </p>
              {explain.data.risks.length > 0 && (
                <ul className="grid list-disc gap-1 pl-5 text-warning">
                  {explain.data.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <GeneratedBy by={explain.data.generatedBy} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
