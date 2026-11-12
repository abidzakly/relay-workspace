import { useState } from 'react';
import { Loader2, Send, UploadCloud } from 'lucide-react';
import type { BuildView, ShareResult } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { emit } from '@/lib/reward/engine';
import { useShareBuild, useUploadBuild } from '@/lib/buildApi';
import { safeHref } from '@/lib/utils';

const LINK_ACCESS_WARNING = {
  failed:
    'Drive could not set "anyone with the link" on this file, so QA may not be able to open it.',
  restricted: 'Anyone-with-the-link is off in Settings, so QA needs access to the Drive folder.',
} as const;

/** The upload as a sheet feeding out of the printer, with real progress from the server. */
function PaperFeed({ percent }: { percent: number }) {
  return (
    <div aria-hidden className="h-2 overflow-hidden rounded-xs border border-dashed bg-muted">
      <div
        className="h-full bg-card shadow-rest transition-[width] duration-500 ease-settle motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** Upload and Send to QA on a staging build's row. Prod and custom builds never get here (the server also refuses them). */
export function ShareControls({ view, dryRun }: { view: BuildView; dryRun: boolean }) {
  const { share } = view;
  const upload = useUploadBuild();
  const send = useShareBuild();
  const [includeLocalLink, setIncludeLocalLink] = useState(false);
  const [result, setResult] = useState<ShareResult | null>(null);
  const jobId = view.job.id;
  const stored = share.upload;
  const uploaded = stored !== null && !stored.dryRun;
  const { uploading } = share;
  const canSend = stored !== null && (dryRun || !stored.dryRun);

  const sendToQa = () => {
    // Opened during the click, since a browser blocks a tab opened after the answer arrives.
    const tab = dryRun ? null : window.open('', '_blank');
    send.mutate(
      { jobId, includeLocalLink },
      {
        onSuccess: (answer) => {
          setResult(answer);
          if (answer.dryRun) {
            tab?.close();
            return;
          }
          // Only the link is known to be ready: the app cannot see whether a message was sent.
          emit({ level: 'pop', key: `qa-link:${jobId}`, title: 'Link ready, you press send' });
          if (tab) {
            tab.opener = null;
            tab.location.href = answer.whatsappUrl;
          }
        },
        onError: () => tab?.close(),
      },
    );
  };

  const percent =
    uploading && uploading.totalBytes > 0
      ? Math.floor((uploading.sentBytes / uploading.totalBytes) * 100)
      : null;

  const warning =
    stored?.linkAccess === 'failed' || stored?.linkAccess === 'restricted'
      ? LINK_ACCESS_WARNING[stored.linkAccess]
      : null;

  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {!uploaded && (
          <Button
            size="sm"
            variant="outline"
            disabled={uploading !== null || upload.isPending}
            onClick={() => upload.mutate(jobId)}
          >
            {uploading ? (
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : (
              <UploadCloud className="size-4" aria-hidden />
            )}
            {dryRun ? 'Simulate upload' : 'Upload to Drive'}
          </Button>
        )}
        {canSend && (
          <>
            <Button size="sm" disabled={send.isPending} onClick={sendToQa}>
              <Send className="size-4" aria-hidden />
              Send to QA
            </Button>
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeLocalLink}
                onChange={(e) => setIncludeLocalLink(e.target.checked)}
              />
              Include the local link (opens only on this computer)
            </label>
          </>
        )}
        {uploading && (
          <span className="text-xs text-muted-foreground" role="status">
            {percent !== null ? `Uploading ${percent}%` : 'Uploading…'}
          </span>
        )}
        {stored?.webViewLink && (
          <a
            href={safeHref(stored.webViewLink)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open on Drive
          </a>
        )}
        {stored?.dryRun && (
          <span className="text-xs text-muted-foreground">Upload simulated: nothing was sent.</span>
        )}
      </div>

      {percent !== null && <PaperFeed percent={percent} />}
      {warning && <p className="text-xs text-muted-foreground">{warning}</p>}
      {share.uploadError && !uploading && (
        <p className="break-words text-destructive">{share.uploadError}</p>
      )}
      {upload.isError && (
        <p className="break-words text-destructive">{describeError(upload.error)}</p>
      )}
      {send.isError && <p className="break-words text-destructive">{describeError(send.error)}</p>}

      {result && (
        <Alert variant={result.dryRun ? 'warning' : 'default'}>
          <AlertTitle>
            {result.dryRun ? 'Dry run: this is what QA would get' : 'Press send in WhatsApp'}
          </AlertTitle>
          <AlertDescription>
            <pre className="font-sans break-words whitespace-pre-wrap">{result.message}</pre>
            {result.dryRun ? (
              <code className="block text-xs break-all">{result.whatsappUrl}</code>
            ) : (
              <a href={result.whatsappUrl} target="_blank" rel="noreferrer" className="underline">
                Open WhatsApp again
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
