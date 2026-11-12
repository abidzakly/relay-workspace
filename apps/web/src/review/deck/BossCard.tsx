import { Check, Circle, Crown, Loader2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import type { DeckGradeResult, QuizCard } from '@relay/shared';
import { GeneratedBy } from '@/components/GeneratedBy';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { WIND_UP } from '@/lib/motion/patterns';
import { useGrade } from '@/lib/deckApi';
import { cn } from '@/lib/utils';
import { MicButton } from '@/components/MicButton';

/** Teach-back result: score 0–3 with what was missed and one correction. */
function Grade({ g }: { g: DeckGradeResult }) {
  return (
    <div className="grid gap-1 rounded-control border p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold">
        <span aria-label={`Score ${g.score} of 3`}>
          {[0, 1, 2].map((i) => (
            <Circle
              key={i}
              aria-hidden
              className={cn(
                'mr-0.5 inline size-3',
                i < g.score ? 'fill-current' : 'text-muted-foreground',
              )}
            />
          ))}
        </span>
        {g.score === 3 ? 'Correct!' : g.score === 2 ? 'Almost.' : 'Not quite.'}
      </p>
      {g.missed && <p className="text-muted-foreground">Missed: {g.missed}</p>}
      {g.correction && <p>{g.correction}</p>}
      <GeneratedBy by={g.generatedBy} />
    </div>
  );
}

function TeachBack({
  deckId,
  cardId,
  placeholder,
  onDone,
  aiReady,
}: {
  deckId: string;
  cardId: string;
  placeholder: string;
  onDone: (score: number | null) => void;
  aiReady: boolean;
}) {
  const grade = useGrade(deckId);
  const [answer, setAnswer] = useState('');
  return (
    <div className="grid gap-2">
      {!grade.data && (
        <>
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={placeholder}
            className="min-h-24"
            maxLength={4000}
          />
          <div className="flex flex-wrap gap-2">
            <MicButton onText={(t) => setAnswer((prev) => (prev ? `${prev} ${t}` : t))} />
            <Button
              disabled={!answer.trim() || grade.isPending || !aiReady}
              onClick={() => grade.mutate({ cardId, answer: answer.trim() })}
            >
              {grade.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              Grade my answer
            </Button>
            <Button variant="ghost" onClick={() => onDone(null)}>
              Skip
            </Button>
          </div>
        </>
      )}
      {grade.isError && <p className="text-sm text-destructive">{describeError(grade.error)}</p>}
      {grade.data && (
        <>
          <Grade g={grade.data} />
          <Button onClick={() => onDone(grade.data.score)}>Continue</Button>
        </>
      )}
    </div>
  );
}

/** A quiz card: multiple choice (instant check) or teach-back (graded by AI). */
export function QuizCardView({
  deckId,
  cardId,
  quiz,
  onDone,
  aiReady,
}: {
  deckId: string;
  cardId: string;
  quiz: QuizCard;
  onDone: (score: number | null) => void;
  aiReady: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const kind = { predict: 'Predict', why: 'Why', spot: 'Spot it' }[quiz.kind];
  return (
    <div className="grid gap-3 p-4">
      <p className="text-xs font-medium tracking-wide text-primary-ink uppercase">
        {kind} · <span className="font-mono normal-case">{quiz.file}</span>
      </p>
      <p className="text-lg leading-snug font-semibold">{quiz.question}</p>
      {quiz.choices.length > 0 ? (
        <div className="grid gap-2">
          {quiz.choices.map((c) => {
            const right = picked !== null && c === quiz.answer;
            const wrong = picked === c && c !== quiz.answer;
            return (
              <button
                key={c}
                type="button"
                disabled={picked !== null}
                onClick={() => setPicked(c)}
                className={cn(
                  'flex items-center gap-2 tactile rounded-control border px-3 py-2.5 text-left text-sm transition-colors',
                  picked === null && 'hover:bg-accent',
                  right && 'border-success bg-success/10',
                  wrong && 'border-destructive bg-destructive/10',
                )}
              >
                {right && <Check className="size-4 shrink-0 text-success" />}
                {wrong && <X className="size-4 shrink-0 text-destructive" />}
                {c}
              </button>
            );
          })}
          {picked !== null && (
            <>
              <p className="text-sm text-muted-foreground">{quiz.explanation}</p>
              <Button onClick={() => onDone(picked === quiz.answer ? 3 : 0)}>Continue</Button>
            </>
          )}
        </div>
      ) : (
        <TeachBack
          deckId={deckId}
          cardId={cardId}
          placeholder="Explain in your own words (1–2 sentences)…"
          onDone={onDone}
          aiReady={aiReady}
        />
      )}
    </div>
  );
}

/** The last card: one synthesis question about the whole change. */
export function BossCard({
  deckId,
  question,
  onDone,
  aiReady,
}: {
  deckId: string;
  question: string;
  onDone: (score: number | null) => void;
  aiReady: boolean;
}) {
  return (
    // The last card arrives like it matters. Its result stays a plain grade: scores earn no reward.
    <motion.div variants={WIND_UP} initial="hidden" animate="shown" className="grid gap-3 p-4">
      <p className="type-micro flex w-fit items-center gap-1.5 rounded-control bg-primary px-2 py-1 text-primary-foreground">
        <Crown aria-hidden className="size-3.5" /> Boss card
      </p>
      <p className="text-lg leading-snug font-semibold">{question}</p>
      <TeachBack
        deckId={deckId}
        cardId="boss"
        placeholder="The end-to-end flow as you see it…"
        onDone={onDone}
        aiReady={aiReady}
      />
    </motion.div>
  );
}
