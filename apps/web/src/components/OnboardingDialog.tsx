import { Check, X } from 'lucide-react';
import { featuresForMobileRelease } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { ErrorAlert } from '@/settings/SectionCard';

/** The mobile release flow that Release and Builds automate, in the order it happens. */
const FLOW = [
  'Bump the app version on a version branch',
  'Open the version merge request and wait for its review',
  'Merge it and tag the release (for example v1.4.0+42)',
  'Build the app (staging or production flavor)',
  'Upload the build to Google Drive and send the link to QA',
];

/**
 * First start, the same on every system: does your work include releasing and building a mobile app? The answer only
 * switches the features it names; Settings > General > Features changes any of it later. Asked exactly once.
 */
export function OnboardingDialog() {
  const settings = useSettings().data;
  const save = useSaveGlobal();
  const open = settings !== undefined && settings.profile.releasesMobileApp === null;

  const answerMobile = (yes: boolean) =>
    save.mutate({
      patch: (s) => ({
        ...s,
        profile: { ...s.profile, releasesMobileApp: yes },
        features: featuresForMobileRelease(s.features, yes),
      }),
    });

  return (
    <Dialog open={open}>
      <DialogContent
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
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
          <span className="font-semibold text-foreground">Why we ask:</span> the Release and Builds
          pages run this flow for you. Web and backend teams usually ship through a CI/CD pipeline
          instead, so for them these pages are only clutter. Everything else stays on either way,
          and you can change this any time in Settings &gt; General &gt; Features.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={save.isPending} onClick={() => answerMobile(false)}>
            <X aria-hidden /> No, hide them
          </Button>
          <Button disabled={save.isPending} onClick={() => answerMobile(true)}>
            <Check aria-hidden /> Yes, I release mobile apps
          </Button>
        </div>
        <p className="border-t border-hairline pt-3 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">How Relay stays safe:</span> it runs only
          on this machine and listens on 127.0.0.1, with no accounts and no cloud. Your tokens are
          encrypted on disk. If you give GitLab a public webhook URL, that URL lets through only{' '}
          <code>POST /webhook/*</code>, checked against a secret. Dry-run is on, so writes to
          GitLab, Notion and Drive are previewed until you switch it off in Settings &gt; General
          &gt; Safety &amp; engine.
        </p>
        <ErrorAlert error={save.error} />
      </DialogContent>
    </Dialog>
  );
}
