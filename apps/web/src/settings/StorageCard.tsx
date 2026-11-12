import { HardDrive, Loader2, ScanSearch, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  CleanupCandidate,
  CleanupCategory,
  CleanupScan,
  GlobalConfigPublic,
} from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useCleanupApply, useCleanupLast, useCleanupScan } from '@/lib/cleanupApi';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

const CATEGORY_LABEL: Record<CleanupCategory, string> = {
  attachments: 'Agent attachments',
  checkpoints: 'Checkpoint refs',
  branches: 'Local branches',
  git: 'Git housekeeping',
  'clone-builds': 'Clone build output',
  clones: 'Unused bot clones',
  apks: 'Old APKs',
  evidence: 'Test screenshots',
  figma: 'Figma cache',
  scrcpy: 'Old scrcpy servers',
  temp: 'Temp leftovers',
  worktrees: 'Finished agent worktrees',
};

const bytesLabel = (b: number) =>
  b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(1)} GB`
    : b >= 1024 ** 2
      ? `${(b / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(b / 1024))} KB`;

const sum = (list: readonly CleanupCandidate[]) => list.reduce((n, c) => n + (c.bytes ?? 0), 0);

/**
 * Settings → Storage: deterministic cleanup (no AI). Scan lists what each fixed rule matched and why; safe leftovers
 * start ticked, things a person might still want (branches, APKs, clones) start unticked. Clean re-checks every item
 * on the server before it deletes it.
 */
export function StorageCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const last = useCleanupLast();
  const scan = useCleanupScan();
  const apply = useCleanupApply();
  const [result, setResult] = useState<CleanupScan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const m = new Map<CleanupCategory, CleanupCandidate[]>();
    for (const c of result?.candidates ?? []) m.set(c.category, [...(m.get(c.category) ?? []), c]);
    return [...m];
  }, [result]);
  const chosen = (result?.candidates ?? []).filter((c) => picked.has(c.id));

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) => {
        setResult(r);
        setPicked(new Set(r.candidates.filter((c) => c.tier === 'safe').map((c) => c.id)));
      },
    });

  const toggle = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const clean = () => {
    const confirm = chosen.filter((c) => c.tier === 'confirm');
    if (
      confirm.length > 0 &&
      !window.confirm(
        `Delete ${confirm.length} item${confirm.length === 1 ? '' : 's'} that need confirmation (${[
          ...new Set(confirm.map((c) => CATEGORY_LABEL[c.category])),
        ].join(', ')})? This cannot be undone.`,
      )
    )
      return;
    apply.mutate(
      chosen.map((c) => c.id),
      { onSuccess: () => runScan() },
    );
  };

  const auto = settings.storageCleanup.auto;
  const shown = apply.data ?? last.data ?? null;

  return (
    <SectionCard
      id="storage"
      title="Storage"
      description="Cleans what the dashboard and the Cockpit leave on disk, by fixed rules (no AI). Your own files and working copies are never touched."
      action={
        <Button variant="outline" onClick={runScan} disabled={scan.isPending || apply.isPending}>
          {scan.isPending ? (
            <Loader2 className="motion-safe:animate-spin" aria-hidden />
          ) : (
            <ScanSearch aria-hidden />
          )}
          Scan
        </Button>
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <label htmlFor="storage-auto" className="text-sm font-medium">
            Clean safe leftovers daily
          </label>
          <p className="text-xs text-muted-foreground">
            Agent attachments of finished work, old checkpoints, caches and temp files. Branches,
            APKs and clones always wait for you.
          </p>
        </div>
        <Switch
          id="storage-auto"
          checked={auto}
          disabled={save.isPending}
          onCheckedChange={(on) =>
            save.mutate({
              patch: (s) => ({ ...s, storageCleanup: { ...s.storageCleanup, auto: on } }),
            })
          }
        />
      </div>

      {shown && (
        <p className="text-xs text-muted-foreground">
          {shown.auto ? 'Last daily run' : 'Last cleanup'} {new Date(shown.at).toLocaleString()}:
          removed {shown.removed.length}
          {shown.bytesFreed > 0 ? ` (${bytesLabel(shown.bytesFreed)})` : ''}
          {shown.failed.length > 0 ? `, ${shown.failed.length} failed` : ''}
          {shown.kept.length > 0 ? `, ${shown.kept.length} kept because they changed` : ''}.
        </p>
      )}
      {apply.data && apply.data.failed.length > 0 && (
        <ul className="grid gap-1 text-xs text-destructive">
          {apply.data.failed.map((f) => (
            <li key={f.id}>
              {f.label}: {f.reason}
            </li>
          ))}
        </ul>
      )}

      {result && (
        <>
          {result.candidates.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <HardDrive className="size-4" aria-hidden /> Nothing to clean.
            </p>
          ) : (
            <div className="grid gap-4">
              {groups.map(([cat, list]) => {
                const allOn = list.every((c) => picked.has(c.id));
                return (
                  <section key={cat} className="grid gap-1">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={allOn}
                        onChange={(e) =>
                          toggle(
                            list.map((c) => c.id),
                            e.target.checked,
                          )
                        }
                      />
                      {CATEGORY_LABEL[cat]}
                      <span className="font-mono text-2xs text-muted-foreground">
                        {list.length}
                        {sum(list) > 0 ? ` · ${bytesLabel(sum(list))}` : ''}
                      </span>
                      {list[0]!.tier === 'confirm' && (
                        <span className="text-2xs font-medium uppercase text-warning">
                          needs confirmation
                        </span>
                      )}
                    </label>
                    <ul className="grid">
                      {list.map((c) => (
                        <li key={c.id} className="border-t border-hairline py-1.5">
                          <label className="flex min-w-0 items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={picked.has(c.id)}
                              onChange={(e) => toggle([c.id], e.target.checked)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-xs" title={c.label}>
                                {c.label}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {c.where} · {c.reason}
                              </span>
                            </span>
                            {c.bytes !== null && c.bytes > 0 && (
                              <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                                {bytesLabel(c.bytes)}
                              </span>
                            )}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {result.skipped.length > 0 && (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {result.skipped.map((s) => (
                <li key={s.where}>
                  Skipped {s.where}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          {result.candidates.length > 0 && (
            <Button
              variant="destructive"
              className="justify-self-start"
              disabled={chosen.length === 0 || apply.isPending || scan.isPending}
              onClick={clean}
            >
              {apply.isPending ? (
                <Loader2 className="motion-safe:animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              Clean {chosen.length} selected
              {sum(chosen) > 0 ? ` (${bytesLabel(sum(chosen))})` : ''}
            </Button>
          )}
        </>
      )}
      <ErrorAlert error={scan.error ?? apply.error ?? save.error} />
    </SectionCard>
  );
}
