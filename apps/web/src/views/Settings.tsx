import {
  Fragment,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  ViewTransition,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ChevronsDownUp, ChevronsUpDown, Search, X } from 'lucide-react';
import { PlanningCard, toPlanningDraft } from '@/settings/PlanningCard';
import { AiPromptsCard } from '@/settings/AiPromptsCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/api';
import type { GlobalConfigPublic } from '@relay/shared';
import { useSettings } from '@/lib/settingsApi';
import { AppearanceCard } from '@/settings/AppearanceCard';
import { VisualsCard } from '@/settings/VisualsCard';
import { BackupCard } from '@/settings/BackupCard';
import { AiCard } from '@/settings/AiCard';
import { DriveCard, toDriveDraft } from '@/settings/DriveCard';
import { GitlabCard, toGitlabDraft } from '@/settings/GitlabCard';
import { NotificationsCard } from '@/settings/NotificationsCard';
import { NotionCard, toNotionDraft } from '@/settings/NotionCard';
import { FeaturesCard } from '@/settings/FeaturesCard';
import { ReposCard } from '@/settings/ReposCard';
import { ReviewerCard } from '@/settings/ReviewerCard';
import { ScriptsCard } from '@/settings/ScriptsCard';
import { SafetyCard } from '@/settings/SafetyCard';
import { StorageCard } from '@/settings/StorageCard';
import { WebhookHealthCard } from '@/settings/WebhookHealthCard';
import { WorkspacesCard } from '@/settings/WorkspacesCard';
import { SectionView } from '@/settings/SectionCard';
import { useSetupCheck } from '@/settings/setupCheck';
import { IgnoredSetupFooter, SetupStrip } from '@/settings/SetupChecklist';
import { SettingsTabs, panelId, tabId } from '@/settings/SettingsTabs';
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  groupOfHash,
  matchesQuery,
  sectionOfHash,
  type SettingsGroupId,
} from '@/settings/sections';
import { PageTitle, SectionLabel } from '@/components/PageTitle';
import { useUiStore } from '@/store/ui';
import { useReducedMotion } from '@/workspace/useMedia';

/** Each section's card. Order inside a group comes from `SETTINGS_SECTIONS`. */
function cards(s: GlobalConfigPublic): Record<string, ReactNode> {
  return {
    features: <FeaturesCard settings={s} />,
    safety: <SafetyCard settings={s} />,
    notifications: <NotificationsCard settings={s} />,
    // Keyed on each section's own server values: saving one section never wipes another's unsaved edits.
    gitlab: <GitlabCard key={`gl:${JSON.stringify(toGitlabDraft(s))}`} settings={s} />,
    reviewer: <ReviewerCard settings={s} />,
    notion: <NotionCard key={`nt:${JSON.stringify(toNotionDraft(s))}`} settings={s} />,
    drive: <DriveCard key={`dr:${JSON.stringify(toDriveDraft(s))}`} settings={s} />,
    ai: <AiCard settings={s} />,
    'ai-prompts': <AiPromptsCard settings={s} />,
    repos: <ReposCard settings={s} />,
    workspaces: <WorkspacesCard />,
    scripts: <ScriptsCard />,
    webhooks: <WebhookHealthCard settings={s} />,
    planning: <PlanningCard key={`pl:${JSON.stringify(toPlanningDraft(s))}`} settings={s} />,
    storage: <StorageCard settings={s} />,
    backup: <BackupCard />,
    appearance: <AppearanceCard />,
    visuals: <VisualsCard />,
  };
}

/** The element that scrolls the page: the window in the classic layout, the scene frame's `main` otherwise. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight)
      return p;
  }
  return document.scrollingElement as HTMLElement;
}

/** Scroll so `el` sits just under the stuck tab bar. */
function scrollUnderBar(el: HTMLElement, bar: HTMLElement, behavior: ScrollBehavior) {
  const scroller = scrollParent(bar);
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  scroller.scrollBy({
    top: el.getBoundingClientRect().top - (top + bar.offsetHeight + 16),
    behavior,
  });
}

