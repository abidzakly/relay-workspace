import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface WizardStep<K extends string> {
  key: K;
  label: string;
  /** Can the person move past this step. */
  done: boolean;
}

/**
 * A wizard inside a dialog: a row of numbered steps, the current step's body, and Back / Continue. A step is
 * reachable once every earlier one is done. `free` (editing a saved thing) makes every step reachable, like tabs,
 * and shows `finish` on every step, since nothing is missing.
 */
export function StepDialog<K extends string>({
  steps,
  at,
  onAt,
  free = false,
  finish,
  status,
  children,
}: {
  steps: WizardStep<K>[];
  at: number;
  onAt: (i: number) => void;
  free?: boolean;
  /** The last step's button (Add, Save). */
  finish: ReactNode;
  /** A line next to the buttons: what is missing, an error. */
  status?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const last = at === steps.length - 1;
  const current = steps[at];
  return (
    <div className="grid gap-5">
      <ol className="flex flex-wrap gap-1.5" aria-label={t('shell.steps.label')}>
        {steps.map((s, i) => {
          const reachable = free || i <= at || steps.slice(0, i).every((x) => x.done);
          const state = i === at ? 'now' : i < at || (free && s.done) ? 'done' : 'next';
          return (
            <li key={s.key}>
              <button
                type="button"
                disabled={!reachable}
                aria-current={i === at ? 'step' : undefined}
                onClick={() => onAt(i)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45',
                  state === 'now'
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-hairline text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'grid size-4 place-items-center rounded-full text-[10px] tabular-nums',
                    state === 'now' ? 'bg-background text-foreground' : 'bg-muted',
                  )}
                >
                  {state === 'done' ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>

      <section aria-live="polite" className="grid min-h-[16rem] content-start gap-5">
        {children}
      </section>

      <footer className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button type="button" variant="ghost" disabled={at === 0} onClick={() => onAt(at - 1)}>
          {t('shell.steps.back')}
        </Button>
        {last || free ? finish : null}
        {!last ? (
          <Button
            type="button"
            variant={free ? 'outline' : 'default'}
            disabled={!free && !current?.done}
            onClick={() => onAt(at + 1)}
          >
            {t('shell.steps.continue')}
          </Button>
        ) : null}
        {status ? <span className="min-w-0 flex-1 text-sm">{status}</span> : null}
      </footer>
    </div>
  );
}

/** A choice card: radio-like, a title and a line under it. */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  detail,
  badge,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  detail?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'grid gap-1 rounded-control border px-3.5 py-3 text-left transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-45',
        selected ? 'border-foreground bg-muted/40' : 'border-hairline hover:border-foreground/40',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 rounded-full border',
            selected
              ? 'border-foreground bg-foreground shadow-[inset_0_0_0_2px_var(--color-popover)]'
              : 'border-hairline',
          )}
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {badge}
      </span>
      {detail ? <span className="pl-5.5 text-xs text-muted-foreground">{detail}</span> : null}
    </button>
  );
}

/** One line of the summary step: what was chosen, and a way back to change it. */
export function SummaryRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: ReactNode;
  onEdit?: () => void;
}) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-hairline py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Change
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
