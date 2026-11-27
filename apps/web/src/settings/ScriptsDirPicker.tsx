import { FolderOpen, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChooseScriptsDir } from '@/lib/scriptsApi';

/**
 * "Choose folder…" for the release scripts: the computer's own folder dialog (on the Mac when the dashboard runs in
 * Docker). Where there is no dialog, the path can be typed instead. The folder must hold an executable `vu`.
 */
export function ScriptsDirPicker({ found }: { found: boolean }) {
  const choose = useChooseScriptsDir();
  const [typed, setTyped] = useState<string | null>(null);
  const r = choose.data;
  const note =
    r?.status === 'invalid' || r?.status === 'unsupported'
      ? r.reason
      : r?.status === 'picked'
        ? null
        : choose.error?.message;
  const pick = () =>
    choose.mutate(undefined, {
      onSuccess: (x) => {
        if (x.status === 'unsupported') setTyped('');
        if (x.status === 'picked') setTyped(null);
      },
    });

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {typed !== null ? (
          <>
            <Input
              aria-label="Folder that holds vu"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="~/bin"
              className="h-8 min-w-0 max-w-sm flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              disabled={!typed.trim() || choose.isPending}
              onClick={() =>
                choose.mutate(typed.trim(), {
                  onSuccess: (x) => x.status === 'picked' && setTyped(null),
                })
              }
            >
              Use this folder
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant={found ? 'outline' : 'default'}
            disabled={choose.isPending}
            onClick={pick}
          >
            {choose.isPending ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : (
              <FolderOpen className="size-4" aria-hidden />
            )}
            {choose.isPending
              ? 'Waiting for the folder dialog…'
              : found
                ? 'Change folder'
                : 'Choose folder…'}
          </Button>
        )}
      </div>
      {note && (
        <p className="text-xs text-muted-foreground">
          {note}
          {r?.status === 'unsupported' ? ' Type the path instead.' : null}
        </p>
      )}
    </div>
  );
}
