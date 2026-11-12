import { useMemo, useState, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { MrRef } from '@relay/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { renderMarkdown } from '@/lib/markdown';
import { useMyUsernames } from '@/lib/settingsApi';
import { cn } from '@/lib/utils';

/**
 * The ONLY place that renders GitLab markdown. The HTML always comes from `renderMarkdown` (marked -> DOMPurify,
 * see `lib/markdown.ts`), never from the raw source.
 *
 * With `repo`, comment images show (through the server's proxy) and `!123` opens that MR's drawer in place.
 * A click on an image opens it full size.
 */
export function Markdown({
  source,
  className,
  repo,
  refs,
}: {
  source: string;
  className?: string;
  repo?: string;
  refs?: Readonly<Record<string, MrRef>>;
}) {
  const me = useMyUsernames().data;
  const html = useMemo(
    () =>
      renderMarkdown(source, {
        ...(repo ? { repo } : {}),
        ...(refs ? { refs } : {}),
        ...(me ? { me } : {}),
      }),
    [source, repo, refs, me],
  );
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Element)) return;
    const img = e.target.closest('img.md-img');
    if (img instanceof HTMLImageElement) {
      e.preventDefault();
      setZoom({ src: img.getAttribute('src') ?? '', alt: img.alt });
      return;
    }
    const ref = e.target.closest('a.mr-ref');
    // Plain left click only: a modified click keeps the browser's own behaviour (new tab, etc.).
    if (ref && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      e.preventDefault();
      const to = ref.getAttribute('href') ?? '';
      // From the inbox, keep its filters; from elsewhere, the drawer opens over the inbox.
      navigate({ pathname: to, search: pathname.startsWith('/mrs') ? search : '' });
    }
  };

  return (
    <>
      {/* Clicks are delegated: the content is sanitized HTML, not React elements. Links and images keep their
          native keyboard behaviour. */}
      <div
        className={cn('md', className)}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <Dialog open={zoom !== null} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent
          aria-describedby={undefined}
          className="max-w-[min(92vw,1200px)] gap-3 p-3 sm:p-4"
        >
          <DialogTitle className="truncate pr-8 text-sm normal-case tracking-normal">
            {zoom?.alt || 'Image'}
          </DialogTitle>
          {zoom && (
            <img
              src={zoom.src}
              alt={zoom.alt}
              className="max-h-[78vh] w-full rounded-surface object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
