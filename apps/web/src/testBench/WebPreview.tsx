import { ExternalLink, Globe, Loader2, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { SessionView } from '@/lib/sessionApi';
import { cn, safeHref } from '@/lib/utils';

type Width = 'mobile' | 'tablet' | 'desktop';
const WIDTHS: { id: Width; px: number | null; icon: typeof Monitor }[] = [
  { id: 'mobile', px: 390, icon: Smartphone },
  { id: 'tablet', px: 820, icon: Tablet },
  { id: 'desktop', px: null, icon: Monitor },
];
const WIDTH_KEY = 'test-bench:web-width';

/** The dev server runs on the Mac: `localhost:<port>` only reaches it from a browser on that Mac. */
const onTheMac = () =>
  ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);

/**
 * The web dev server of a branch, framed: width presets, reload, and Open in browser. When Relay is opened from another
 * device, or the app refuses to be framed (`X-Frame-Options`, CSP `frame-ancestors`), only the address and the link
 * are shown, with the reason.
 */
export function WebPreview({ session }: { session: SessionView | null }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState<Width>(() => {
    try {
      const v = localStorage.getItem(WIDTH_KEY);
      return v === 'mobile' || v === 'tablet' ? v : 'desktop';
    } catch {
      return 'desktop';
    }
  });
  const [nonce, setNonce] = useState(0);
  const live = session && session.state !== 'exited' ? session : null;
  const url = live?.preview ? safeHref(live.preview.url) : undefined;
  const framed = !!url && onTheMac() && !live?.preview?.frameBlocked;
  const px = WIDTHS.find((w) => w.id === width)!.px;

  const empty = (children: ReactNode) => (
    <div className="grid h-[min(72vh,52rem)] place-items-center rounded-sheet border border-dashed p-6 text-center text-sm text-muted-foreground">
      <div className="grid max-w-md justify-items-center gap-2">{children}</div>
    </div>
  );

  if (!live) {
    return empty(
      <>
        <Globe aria-hidden className="size-5" />
        <p>{session ? t('testBench.web.preview.exited') : t('testBench.web.preview.idle')}</p>
      </>,
    );
  }
  if (!url) {
    return empty(
      <>
        <Loader2 aria-hidden className="size-5 motion-safe:animate-spin" />
        <p className="text-foreground">{t('testBench.web.preview.starting')}</p>
        <p className="text-xs">{t('testBench.web.preview.startingHint')}</p>
      </>,
    );
  }

  return (
    <section aria-label={t('testBench.web.preview.label')} className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {url}
        </span>
        {framed && (
          <>
            <div
              role="radiogroup"
              aria-label={t('testBench.web.preview.width')}
              className="flex rounded-control border p-0.5"
            >
              {WIDTHS.map(({ id, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={width === id}
                  title={t(`testBench.web.preview.${id}`)}
                  aria-label={t(`testBench.web.preview.${id}`)}
                  onClick={() => {
                    setWidth(id);
                    try {
                      localStorage.setItem(WIDTH_KEY, id);
                    } catch {
                      /* not remembered */
                    }
                  }}
                  className={cn(
                    'tactile grid size-7 place-items-center rounded-control',
                    width === id ? 'bg-accent text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              title={t('testBench.web.preview.reload')}
              aria-label={t('testBench.web.preview.reload')}
              onClick={() => setNonce((n) => n + 1)}
            >
              <RefreshCw className="size-4" />
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" /> {t('testBench.web.preview.open')}
          </a>
        </Button>
      </div>
      {framed ? (
        <div className="overflow-x-auto rounded-sheet border bg-muted/40">
          <iframe
            key={nonce}
            src={url}
            title={t('testBench.web.preview.frameTitle', { url })}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            className="mx-auto block h-[min(72vh,52rem)] max-w-full bg-white"
            style={{ width: px ? `${px}px` : '100%' }}
          />
        </div>
      ) : (
        empty(
          <>
            <Globe aria-hidden className="size-5" />
            <p>
              {live.preview?.frameBlocked
                ? t('testBench.web.preview.blocked')
                : t('testBench.web.preview.remote')}
            </p>
          </>,
        )
      )}
    </section>
  );
}
