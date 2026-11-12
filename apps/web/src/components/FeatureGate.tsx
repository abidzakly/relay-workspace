import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { FEATURES, featuresOfPath, notionConnected, pathEnabled } from '@relay/shared';
import { PageTitle } from '@/components/PageTitle';
import { Button } from '@/components/ui/button';
import { useFeatures } from '@/lib/features';
import { useSettings } from '@/lib/settingsApi';
import { useUnsupported } from '@/lib/systemApi';

/**
 * A page of a switched-off feature (Settings > General > Features) says so instead of rendering: a bookmark or a link
 * from elsewhere still lands somewhere that explains itself. Nothing is deleted while a feature is off.
 */
export function FeatureGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const features = useFeatures();
  const unsupported = useUnsupported();
  const settings = useSettings().data;
  const owners = featuresOfPath(pathname);
  // Cannot run on this machine at all (Windows without WSL): say so, whatever the switch says.
  const why =
    owners.length > 0 && owners.every((id) => unsupported.has(id))
      ? unsupported.get(owners[0]!)
      : null;
  const labels = owners
    .map((id) => FEATURES.find((f) => f.id === id)?.label)
    .filter(Boolean)
    .join(' or ');
  // Notion is optional: a page built on Notion cards explains what it needs instead of showing nothing.
  const needsNotion =
    settings !== undefined &&
    owners.length > 0 &&
    owners.every((id) => FEATURES.find((f) => f.id === id)?.needsNotion) &&
    !notionConnected(settings.notion);
  if (!why && pathEnabled(pathname, features)) {
    if (!needsNotion) return <>{children}</>;
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <PageTitle label="Needs Notion">{labels || 'This page'}</PageTitle>
        <p className="text-sm text-muted-foreground">
          {labels} works from your Notion cards, and Notion is not connected. Merge requests, Code
          Review and Reviews work with GitLab alone. Connect Notion (an integration token and your
          tasks database) to use this page, or switch it off in Features.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/settings#notion">Connect Notion</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/settings#features">Open Features</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <PageTitle label="Turned off">{labels || 'This page'}</PageTitle>
      <p className="text-sm text-muted-foreground">
        {why
          ? `${labels} cannot run here. ${why} See docs/GUIDE.md, “Windows”.`
          : `${labels} is switched off. Its data is kept; switch it back on whenever you need it.`}
      </p>
      <Button asChild className="mt-6">
        <Link to="/settings#features">Open Features in Settings</Link>
      </Button>
    </div>
  );
}
