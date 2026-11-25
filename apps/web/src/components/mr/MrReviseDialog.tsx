import { Loader2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AGENT_MODEL_CHOICES, agentModelLabel } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import {
  briefAttachments,
  BriefFields,
  EMPTY_BRIEF,
  figmaLinkProblem,
  type Brief,
} from '@/cockpit/CardBrief';
import { DirtyTreePanel } from '@/cockpit/DirtyTreePanel';
import { ApiError, describeError } from '@/lib/api';
import { useWorkspaces } from '@/lib/cockpitApi';
import { useSettings } from '@/lib/settingsApi';
import { useBranchRevise, useMrRevise, type ReviseResult } from '@/lib/workflowApi';

/**
 * "Make more changes" on a draft MR (`iid`), or "Propose changes" on Create MR (`iid` null, the branch has no MR yet):
 * the same brief as Start on the Board (instructions, Figma, files), then a NEW agent session on that branch. No branch
 * is picked: the session stays on `branch`. The agent plans first and commits; it never pushes, so I review and test
 * before the MR gets the commits.
 */
export function MrReviseDialog({
  repo,
  iid,
  branch,
  open,
  onClose,
}: {
  repo: string;
  /** null = Propose changes on Create MR: no MR exists yet. */
  iid: number | null;
  branch: string;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const mrRevise = useMrRevise();
  const branchRevise = useBranchRevise();
  const revise = iid === null ? branchRevise : mrRevise;
  const settings = useSettings().data;
  const workspaces = useWorkspaces();
  const ws = workspaces.data?.find((w) => w.repoId === repo && w.kind === 'repo') ?? null;
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [agentPick, setAgentPick] = useState<'claude' | 'cursor' | null>(null);
  const [modelPick, setModelPick] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [encodeError, setEncodeError] = useState<string | null>(null);

  const agent = agentPick ?? settings?.agentPreference ?? 'claude';
  const models = AGENT_MODEL_CHOICES[agent];
  const cfg = settings?.agentModels;
  const defaultModel = agent === 'claude' ? cfg?.planModel : cfg?.cursorModel;
  const model =
    modelPick && models.some((m) => m.id === modelPick)
      ? modelPick
      : (defaultModel ?? models[0].id);

  const busy = revise.isPending || encoding;
  const figmaProblem = figmaLinkProblem(brief.figmaUrl);
  const treeDirty = revise.error instanceof ApiError && revise.error.code === 'ws_dirty';

  const go = async () => {
    setEncoding(true);
    setEncodeError(null);
    let attachments;
    try {
      attachments = await briefAttachments(brief.files);
    } catch (e) {
      setEncodeError(`Could not read a file: ${(e as Error).message}`);
      return;
    } finally {
      setEncoding(false);
    }
    const body = {
      repoId: repo,
      agent,
      model,
      ...(brief.extraPrompt.trim() ? { extraPrompt: brief.extraPrompt.trim() } : {}),
      ...(brief.figmaUrl.trim() ? { figmaUrl: brief.figmaUrl.trim() } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const done = {
      onSuccess: (r: ReviseResult) => {
        onClose();
        void navigate(
          `/cockpit?ws=${encodeURIComponent(r.workspaceId)}&session=${r.sessionId}&tab=agent`,
        );
      },
    };
    if (iid === null) branchRevise.mutate({ ...body, branch }, done);
    else mrRevise.mutate({ ...body, iid }, done);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{iid === null ? 'Propose changes' : 'Make more changes'}</DialogTitle>
          <DialogDescription>
            A new agent session on{' '}
            <span className="font-mono text-xs [overflow-wrap:anywhere]">{branch}</span>. It plans
            first, then adds commits. It does not push: review and test them, then push yourself.
          </DialogDescription>
        </DialogHeader>

        {workspaces.isSuccess && !ws ? (
          <p className="text-sm text-muted-foreground">
            No Cockpit workspace is linked to this repository. Add one in Settings → Workspaces.
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                Agent
                <Select
                  value={agent}
                  disabled={busy}
                  onChange={(e) => {
                    setAgentPick(e.target.value as 'claude' | 'cursor');
                    setModelPick(null);
                  }}
                >
                  <option value="claude">Claude</option>
                  <option value="cursor">Cursor</option>
                </Select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Model
                <Select
                  value={model}
                  disabled={busy}
                  title={
                    agent === 'claude' && cfg && model === cfg.planModel && cfg.execModel !== model
                      ? `Plans on this model, then switches to ${cfg.execModel} (${cfg.execEffort}) when you approve the plan`
                      : undefined
                  }
                  onChange={(e) => setModelPick(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {!models.some((m) => m.id === model) && (
                    <option value={model}>{agentModelLabel(model)}</option>
                  )}
                </Select>
              </label>
            </div>

            {ws && (
              <BriefFields
                value={brief}
                onChange={setBrief}
                disabled={busy}
                instructionsPlaceholder={`What to change on this ${iid === null ? 'branch' : 'MR'}: fixes, additions, what to leave alone…`}
              />
            )}

            {revise.error && !treeDirty && (
              <p className="text-sm text-destructive">{describeError(revise.error)}</p>
            )}
            {encodeError && <p className="text-sm text-destructive">{encodeError}</p>}
            {treeDirty && ws && (
              <DirtyTreePanel workspaceId={ws.id} disabled={busy} onCleared={() => void go()} />
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy || !ws || !!figmaProblem}
                onClick={() => void go()}
              >
                {busy ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <Wand2 className="size-4" aria-hidden />
                )}
                Start
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
