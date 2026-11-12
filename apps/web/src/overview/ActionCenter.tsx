import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { describeError } from '@/lib/api';
import type { ActionCategory, ActionCenter as ActionCenterModel } from './model';
import { CountBadge, Panel, ToneDot } from './Panel';
import { calmTone } from './tone';

function Category({ category, offDuty }: { category: ActionCategory; offDuty: boolean }) {
  const tone = calmTone(category.tone, offDuty);
  return (
    <section aria-label={`${category.title}, ${category.count}`} className="flex flex-col">
      <h3 className="flex items-center justify-between gap-2 border-b border-foreground/70 pb-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <ToneDot tone={tone} />
          <span className="type-micro break-words">{category.title}</span>
          <CountBadge count={category.count} tone={tone} />
        </span>
        <Link
          to={category.to}
          className="arrow-link inline-flex min-h-7 shrink-0 items-center gap-1 rounded-sm px-1 text-xs font-semibold tracking-[0.04em] uppercase outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {category.more > 0 ? `All ${category.count}` : 'Open'}
          <ArrowRight aria-hidden className="size-3" />
        </Link>
      </h3>
      <ol className="flex flex-col">
        {category.preview.map((row, i) => (
          <li key={row.key} className="border-b border-hairline last:border-b-0">
            <Link
              to={row.to}
              className="group grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 rounded-sm py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="pt-0.5 font-mono text-2xs text-muted-foreground">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0">
                <span className="block text-sm break-words underline-offset-4 group-hover:underline">
                  {row.title}
                </span>
                {row.detail && (
                  <span className="block text-xs break-words text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {category.more > 0 && (
        <p className="pt-1.5 pl-8 font-mono text-2xs text-muted-foreground">
          +{category.more} more
        </p>
      )}
    </section>
  );
}

/**
 * Action Center body: grouped by kind, most urgent kind first, each with a count, a short preview
 * and a way to the full list. Each source fails alone, so one error hides only its own groups.
 */
export function ActionCenterList({
  center,
  errors,
  loading,
  offDuty,
}: {
  center: ActionCenterModel;
  errors: readonly unknown[];
  loading: boolean;
  offDuty: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      {offDuty && center.total > 0 && (
        <p className="text-xs text-muted-foreground">
          You are off duty today. This is kept for when you are back; none of it is urgent now.
        </p>
      )}
      {errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Part of this list could not load</AlertTitle>
          <AlertDescription>{errors.map(describeError).join('; ')}</AlertDescription>
        </Alert>
      )}
      {center.categories.map((c) => (
        <Category key={c.id} category={c} offDuty={offDuty} />
      ))}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && errors.length === 0 && center.total === 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ToneDot tone="good" />
          Nothing needs you right now.
        </p>
      )}
    </div>
  );
}

/** The Action Center as its own block (Classic, and the Living Workspace on narrow screens). */
export function ActionCenterPanel({
  center,
  errors,
  loading,
  offDuty,
  className,
}: {
  center: ActionCenterModel;
  errors: readonly unknown[];
  loading: boolean;
  offDuty: boolean;
  className?: string;
}) {
  const tone = calmTone(center.tone, offDuty);
  return (
    <Panel
      n={2}
      title="Needs attention"
      context="Now · your cards and MRs, most urgent kind first"
      tone={tone}
      actions={<CountBadge count={center.total} tone={tone} />}
      className={className}
    >
      <ActionCenterList center={center} errors={errors} loading={loading} offDuty={offDuty} />
    </Panel>
  );
}
