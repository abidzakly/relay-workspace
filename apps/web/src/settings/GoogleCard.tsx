import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import type { GlobalConfigPublic } from '@relay/shared';
import { useSaveGlobal } from '@/lib/settingsApi';
import { CalendarSection } from './CalendarCard';
import { DriveSection } from './DriveCard';
import { ErrorAlert, SectionCard } from './SectionCard';
import { ModeSwitch } from './SetupGuide';

/**
 * Google: one account for Calendar and Drive. Connect mode: the Google sign-in, which asks for each one when its
 * feature is used ("Allow Drive"). Advanced mode: your own OAuth client for Calendar and a service account for Drive.
 * The other way is kept but not used.
 */
export function GoogleCard({ settings }: { settings: GlobalConfigPublic }) {
  const advanced = settings.google.authMode === 'token';
  const save = useSaveGlobal();
  const qc = useQueryClient();
  const setMode = (on: boolean) =>
    save.mutate(
      { patch: (s) => ({ ...s, google: { ...s.google, authMode: on ? 'token' : 'connect' } }) },
      // The calendar, Drive checks and the checklist all change with the mode.
      { onSuccess: () => void qc.invalidateQueries() },
    );

  return (
    <SectionCard
      id="google"
      brand="google"
      title="Google: Calendar & Drive"
      description={
        advanced
          ? 'Advanced mode: your own OAuth client for Calendar, a service account for Drive.'
          : 'One Google sign-in for both. Relay asks for Calendar and Drive separately, when you use them.'
      }
      action={
        <ModeSwitch
          id="google-advanced"
          advanced={advanced}
          pending={save.isPending}
          onChange={setMode}
        />
      }
    >
      <ErrorAlert error={save.error} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button asChild size="sm" variant="outline">
          <Link to="/setup/google">Set up Google</Link>
        </Button>
        <span className="text-muted-foreground">
          A guided walk: sign-in, which calendars to read, and Drive for builds.
        </span>
      </div>
      <Part
        title="Calendar"
        lede="Reads your meetings (read-only) for the floating alert and the Meetings page."
        off={settings.features.calendar ? null : 'Meetings'}
      >
        <CalendarSection settings={settings} advanced={advanced} />
      </Part>
      <Part
        title="Drive"
        lede="Uploads staging builds to Drive for QA."
        off={settings.features.builds ? null : 'Builds'}
      >
        <DriveSection settings={settings} advanced={advanced} />
      </Part>
    </SectionCard>
  );
}

/** One Google service inside the card; when its feature is off, a line that says where to turn it on. */
function Part({
  title,
  lede,
  off,
  children,
}: {
  title: string;
  lede: string;
  off: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 border-t pt-5 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="grid gap-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{lede}</p>
      </div>
      {off ? (
        <p className="text-sm text-muted-foreground">
          “{off}” is switched off. Turn it on under{' '}
          <Link to="/settings#features">General &gt; Features</Link> to set this up.
        </p>
      ) : (
        children
      )}
    </section>
  );
}
