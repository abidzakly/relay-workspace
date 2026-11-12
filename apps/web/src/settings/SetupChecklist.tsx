import { useId, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  EyeOff,
  Loader2,
} from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/store/ui';
import { SETTINGS_SECTIONS } from './sections';
import { useSetupCheck, type SetupItem } from './setupCheck';

function counts(items: SetupItem[]): string {
  const needed = items.filter((i) => i.level === 'needed').length;
  const optional = items.length - needed;
  return [needed > 0 && `${needed} needed`, optional > 0 && `${optional} optional`]
    .filter(Boolean)
    .join(', ');
}

/** "2 ignored · Show again": the way back for anything the user hid. */
function IgnoredNote({ ignored }: { ignored: SetupItem[] }) {
  const setIgnored = useUiStore((s) => s.setSetupIgnored);
  if (ignored.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {ignored.length} ignored ({ignored.map((i) => i.title).join(', ')}) ·{' '}
      <button
        type="button"
        onClick={() =>
          setIgnored(
            ignored.map((i) => i.id),
            false,
          )
        }
        className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Show again
      </button>
    </p>
  );
}

/**
 * What is still not set up: each row says what is missing, what does not work until it is set, links to the card
 * that fixes it, and can be ignored. Live, so a row leaves as soon as it is done.
 */
export function SetupChecklist({ showHeader = true }: { showHeader?: boolean }) {
  const { items, ignored, loading } = useSetupCheck();
  const setIgnored = useUiStore((s) => s.setSetupIgnored);

  if (loading && items.length === 0 && ignored.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
        Checking what is still to set up…
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="grid gap-1" aria-live="polite">
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          {ignored.length > 0 ? 'Nothing else to set up.' : 'Everything is set up.'}
        </p>
        <IgnoredNote ignored={ignored} />
      </div>
    );
  }

  return (
    <div className="grid gap-2" aria-live="polite">
      {showHeader && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="type-micro">
            Still to set up <span className="ml-1 text-muted-foreground">{counts(items)}</span>
          </p>
          <IgnoreAll items={items} />
        </div>
      )}
      <ul className="grid">
        {items.map((i) => {
          const Icon = i.level === 'needed' ? AlertTriangle : CircleDashed;
          const section = SETTINGS_SECTIONS.find((x) => x.id === i.section)?.title;
          return (
            <li
              key={i.id}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-hairline py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
            >
              <Icon
                aria-hidden
                className={cn(
                  'mt-0.5 size-4',
                  i.level === 'needed' ? 'text-warning' : 'text-muted-foreground',
                )}
              />
              <div className="grid gap-0.5">
                <p className="text-sm font-medium">
                  {i.title}{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    {i.level === 'needed' ? 'Needed' : 'Optional'}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{i.effect}</p>
              </div>
              <div className="col-start-2 flex items-center gap-4 self-start sm:col-start-3">
                <Link
                  to={`/settings#${i.section}`}
                  className="arrow-link text-xs font-medium underline-offset-4 hover:underline"
                >
                  {section}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
                <button
                  type="button"
                  onClick={() => setIgnored([i.id], true)}
                  aria-label={`Ignore: ${i.title}`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <EyeOff className="size-3.5" aria-hidden />
                  Ignore
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {/* In the strip, the page foot already carries this line. */}
      {showHeader && <IgnoredNote ignored={ignored} />}
    </div>
  );
}

function IgnoreAll({ items }: { items: SetupItem[] }) {
  const setIgnored = useUiStore((s) => s.setSetupIgnored);
  return (
    <button
      type="button"
      onClick={() =>
        setIgnored(
          items.map((i) => i.id),
          true,
        )
      }
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <EyeOff className="size-3.5" aria-hidden />
      Ignore all
    </button>
  );
}

/**
 * The quiet reminder at the top of Settings: one folded line with the count, opened on demand. Gone when nothing
 * is left or everything left is ignored.
 */
export function SetupStrip() {
  const { items } = useSetupCheck();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (items.length === 0) return null;
  const needed = items.some((i) => i.level === 'needed');
  const Icon = needed ? AlertTriangle : CircleDashed;

  return (
    <div className="rounded-surface border border-hairline bg-card">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-control text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Icon
            aria-hidden
            className={cn('size-4 shrink-0', needed ? 'text-warning' : 'text-muted-foreground')}
          />
          <span className="min-w-0 text-sm">
            <span className="font-medium">
              {items.length} {items.length === 1 ? 'thing' : 'things'} still to set up
            </span>{' '}
            <span className="text-muted-foreground">{counts(items)}</span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              'ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-settle motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </button>
        <span aria-hidden className="h-4 w-px bg-hairline" />
        <IgnoreAll items={items} />
      </div>
      <div id={bodyId} className="collapse-body" data-open={open} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="px-4 pb-2">
            <SetupChecklist showHeader={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** At the foot of Settings: the only trace of ignored reminders, and the way to bring them back. */
export function IgnoredSetupFooter() {
  const { ignored } = useSetupCheck();
  if (ignored.length === 0) return null;
  return <IgnoredNote ignored={ignored} />;
}
