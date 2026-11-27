import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { create } from 'zustand';
import {
  FEATURE_GROUPS,
  FEATURES,
  notionConnected,
  type FeatureGroupId,
  type FeatureInfo,
} from '@relay/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StepDialog, type WizardStep } from '@/components/wizard/StepDialog';
import { navLabel } from '@/i18n/labels';
import { useFeatures } from '@/lib/features';
import { useSettings } from '@/lib/settingsApi';
import { useMarkShowcaseSeen, useShowcaseSeen } from '@/lib/showcaseApi';
import { useUnsupported } from '@/lib/systemApi';
import { useSetupCheck } from '@/settings/setupCheck';

/** Opened by hand from Settings > General > Features and the command palette. */
export const useShowcaseStore = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

type SlideKey = FeatureGroupId | 'setup';

/** Where a feature card leads: its page, or its Settings section when it has none (Postrack). */
const targetOf = (f: FeatureInfo) => f.routes[0] ?? `/settings#${f.id}`;

/**
 * The feature tour: one slide per feature group with the features that are switched on, then a pointer to the
 * setup checklist. Opens by itself once, after the first-start question is answered; Skip, Done, Esc or opening a
 * feature all count as seen (kept on the server as `state.showcase.seen`).
 */
export function ShowcaseDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const settings = useSettings().data;
  const seen = useShowcaseSeen().data?.seen;
  const markSeen = useMarkShowcaseSeen();
  const manual = useShowcaseStore((s) => s.open);
  const setManual = useShowcaseStore((s) => s.setOpen);
  const features = useFeatures();
  const unsupported = useUnsupported();
  const [at, setAt] = useState(0);

  const auto =
    settings !== undefined && settings.profile.releasesMobileApp !== null && seen === false;
  const open = manual || auto;
  useEffect(() => {
    if (open) setAt(0);
  }, [open]);

  const groups = FEATURE_GROUPS.map((g) => ({
    id: g.id,
    items: FEATURES.filter((f) => f.group === g.id && features[f.id] && !unsupported.has(f.id)),
  })).filter((g) => g.items.length > 0);
  const steps: WizardStep<SlideKey>[] = [
    ...groups.map((g) => ({ key: g.id, label: t(`showcase.groups.${g.id}`), done: true })),
    { key: 'setup', label: t('showcase.final.rail'), done: true },
  ];
  const current = Math.min(at, steps.length - 1);
  const group = groups[current];
  const notionOk = settings ? notionConnected(settings.notion) : true;

  const close = () => {
    setManual(false);
    if (seen === false) markSeen.mutate();
  };
  const go = (to: string) => {
    close();
    void navigate(to);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-2xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader className="pr-8">
          <DialogTitle>{t('showcase.title')}</DialogTitle>
          <DialogDescription>{t('showcase.lede')}</DialogDescription>
        </DialogHeader>
        <StepDialog
          steps={steps}
          at={current}
          onAt={setAt}
          finish={<Button onClick={close}>{t('showcase.done')}</Button>}
          status={
            <span className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={close}>
                {t('showcase.skip')}
              </Button>
            </span>
          }
        >
          {group ? (
            <>
              <p className="text-sm text-muted-foreground">{t(`showcase.groupLede.${group.id}`)}</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {group.items.map((f) => {
                  const route = f.routes[0];
                  const needsNotion = f.needsNotion === true && !notionOk;
                  return (
                    <li
                      key={f.id}
                      className="grid content-between gap-3 rounded-control border border-hairline px-3.5 py-3"
                    >
                      <div className="grid gap-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <span className="min-w-0 flex-1 truncate">
                            {route ? navLabel(t, route, f.label) : f.label}
                          </span>
                          {needsNotion ? (
                            <Badge variant="warning" title={t('showcase.needsNotionHint')}>
                              {t('showcase.needsNotion')}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`showcase.features.${f.id}`)}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        onClick={() => go(needsNotion ? '/settings#notion' : targetOf(f))}
                      >
                        {route && !needsNotion ? t('showcase.open') : t('showcase.openSettings')}
                        <ArrowRight aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <SetupSlide onOpen={() => go('/settings')} />
          )}
        </StepDialog>
      </DialogContent>
    </Dialog>
  );
}

/** The last slide: how much is still to set up, and the way to the checklist at the top of Settings. */
function SetupSlide({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { items } = useSetupCheck();
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">{t('showcase.final.title')}</h3>
      <p className="text-sm text-muted-foreground">
        {items.length > 0 ? t('showcase.final.body') : t('showcase.final.allSet')}
      </p>
      {items.length > 0 ? (
        <p className="text-sm font-medium">
          {t('showcase.final.missing', { count: items.length })}
        </p>
      ) : null}
      <Button variant="outline" className="w-fit" onClick={onOpen}>
        {t('showcase.final.link')}
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}
