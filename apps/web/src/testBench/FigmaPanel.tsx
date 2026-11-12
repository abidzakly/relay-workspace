import { useQuery } from '@tanstack/react-query';
import { Columns2, ExternalLink, Layers, Link2, Loader2, PenTool, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  parseFigmaUrl,
  type FigmaBridgeStatus,
  type FigmaFrames,
  type TestBenchState,
} from '@relay/shared';
import { Dropdown } from '@/components/Dropdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeError, get } from '@/lib/api';
import { useSetFigma, useSetFrame } from '@/lib/testBenchApi';
import { cn, safeHref } from '@/lib/utils';

/**
 * The right column of the Test Bench: the Figma frame for the selected AC, next to the phone or
 * laid over it. The frame comes from the AC's own mapping, else the node in the card's Figma link.
 */

export type CompareMode = 'side' | 'overlay';

const e = encodeURIComponent;
export const figmaImageUrl = (fileKey: string, nodeId: string) =>
  `/api/figma/image?file=${e(fileKey)}&node=${e(nodeId)}`;

/** The frame to show for an AC (or the link's own node), or null. */
export function frameFor(
  st: TestBenchState,
  acKey: string | null,
): { fileKey: string; nodeId: string } | null {
  const link = st.body?.figmaUrl ? parseFigmaUrl(st.body.figmaUrl) : null;
  if (!link) return null;
  const nodeId = (acKey ? st.frames[acKey] : undefined) ?? link.nodeId;
  return nodeId ? { fileKey: link.fileKey, nodeId } : null;
}

