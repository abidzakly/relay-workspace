import type { RepoConfigPublic } from '@relay/shared';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RepoWizard } from './repoWizard/RepoWizard';

/** Add or edit a repository: a stepped wizard in a dialog (see `repoWizard/RepoWizard.tsx`). */
export function RepoDialog({
  open,
  onOpenChange,
  repo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: RepoConfigPublic | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {/* Mounted only while open, so the wizard starts fresh every time. */}
        <RepoWizard repo={repo} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
