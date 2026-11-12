import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useExplain } from '@/lib/deckApi';
import { MicButton } from '@/components/MicButton';

/**
 * The back of a hunk card after "belum paham" (swipe left): Explain (TL;DR → detail → risks), then "Got it now"
 * or "Ask again" with a free question.
 */
export function CardBack({
  deckId,
  hunkId,
  onUnderstood,
  aiReady,
}: {
  deckId: string;
  hunkId: string;
  onUnderstood: () => void;
  aiReady: boolean;
}) {
  const explain = useExplain(deckId);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');

  const ask = (q?: string) => {
    explain.mutate({ scope: 'hunk', hunkId, ...(q ? { question: q } : {}) });
    setAsking(false);
    setQuestion('');
  };

  return (
    <div className="grid gap-3 rounded-surface border border-primary/30 bg-primary/5 p-3">
      {!explain.data && !explain.isPending && (
        <Button onClick={() => ask()} disabled={!aiReady} className="justify-self-start">
          <Sparkles className="size-4" /> Explain
        </Button>
      )}
      {!aiReady && (
        <p className="text-xs text-muted-foreground">
          AI is not available (Claude or Cursor CLI on this computer / ANTHROPIC_API_KEY). You can
          still continue.
        </p>
      )}
      {explain.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> Explaining…
        </p>
      )}
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
      {asking && (
        <div className="grid gap-2">
          <Textarea
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What is still unclear?"
            className="min-h-16"
          />
          <MicButton onText={(t) => setQuestion((prev) => (prev ? `${prev} ${t}` : t))} />
          <Button size="sm" disabled={!question.trim()} onClick={() => ask(question.trim())}>
            Send question
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="default" onClick={onUnderstood}>
          Got it now
        </Button>
        {explain.data && !asking && (
          <Button variant="outline" onClick={() => setAsking(true)} disabled={!aiReady}>
            Ask again
          </Button>
        )}
      </div>
    </div>
  );
}
