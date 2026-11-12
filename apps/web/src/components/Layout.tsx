import { NavLink, Outlet } from 'react-router';
import { AiCheckDialog, AiStatusButton } from '@/components/AiCheck';
import { CommandButton, CommandPalette } from '@/components/CommandPalette';
import { ConnectionIndicator } from '@/components/ConnectionIndicator';
import { ContinueTesting } from '@/components/ContinueTesting';
import { NotificationBell } from '@/components/NotificationBell';
import { OnboardingDialog } from '@/components/OnboardingDialog';
import { NotificationToggle } from '@/components/NotificationToggle';
import { PageSwap } from '@/components/PageSwap';
import { PaperGrid } from '@/components/PaperGrid';
import { RewardLayer } from '@/components/RewardLayer';
import { SoundToggle } from '@/components/SoundToggle';
import { ThemeSync } from '@/components/ThemeSync';
import { ThemeToggle, WakeDreamSwitch } from '@/components/ThemeToggle';
import { XpChip } from '@/components/XpChip';
import { useServiceWorkerNavigation } from '@/lib/push';
import { useEnabledNav } from '@/lib/features';
import { useEventStream } from '@/lib/sse';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/store/ui';
import { WorkspaceShell } from '@/workspace/WorkspaceShell';

export function Layout() {
  // The one live stream of the page: pushes invalidations into TanStack Query.
  useEventStream();
  // A click on a push notification asks this tab to open the right view.
  useServiceWorkerNavigation();
  const homeMode = useUiStore((s) => s.homeMode);
  const nav = useEnabledNav();
  if (homeMode === 'scene') {
    return (
      <>
        <ThemeSync />
        <CommandPalette />
        <AiCheckDialog />
        <OnboardingDialog />
        <RewardLayer />
        <WorkspaceShell>
          <Outlet />
        </WorkspaceShell>
      </>
    );
  }
  const items = nav.filter((n) => !n.sceneOnly);
  return (
    <div className="relative flex min-h-screen flex-col md:flex-row">
      <PaperGrid />
      <ThemeSync />
      <CommandPalette />
      <AiCheckDialog />
      <OnboardingDialog />
      <RewardLayer />
      <aside className="relative z-10 flex shrink-0 flex-col border-b border-hairline bg-background/85 backdrop-blur-sm md:sticky md:top-0 md:h-screen md:w-60 md:border-r md:border-b-0 md:bg-transparent md:backdrop-blur-none">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:px-6 md:pt-6 md:pb-5">
          <NavLink to="/overview" className="min-w-0 type-micro text-foreground">
            <span className="truncate">Relay</span>
          </NavLink>
          <div className="flex items-center gap-1 md:hidden">
            <CommandButton compact />
            <ConnectionIndicator />
            <AiStatusButton compact />
            <NotificationBell />
            <NotificationToggle compact />
            <SoundToggle compact />
            <ThemeToggle />
          </div>
        </div>
        <XpChip className="px-4 pb-3 md:px-6" />
        <div className="hidden px-4 pb-4 md:block">
          <CommandButton />
        </div>
        <nav
          aria-label="Main"
          className="flex gap-0 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-y-auto md:px-0 md:pb-4"
        >
          {items.map(({ to, label, end }, i) => (
            <NavLink
              key={to}
              to={to}
              {...(end ? { end } : {})}
              className={({ isActive }) =>
                cn(
                  'group flex items-baseline gap-3 px-3 py-2 type-micro whitespace-nowrap transition-colors md:border-t md:border-hairline md:px-6 md:py-2.5',
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="hidden w-6 tabular-nums md:inline">
                    ({String(i + 1).padStart(2, '0')})
                  </span>
                  <span className="flex-1">{label}</span>
                  <span
                    aria-hidden
                    className={cn(
                      'hidden size-1.5 self-center rounded-full bg-foreground transition-transform duration-300 md:inline-block',
                      isActive ? 'scale-100' : 'scale-0 group-hover:scale-50',
                    )}
                  />
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="md:hidden">
          <ContinueTesting variant="chips" />
        </div>
        <div className="hidden md:block">
          <ContinueTesting variant="rail" />
        </div>
        <div className="hidden border-t border-hairline px-4 pt-3 md:block">
          <NotificationToggle />
        </div>
        <div className="hidden flex-col gap-2 px-6 py-4 md:flex">
          <div className="flex flex-col gap-0.5">
            <ConnectionIndicator />
            <AiStatusButton />
          </div>
          <div className="-mx-2.5 flex items-center gap-1">
            <NotificationBell />
            <SoundToggle />
          </div>
          <span className="type-micro text-muted-foreground">127.0.0.1 only</span>
        </div>
      </aside>
      <PageSwap enabled>
        <main className="relative z-[1] min-w-0 flex-1 px-4 pt-6 pb-28 md:px-10 md:pt-10">
          <Outlet />
        </main>
      </PageSwap>
      <WakeDreamSwitch className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2" />
    </div>
  );
}
