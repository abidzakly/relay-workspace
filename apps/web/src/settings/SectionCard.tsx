import { createContext, useContext, useId, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { settingsSectionTitle } from '@/i18n/labels';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { describeError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/store/ui';
import { BrandDecor, BrandLogo, type BrandId } from './brandMarks';

/**
 * What the Settings page tells its cards: which ones a search hides, and whether a search holds them all open.
 * Cards stay mounted while hidden or folded, so an unsaved draft survives a tab switch or a search.
 */
export const SectionView = createContext<{ shown: (id: string) => boolean; forceOpen: boolean }>({
  shown: () => true,
  forceOpen: false,
});

export function SectionCard({
  id,
  title,
  description,
  action,
  brand,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** The service this section sets up: its mark beside the title and its colour on the card's edge. */
  brand?: BrandId;
  children: ReactNode;
}) {
  const view = useContext(SectionView);
  const collapsed = useUiStore((s) => s.settingsCollapsed[id] === true);
  const setCollapsed = useUiStore((s) => s.setSettingsCollapsed);
  const bodyId = useId();
  const { t } = useTranslation();
  const open = view.forceOpen || !collapsed;

  return (
    <Card
      id={id}
      hidden={!view.shown(id)}
      data-brand={brand}
      className={cn(brand && 'section-brand')}
    >
      {brand ? <BrandDecor brand={brand} /> : null}
      <div className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          disabled={view.forceOpen}
          onClick={() => setCollapsed([id], !collapsed)}
          className={cn(
            'group -m-2 grid min-w-0 flex-1 items-start gap-x-2 gap-y-1.5 rounded-control p-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none enabled:cursor-pointer',
            brand
              ? 'grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3'
              : 'grid-cols-[auto_minmax(0,1fr)]',
          )}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              'mt-px size-3.5 text-muted-foreground transition-transform duration-300 ease-settle group-enabled:group-hover:text-foreground motion-reduce:transition-none',
              !open && '-rotate-90',
            )}
          />
          {brand ? <BrandLogo brand={brand} className="row-span-2 -mt-1.5" /> : null}
          <CardTitle>{settingsSectionTitle(t, id, title)}</CardTitle>
          {description ? (
            <CardDescription className={brand ? 'col-start-3' : 'col-start-2'}>
              {description}
            </CardDescription>
          ) : null}
        </button>
        {action ? <div className="shrink-0 pl-5.5 sm:pl-0">{action}</div> : null}
      </div>
      <div id={bodyId} className="collapse-body" data-open={open} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="grid gap-4 px-6 pt-1 pb-6">{children}</div>
        </div>
      </div>
    </Card>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{describeError(error)}</AlertDescription>
    </Alert>
  );
}