export function FigmaPanel({
  repo,
  branch,
  st,
  selectedKey,
  mode,
  onMode,
  opacity,
  onOpacity,
}: {
  repo: string;
  branch: string;
  st: TestBenchState;
  selectedKey: string | null;
  mode: CompareMode;
  onMode: (m: CompareMode) => void;
  opacity: number;
  onOpacity: (n: number) => void;
}) {
  // Local and cheap: poll so the panel wakes up as soon as the designer's file opens the plugin.
  const status = useQuery({
    queryKey: ['figma', 'status'],
    queryFn: () => get<FigmaBridgeStatus>('/api/figma/status'),
    refetchInterval: 10_000,
  });
  const link = st.body?.figmaUrl ? parseFigmaUrl(st.body.figmaUrl) : null;
  const fileOpen = !!link && !!status.data?.files.some((f) => f.fileKey === link.fileKey);
  const frames = useQuery({
    queryKey: ['figma', 'frames', link?.fileKey],
    queryFn: () => get<FigmaFrames>(`/api/figma/frames?file=${e(link!.fileKey)}`),
    enabled: fileOpen,
    staleTime: 5 * 60_000,
  });
  const setFrame = useSetFrame(repo, branch);
  const setFigma = useSetFigma(repo, branch);
  const [editingLink, setEditingLink] = useState(false);
  const [draft, setDraft] = useState(st.body?.figmaUrl ?? '');
  const [bust, setBust] = useState(0);
  const target = frameFor(st, selectedKey);
  const selectedAc = st.body?.ac.find((a) => a.key === selectedKey) ?? null;

  const linkEditor = (
    <form
      className="grid gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        setFigma.mutate(draft.trim() ? draft.trim() : null, {
          onSuccess: () => setEditingLink(false),
        });
      }}
    >
      <Input
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        placeholder="https://www.figma.com/design/…?node-id=12-34"
        aria-label="Figma link"
        autoFocus
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={setFigma.isPending}>
          Save link
        </Button>
        {st.body?.figmaSource === 'override' && (
          <Button size="sm" type="button" variant="ghost" onClick={() => setFigma.mutate(null)}>
            Use the link in Notion
          </Button>
        )}
        <Button size="sm" type="button" variant="ghost" onClick={() => setEditingLink(false)}>
          Cancel
        </Button>
      </div>
      {setFigma.error && (
        <p className="text-xs text-destructive">{describeError(setFigma.error)}</p>
      )}
    </form>
  );

  return (
    <div className="grid content-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 font-mono text-xs tracking-wide text-muted-foreground uppercase">
          <PenTool aria-hidden className="size-3.5" /> Design
        </h2>
        <div
          role="group"
          aria-label="Compare mode"
          className="ml-auto flex rounded-control border p-0.5"
        >
          {(
            [
              ['side', 'Side by side', Columns2],
              ['overlay', 'Overlay', Layers],
            ] as const
          ).map(([m, label, Icon]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => onMode(m)}
              className={cn(
                'tactile flex h-7 items-center gap-1 rounded-control px-2 text-xs',
                mode === m ? 'bg-accent font-medium' : 'text-muted-foreground',
              )}
            >
              <Icon aria-hidden className="size-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      {link && status.data && !fileOpen && (
        <div className="grid gap-2 rounded-surface border border-dashed p-3 text-sm text-muted-foreground">
          {status.data.bridge === 'down' ? (
            <p>
              The Figma bridge could not start
              {status.data.error ? `: ${status.data.error}` : '.'}
            </p>
          ) : (
            <p>
              This file is not connected
              {status.data.files.length > 0 &&
                ` (open: ${status.data.files.map((f) => f.fileName).join(', ')})`}
              .
            </p>
          )}
          <p>
            Open it in the Figma desktop app and run{' '}
            <span className="font-mono">Plugins › Development › Figma MCP Bridge</span>.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            <RefreshCw className="size-3.5" /> Check again
          </Button>
        </div>
      )}

      {!link || editingLink ? (
        editingLink ? (
          linkEditor
        ) : (
          <div className="grid gap-2 rounded-surface border border-dashed p-3 text-sm text-muted-foreground">
            <p>The card has no Figma link.</p>
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => setEditingLink(true)}
            >
              <Link2 className="size-4" /> Add a link
            </Button>
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {frames.data?.fileName ?? 'Figma file'}
              {st.body?.figmaSource === 'override' && ' · set here'}
            </span>
            <a
              href={safeHref(st.body!.figmaUrl!) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              Open <ExternalLink aria-hidden className="size-3" />
            </a>
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => {
                setDraft(st.body?.figmaUrl ?? '');
                setEditingLink(true);
              }}
            >
              Change link
            </button>
          </div>

          {selectedAc ? (
            <div className="grid gap-1.5">
              <p className="text-xs text-muted-foreground">Frame for “{selectedAc.text}”</p>
              <Dropdown
                label="Figma frame"
                width="full"
                searchable
                placeholder={link.nodeId ? 'The link’s frame' : 'Pick a frame'}
                value={st.frames[selectedAc.key] ?? null}
                onChange={(nodeId) => setFrame.mutate({ acKey: selectedAc.key, nodeId })}
                options={(frames.data?.frames ?? []).map((f) => ({
                  value: f.id,
                  label: f.name,
                  hint: f.page,
                }))}
                footer={
                  frames.isPending
                    ? 'Loading frames…'
                    : frames.error
                      ? describeError(frames.error)
                      : undefined
                }
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Select an AC on the left to pick its frame.
            </p>
          )}

          {!fileOpen ? null : target ? (
            mode === 'side' ? (
              <div className="grid gap-2">
                <div className="relative overflow-hidden rounded-surface border bg-muted/40">
                  <img
                    key={`${target.nodeId}:${bust}`}
                    src={`${figmaImageUrl(target.fileKey, target.nodeId)}${bust ? `&refresh=1&b=${bust}` : ''}`}
                    alt={`Figma frame ${target.nodeId}`}
                    className="mx-auto block max-h-[70vh] w-auto"
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-self-start"
                  onClick={() => setBust(Date.now())}
                >
                  <RefreshCw className="size-3.5" /> Re-render from Figma
                </Button>
              </div>
            ) : (
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                Overlay opacity · {Math.round(opacity * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(ev) => onOpacity(Number(ev.target.value))}
                  className="accent-primary"
                />
                <span>
                  The design is laid over the phone screen. Input still goes to the phone.
                </span>
              </label>
            )
          ) : (
            <p className="text-sm text-muted-foreground">No frame yet: pick one above.</p>
          )}
          {setFrame.isPending && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 motion-safe:animate-spin" /> Saving…
            </p>
          )}
        </>
      )}
    </div>
  );
}
