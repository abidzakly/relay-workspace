import { Bug, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { FINDING_SEVERITIES, type AcItem, type Finding, type FindingSeverity } from '@relay/shared';
import { Dropdown } from '@/components/Dropdown';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { useAddFinding, useUpdateFinding } from '@/lib/testBenchApi';

/**
 * Log or edit a finding. Kept in this app: it never creates a Notion issue (that stays QA's job).
 * Ported in spirit from dashboard-qa `IssueDialog.tsx`, with the fields a fix prompt needs.
 */

const NO_AC = '__none';

export function FindingDialog({
  repo,
  branch,
  ac,
  open,
  onOpenChange,
  editing,
  defaultAcKey,
}: {
  repo: string;
  branch: string;
  ac: AcItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Finding | null;
  defaultAcKey: string | null;
}) {
  const add = useAddFinding(repo, branch);
  const update = useUpdateFinding(repo, branch);
  const [title, setTitle] = useState(editing?.title ?? '');
  const [severity, setSeverity] = useState<FindingSeverity>(editing?.severity ?? 'major');
  const [acKey, setAcKey] = useState<string>(editing?.acKey ?? defaultAcKey ?? NO_AC);
  const [steps, setSteps] = useState(editing?.steps ?? '');
  const [expected, setExpected] = useState(
    editing?.expected ?? (defaultAcKey ? (ac.find((a) => a.key === defaultAcKey)?.text ?? '') : ''),
  );
  const [actual, setActual] = useState(editing?.actual ?? '');
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;

  const submit = () => {
    const finding = {
      title: title.trim(),
      severity,
      acKey: acKey === NO_AC ? null : acKey,
      steps,
      expected,
      actual,
    };
    const done = { onSuccess: () => onOpenChange(false) };
    if (editing) update.mutate({ id: editing.id, patch: finding }, done);
    else add.mutate(finding, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="size-5" /> {editing ? 'Edit finding' : 'Log a finding'}
          </DialogTitle>
          <DialogDescription>
            Saved in this dashboard only. Fix it with AI later, then retest it as a regression
            check.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim().length >= 3) submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="finding-title">What is wrong</Label>
            <Input
              id="finding-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="Save button stays disabled after editing the name"
              autoFocus
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Severity</Label>
              <Dropdown
                label="Severity"
                width="full"
                value={severity}
                onChange={setSeverity}
                options={FINDING_SEVERITIES.map((s) => ({
                  value: s,
                  label: s[0]!.toUpperCase() + s.slice(1),
                  ...(s === 'blocker' ? { hint: 'stops testing' } : {}),
                }))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Acceptance criterion</Label>
              <Dropdown
                label="Acceptance criterion"
                width="full"
                searchable={ac.length > 8}
                value={acKey}
                onChange={setAcKey}
                options={[
                  { value: NO_AC, label: 'None (UI or other)' },
                  ...ac.map((a) => ({ value: a.key, label: a.text })),
                ]}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="finding-steps">Steps to reproduce</Label>
            <Textarea
              id="finding-steps"
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              maxLength={4000}
              className="min-h-20"
              placeholder={'1. Open Profile\n2. Edit the name\n3. Tap Save'}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="finding-expected">Expected</Label>
              <Textarea
                id="finding-expected"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                maxLength={2000}
                className="min-h-16"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="finding-actual">Actual</Label>
              <Textarea
                id="finding-actual"
                value={actual}
                onChange={(e) => setActual(e.target.value)}
                maxLength={2000}
                className="min-h-16"
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{describeError(error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || title.trim().length < 3}>
              {pending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {editing ? 'Save' : 'Log finding'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
