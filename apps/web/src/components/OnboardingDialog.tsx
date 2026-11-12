import { Check, MonitorCog, Terminal, X } from 'lucide-react';
import {
  FEATURES,
  POSIX_FEATURES,
  featuresForMobileRelease,
  featuresForWindowsNative,
} from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { useSystem } from '@/lib/systemApi';
import { ErrorAlert } from '@/settings/SectionCard';

/** The mobile release flow that Release and Builds automate, in the order it happens. */
const FLOW = [
  'Bump the app version on a version branch',
  'Open the version merge request and wait for its review',
  'Merge it and tag the release (for example v1.4.0+42)',
  'Build the app (staging or production flavor)',
  'Upload the build to Google Drive and send the link to QA',
];

const WSL_STEPS = [
  'In PowerShell (as administrator): wsl --install, then restart',
  'Open Ubuntu, install Node 22 and pnpm (corepack enable)',
  'Clone Relay inside WSL (your Linux home, not /mnt/c) and run pnpm install',
  'pnpm build && pnpm start, then open http://127.0.0.1:3000 in your Windows browser',
];

const label = (id: string) => FEATURES.find((f) => f.id === id)?.label ?? id;

/**
 * First start. On Windows (outside WSL) it first asks how to run: natively with the WSL-only features off, or inside
 * WSL for everything. Then, everywhere: does your work include releasing and building a mobile app? Each answer only
 * switches the features it names; Settings > General > Features changes any of it later. Asked exactly once.
 */
export function OnboardingDialog() {
  const settings = useSettings().data;
  const system = useSystem().data;
  const save = useSaveGlobal();
  const windowsNative = system?.os === 'windows' && !system.wsl;
  const askWindows = windowsNative && settings?.profile.windowsMode === null;
  const askMobile = settings !== undefined && settings.profile.releasesMobileApp === null;
  const open = settings !== undefined && system !== undefined && (askWindows || askMobile);

  const chooseWindows = (mode: 'native' | 'wsl') =>
    save.mutate({
      patch: (s) => ({
        ...s,
        profile: { ...s.profile, windowsMode: mode },
        features: mode === 'native' ? featuresForWindowsNative(s.features) : s.features,
      }),
    });

  const answerMobile = (yes: boolean) =>
    save.mutate({
      patch: (s) => {
        const next = featuresForMobileRelease(s.features, yes);
        return {
          ...s,
          profile: { ...s.profile, releasesMobileApp: yes },
          // On Windows without WSL, Builds stays off whatever the answer: it needs WSL there.
          features: windowsNative ? featuresForWindowsNative(next) : next,
        };
      },
    });

  return (
    <Dialog open={open}>
      <DialogContent
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        {askWindows ? (
          <>
            <DialogHeader>
              <DialogTitle>You are on Windows</DialogTitle>
              <DialogDescription>
                Most of Relay runs on Windows as it is. A few parts run macOS/Linux tools and need
                WSL (Linux inside Windows, free from Microsoft).
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 border-t border-hairline pt-3 text-sm">
              <p>
                <span className="font-semibold">Works on Windows:</span> merge requests, Code
                Review, Reviews, Board, Release (native engine), Sync Health, KPI, Notifications.
              </p>
              <p>
                <span className="font-semibold">Needs WSL:</span>{' '}
                {POSIX_FEATURES.map(label).join(', ')}, and the release scripts.
              </p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer text-foreground">How to move to WSL</summary>
                <ol className="mt-2 grid list-decimal gap-1 pl-4">
                  {WSL_STEPS.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p className="mt-2">Full steps: docs/GUIDE.md, “Windows”.</p>
              </details>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={save.isPending}
                onClick={() => chooseWindows('wsl')}
              >
                <Terminal aria-hidden /> I will use WSL
              </Button>
              <Button disabled={save.isPending} onClick={() => chooseWindows('native')}>
                <MonitorCog aria-hidden /> Continue on Windows
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Continue on Windows switches {POSIX_FEATURES.map(label).join(', ')} off. Nothing else
              changes.
            </p>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Do you release and build a mobile app?</DialogTitle>
              <DialogDescription>
                That is, does your work include a release flow like this one:
              </DialogDescription>
            </DialogHeader>
            <ol className="grid gap-1.5 border-t border-hairline pt-3 text-sm">
              {FLOW.map((step, i) => (
                <li key={step} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-baseline">
                  <span className="font-mono text-2xs text-muted-foreground">
                    ({String(i + 1).padStart(2, '0')})
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Why we ask:</span> the Release and
              Builds pages run this flow for you. Web and backend teams usually ship through a CI/CD
              pipeline instead, so for them these pages are only clutter. Everything else stays on
              either way, and you can change this any time in Settings &gt; General &gt; Features.
              {windowsNative ? ' On Windows without WSL, Builds stays off: it needs WSL.' : ''}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={save.isPending}
                onClick={() => answerMobile(false)}
              >
                <X aria-hidden /> No, hide them
              </Button>
              <Button disabled={save.isPending} onClick={() => answerMobile(true)}>
                <Check aria-hidden /> Yes, I release mobile apps
              </Button>
            </div>
            <p className="border-t border-hairline pt-3 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">How Relay stays safe:</span> it runs
              only on this machine and listens on 127.0.0.1, with no accounts and no cloud. Your
              tokens are encrypted on disk. If you give GitLab a public webhook URL, that URL lets
              through only <code>POST /webhook/*</code>, checked against a secret. Dry-run is on, so
              writes to GitLab, Notion and Drive are previewed until you switch it off in Settings
              &gt; General &gt; Safety &amp; engine.
            </p>
          </>
        )}
        <ErrorAlert error={save.error} />
      </DialogContent>
    </Dialog>
  );
}
