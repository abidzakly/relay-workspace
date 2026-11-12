import { GitBranch, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ExistingBranchChoice = 'replace' | 'reuse';

/**
 * Asked when a card start finds the card's branch already there (`branch_exists`): keep working on it as it is, or
 * reset it to the base. Used by the single and the bulk Start dialogs.
 */
export function ExistingBranchPrompt({
  branch,
  base,
  disabled,
  onChoose,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  branch: string;
  base: string;
  disabled: boolean;
  onChoose: (choice: ExistingBranchChoice) => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <section
      role="group"
      aria-label={`Branch ${branch} already exists`}
      className="grid min-w-0 gap-2 rounded-xl border border-destructive/40 p-3"
    >
      <div className="min-w-0">
        <h3 className="text-sm font-medium break-words">
          Branch <span className="font-mono">{branch}</span> already exists
        </h3>
        <p className="text-xs text-muted-foreground">
          Use it as it is, earlier commits included, or replace it with a fresh branch from{' '}
          <span className="font-mono">{base}</span>. Replacing drops its local commits, and the
          agent&apos;s push overwrites the remote branch.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={disabled}
          onClick={() => onChoose('reuse')}
        >
          <GitBranch className="size-4" />
          Use existing
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1 text-destructive"
          disabled={disabled}
          onClick={() => onChoose('replace')}
        >
          <RotateCcw className="size-4" />
          Replace
        </Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </section>
  );
}
