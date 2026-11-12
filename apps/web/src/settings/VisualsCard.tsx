import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useUiStore, type VisualPage } from '@/store/ui';
import { SectionCard } from './SectionCard';

const PAGES: { page: VisualPage; name: string; what: string; other: boolean }[] = [
  {
    page: 'builds',
    name: 'Builds',
    what: 'Hold the seed to grow a crystal and start a build.',
    other: false,
  },
  {
    page: 'release',
    name: 'Release',
    what: 'Trace the constellation to start a release; the pipeline as a star map.',
    other: false,
  },
  {
    page: 'sync',
    name: 'Sync Health',
    what: 'Threads between Notion and GitLab: taut when in sync, slack or snapped when not.',
    other: true,
  },
  {
    page: 'board',
    name: 'Board',
    what: 'The card river: where the cards pool, and which ones need you.',
    other: true,
  },
];

/** Page visuals: one switch per page, and one for every page except Release and Builds. Browser-local. */
export function VisualsCard() {
  const visuals = useUiStore((s) => s.visuals);
  const otherVisuals = useUiStore((s) => s.otherVisuals);
  const setVisual = useUiStore((s) => s.setVisual);
  const setOtherVisuals = useUiStore((s) => s.setOtherVisuals);
  return (
    <SectionCard
      id="visuals"
      title="Page visuals"
      description="The pictures and gestures on each page. Every button and list stays either way. Stored in this browser only."
    >
      <div className="flex items-center justify-between gap-3 rule-row pt-4 first:border-0 first:pt-0">
        <div className="grid gap-0.5">
          <Label htmlFor="vis-other">Visuals on other pages</Label>
          <p className="text-xs text-muted-foreground">
            Off hides the visual on every page except Release and Builds, including pages added
            later.
          </p>
        </div>
        <Switch id="vis-other" checked={otherVisuals} onCheckedChange={setOtherVisuals} />
      </div>
      {PAGES.map(({ page, name, what, other }) => {
        const blocked = other && !otherVisuals;
        return (
          <div key={page} className="flex items-center justify-between gap-3 rule-row pt-4">
            <div className="grid gap-0.5">
              <Label htmlFor={`vis-${page}`}>{name}</Label>
              <p className="text-xs text-muted-foreground">
                {what}
                {blocked && ' Hidden by "Visuals on other pages".'}
              </p>
            </div>
            <Switch
              id={`vis-${page}`}
              checked={visuals[page] && !blocked}
              disabled={blocked}
              onCheckedChange={(on) => setVisual(page, on)}
            />
          </div>
        );
      })}
    </SectionCard>
  );
}
