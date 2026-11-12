import { useState } from 'react';
import type { FlavorDetection } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';

/** Both or neither of main_staging and main_development. Nothing is preselected: the user decides. */
export function FlavorDialog({
  repoName,
  detection,
  onChoose,
  onClose,
}: {
  repoName: string;
  detection: FlavorDetection;
  onChoose: (flavor: string) => void;
  onClose: () => void;
}) {
  const [flavor, setFlavor] = useState('');
  const { candidates, reason } = detection;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose a flavor for {repoName}</DialogTitle>
          <DialogDescription>
            {reason === 'both'
              ? 'This repo has both lib/main_staging.dart and lib/main_development.dart.'
              : 'This repo has neither lib/main_staging.dart nor lib/main_development.dart.'}{' '}
            The dashboard does not guess.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-sm text-destructive">
            No lib/main_&lt;flavor&gt;.dart other than production was found in the clone, so there
            is nothing to build as staging.
          </p>
        ) : (
          <Select aria-label="Flavor" value={flavor} onChange={(e) => setFlavor(e.target.value)}>
            <option value="">Choose…</option>
            {candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={flavor === ''} onClick={() => onChoose(flavor)}>
            Build {flavor}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
