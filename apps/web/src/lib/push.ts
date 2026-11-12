import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { isSafeAppPath, type PushStatus, type PushTestResult } from '@relay/shared';
import { get, post } from './api';

/**
 * Browser half of Web Push. The server owns the VAPID keys and the subscription list; this file owns
 * the permission flow and the browser's PushSubscription. Nothing secret is handled here: the VAPID PUBLIC key is
 * fetched from `GET /api/push/status`, the subscription goes to `POST /api/push/subscribe`.
 *
 * A subscription belongs to an ORIGIN: 127.0.0.1:5173 (Vite) and 127.0.0.1:3000 are different subscriptions.
 */

export const pushKeys = {
  status: ['push', 'status'] as const,
  browser: ['push', 'browser'] as const,
};

const SW_URL = '/sw.js';

export type BrowserPushState = 'unsupported' | 'insecure' | 'install' | 'denied' | 'off' | 'on';

/** iPhone/iPad (iPadOS reports itself as a Mac with a touch screen). */
function isAppleMobile(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

/** Opened from the Home Screen / as an installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Registers the service worker at startup, so an installed app has it ready (and push state is known) before the
 * user opens Settings. `registration()` below registers the same script again, which the browser treats as a no-op.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register(SW_URL, { scope: '/' }).catch(() => undefined);
}

function unsupportedReason(): 'unsupported' | 'insecure' | 'install' | null {
  if (typeof window === 'undefined') return 'unsupported';
  // localhost / 127.0.0.1 count as secure contexts; a LAN IP over http does not.
  if (!window.isSecureContext) return 'insecure';
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    // iOS/iPadOS 16.4+ only exposes Web Push to a web app added to the Home Screen, never to a Safari tab.
    if (isAppleMobile() && !isStandalone()) return 'install';
    return 'unsupported';
  }
  return null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  return navigator.serviceWorker.ready;
}

function toKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const have = sub.options.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  const b = toKeyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

let resyncedThisLoad = false;

async function readBrowserState(): Promise<BrowserPushState> {
  const why = unsupportedReason();
  if (why) return why;
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const sub = await (await registration()).pushManager.getSubscription();
  if (sub && !resyncedThisLoad) {
    // The server may have lost the row (expired and cleaned up, DB reset): re-send once per page load. Idempotent.
    resyncedThisLoad = true;
    post('/api/push/subscribe', sub.toJSON()).catch(() => undefined);
  }
  return sub ? 'on' : 'off';
}

export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.'
        : 'Notification permission was not granted.',
    );
    this.name = 'PushPermissionError';
  }
}

async function fetchStatus(): Promise<PushStatus> {
  return get<PushStatus>('/api/push/status');
}

async function enablePush(publicKey: string | null): Promise<void> {
  const why = unsupportedReason();
  if (why) throw new Error('This browser cannot receive push notifications here.');
  if (!publicKey) throw new Error('Web Push is not configured on the server (VAPID keys).');
  // Keep this the first await: requestPermission wants to run inside the click's user activation.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushPermissionError(permission);

  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // The VAPID pair was rotated since this browser subscribed: the old subscription can never work again.
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toKeyBytes(publicKey),
  });
  try {
    await post('/api/push/subscribe', sub.toJSON());
  } catch (e) {
    // Do not leave a browser subscription the server does not know about.
    await sub.unsubscribe().catch(() => undefined);
    throw e;
  }
}

async function disablePush(): Promise<void> {
  if (unsupportedReason()) return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  // Even if the server call fails the browser side is dropped; the server cleans the row on its next 404/410.
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export function usePushStatus() {
  return useQuery({ queryKey: pushKeys.status, queryFn: fetchStatus });
}

export interface BrowserPushView {
  /** `loading` until both the browser state and the server status are known. */
  kind: 'loading' | BrowserPushState | 'server_off';
  /** Short, user-facing explanation (also the button tooltip). */
  hint: string;
  busy: boolean;
  error: string | null;
  /** Enable when off, disable when on; no-op in every other state. */
  toggle: () => void;
  status: PushStatus | undefined;
}

const HINTS: Record<BrowserPushView['kind'], string> = {
  loading: 'Checking notification support…',
  unsupported: 'This browser does not support push notifications.',
  insecure:
    'Push needs a secure context: open the dashboard via https (Tailscale), http://127.0.0.1 or localhost.',
  install:
    'On iPhone/iPad, notifications only work from the installed app: tap Share › Add to Home Screen, then open it from there.',
  denied: 'Notifications are blocked in the browser’s site settings.',
  server_off:
    'Web Push is not configured on the server: run pnpm push:keys and add the keys to .env.',
  off: 'Get a notification when a reviewer approves, someone comments, or a pipeline fails.',
  on: 'Notifications are on for this browser. Click to turn them off.',
};

/** One source of truth for the header toggle and the Settings card. */
export function useBrowserPush(): BrowserPushView {
  const qc = useQueryClient();
  const status = usePushStatus();
  const browser = useQuery({
    queryKey: pushKeys.browser,
    queryFn: readBrowserState,
    staleTime: Infinity,
    // The user can flip the permission in the browser's site settings while the tab is open.
    refetchOnWindowFocus: true,
  });

  const settle = () => {
    void qc.invalidateQueries({ queryKey: pushKeys.browser });
    void qc.invalidateQueries({ queryKey: pushKeys.status });
  };
  const enable = useMutation({
    mutationFn: async () => {
      const s = status.data ?? (await fetchStatus());
      await enablePush(s.publicKey);
    },
    onSettled: settle,
  });
  const disable = useMutation({ mutationFn: disablePush, onSettled: settle });

  let kind: BrowserPushView['kind'] = 'loading';
  if (browser.data && status.data) {
    const b = browser.data;
    if (b === 'unsupported' || b === 'insecure' || b === 'install' || b === 'denied') kind = b;
    else if (b === 'on') kind = 'on';
    else kind = status.data.configured ? 'off' : 'server_off';
  } else if (
    browser.data === 'unsupported' ||
    browser.data === 'insecure' ||
    browser.data === 'install'
  ) {
    kind = browser.data;
  }

  const err = enable.error ?? disable.error;
  return {
    kind,
    hint: HINTS[kind],
    busy: enable.isPending || disable.isPending,
    error: err ? (err instanceof Error ? err.message : 'Something went wrong') : null,
    toggle: () => {
      if (enable.isPending || disable.isPending) return;
      if (kind === 'off') enable.mutate();
      else if (kind === 'on') disable.mutate();
    },
    status: status.data,
  };
}

/** `POST /api/push/test`: really sends a push (and the ntfy fallback when configured). */
export function useSendTestPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<PushTestResult>('/api/push/test'),
    // A 404/410 during the test removes the subscription: refresh the counts.
    onSettled: () => void qc.invalidateQueries({ queryKey: pushKeys.status }),
  });
}

/**
 * The service worker cannot drive React Router, so on a notification click it focuses the open tab and posts
 * `{type:'core:navigate', url}`. Only a validated dashboard path is ever followed.
 */
export function useServiceWorkerNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent<unknown>) => {
      const d = e.data;
      if (typeof d !== 'object' || d === null) return;
      const m = d as { type?: unknown; url?: unknown };
      if (m.type === 'core:navigate' && isSafeAppPath(m.url)) void navigate(m.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
}
