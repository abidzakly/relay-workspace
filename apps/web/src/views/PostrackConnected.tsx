import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { POSTRACK_CHANNEL } from '@/lib/postrackApi';

/**
 * Where the Postrack sign-in popup lands (the server's OAuth callback redirects here). Tells the page that opened it,
 * then closes. Outside the app layout: no scene, no nav, nothing to load.
 */
export function PostrackConnected() {
  const [params] = useSearchParams();
  const error = params.get('error');

  useEffect(() => {
    try {
      const c = new BroadcastChannel(POSTRACK_CHANNEL);
      c.postMessage({ type: 'postrack-signin', error });
      c.close();
    } catch {
      /* the opener also polls the status */
    }
    if (!error) {
      const t = setTimeout(() => window.close(), 800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="grid max-w-sm gap-2 text-center">
        <p className="type-micro text-muted-foreground">Postrack</p>
        {error ? (
          <>
            <h1 className="text-lg font-semibold">Not connected</h1>
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <p className="text-xs text-muted-foreground">
              Close this window and press Connect again.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">
              Postrack <span className="type-accent">connected</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              This window closes by itself. If it stays open, close it.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