export function Settings() {
  const q = useSettings();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const active = groupOfHash(hash) ?? 'general';
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const searchRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const panelsRef = useRef<HTMLDivElement>(null);
  // The scroller's top padding. The bar sticks above it, at the scroller's edge, so cards never show above the bar.
  const [pad, setPad] = useState(0);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      const scroller = scrollParent(bar);
      setPad(
        scroller === document.scrollingElement
          ? 0
          : parseFloat(getComputedStyle(scroller).paddingTop) || 0,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const collapsed = useUiStore((s) => s.settingsCollapsed);
  const setCollapsed = useUiStore((s) => s.setSettingsCollapsed);

  const shownIds = useMemo(
    () => new Set(SETTINGS_SECTIONS.filter((s) => matchesQuery(s, query)).map((s) => s.id)),
    [query],
  );
  const view = useMemo(
    () => ({ shown: (id: string) => !searching || shownIds.has(id), forceOpen: searching }),
    [searching, shownIds],
  );

  const select = (g: SettingsGroupId) => {
    setQuery('');
    // A Transition, so the panel swap cross-fades like a page change (`page-swap` in index.css).
    startTransition(() => navigate({ hash: g }, { replace: true }));
  };

  // A tab switch while the bar is stuck: bring the new panel's top up under the bar (scroll anchoring is off on this
  // page, so the browser does not shift it again). Runs inside the swap, so the
  // cross-fade hides the jump.
  const lastActive = useRef(active);
  useLayoutEffect(() => {
    if (lastActive.current === active) return;
    lastActive.current = active;
    if (sectionOfHash(hash)) return;
    const bar = barRef.current;
    const panels = panelsRef.current;
    if (bar && panels && panels.getBoundingClientRect().top < bar.getBoundingClientRect().bottom) {
      scrollUnderBar(panels, bar, 'instant');
    }
  }, [active, hash]);

  // `#notion` and friends: open that card and glide to it once the settings are loaded.
  const loaded = q.data !== undefined;
  useEffect(() => {
    const section = sectionOfHash(hash);
    if (!section || !loaded) return;
    setCollapsed([section.id], false);
    const id = requestAnimationFrame(() => {
      const el = document.getElementById(section.id);
      if (el && barRef.current) scrollUnderBar(el, barRef.current, reduced ? 'instant' : 'smooth');
    });
    return () => cancelAnimationFrame(id);
  }, [hash, loaded, reduced, setCollapsed]);

  // `/` jumps to search, as on the Board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeIds = SETTINGS_SECTIONS.filter((s) => s.group === active).map((s) => s.id);
  const allFolded = activeIds.every((id) => collapsed[id]);
  const byId = q.data ? cards(q.data) : null;
  // A dot on each tab that holds something a feature needs (same list the import shows afterwards).
  const setup = useSetupCheck();
  const attention: Partial<Record<SettingsGroupId, string>> = {};
  for (const g of SETTINGS_GROUPS) {
    const needed = setup.items.filter((i) => i.group === g.id && i.level === 'needed');
    if (needed.length > 0) attention[g.id] = `Not set: ${needed.map((i) => i.title).join(', ')}`;
  }

  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 [overflow-anchor:none]">
      <PageTitle>Settings</PageTitle>

      <div className="relative w-full sm:w-80">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchRef}
          type="search"
          aria-label="Search settings"
          placeholder="Search settings  /"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              setQuery('');
            }
          }}
          className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
            className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-control text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      {q.data ? <SetupStrip /> : null}

      <div
        ref={barRef}
        style={{ top: -pad }}
        className="sticky top-0 z-20 -mx-1 flex items-center justify-between gap-3 border-b border-hairline bg-background/85 px-1 backdrop-blur-sm"
      >
        <SettingsTabs active={active} onSelect={select} dimmed={searching} attention={attention} />
        {!searching && byId && (
          <button
            type="button"
            onClick={() => setCollapsed(activeIds, !allFolded)}
            className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex"
          >
            {allFolded ? (
              <ChevronsUpDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronsDownUp className="size-3.5" aria-hidden />
            )}
            {allFolded ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>

      {q.isPending ? <p className="text-sm text-muted-foreground">Loading settings…</p> : null}
      {q.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Cannot load settings</AlertTitle>
          <AlertDescription>
            {describeError(q.error)}. Make sure the server is running (<code>pnpm dev</code>) and{' '}
            <code>MASTER_KEY</code> is set in <code>.env</code>.
          </AlertDescription>
        </Alert>
      ) : null}

      {byId ? (
        <SectionView value={view}>
          <ViewTransition default="none" update={reduced ? 'none' : 'page-swap'}>
            <div ref={panelsRef} className="grid gap-6">
              {searching && shownIds.size === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No setting matches “{query.trim()}”.
                </p>
              ) : null}
              {SETTINGS_GROUPS.map((g) => {
                const ids = SETTINGS_SECTIONS.filter((s) => s.group === g.id).map((s) => s.id);
                const hidden = searching ? !ids.some((id) => shownIds.has(id)) : g.id !== active;
                return (
                  <section
                    key={g.id}
                    id={panelId(g.id)}
                    role={searching ? undefined : 'tabpanel'}
                    aria-labelledby={searching ? undefined : tabId(g.id)}
                    aria-label={searching ? g.label : undefined}
                    hidden={hidden}
                    className="grid gap-4"
                  >
                    {searching && <SectionLabel>{g.label}</SectionLabel>}
                    {ids.map((id) => (
                      <Fragment key={id}>{byId[id]}</Fragment>
                    ))}
                  </section>
                );
              })}
            </div>
          </ViewTransition>
        </SectionView>
      ) : null}
      {q.data ? <IgnoredSetupFooter /> : null}
    </div>
  );
}
