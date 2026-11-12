import { Mic, MicOff } from 'lucide-react';
import { useDictation } from '@/lib/useDictation';
import { cn } from '@/lib/utils';

/** Dictation toggle: appends what was said through `onText`. Hidden where the Web Speech API is missing. */
export function MicButton({
  onText,
  className,
}: {
  onText: (t: string) => void;
  className?: string;
}) {
  const d = useDictation(onText);
  if (!d.supported) return null;
  return (
    <button
      type="button"
      onClick={d.toggle}
      aria-pressed={d.listening}
      aria-label={d.listening ? 'Berhenti dikte' : 'Dikte suara'}
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-xl border transition-colors',
        d.listening
          ? 'border-terracotta bg-terracotta/15 text-emphasis motion-safe:animate-pulse'
          : 'text-muted-foreground hover:bg-accent',
        className,
      )}
    >
      {d.listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
    </button>
  );
}
