/*
 * Relay service worker: Web Push only.
 * No fetch handler, no caching, no imports (the payload shape mirrors `PushPayloadSchema` in packages/shared).
 *
 *  push               -> show a notification (`tag` collapses repeats of the same MR in the OS tray)
 *  notificationclick  -> focus an open dashboard tab and ask it to navigate (postMessage), or open a new one
 *
 * The payload comes from our own server through the push service, but it is still treated as untrusted:
 * every field is type-checked and clipped, and a click can only ever go to a dashboard PATH (never a URL).
 */
'use strict';

const MAX_TITLE = 120;
const MAX_BODY = 240;

/** Backslash, control characters and DEL. */
function hasUnsafeChar(p) {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** Same rule as `isSafeAppPath` in packages/shared/src/push.ts. */
function isSafeAppPath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 200 &&
    p.charAt(0) === '/' &&
    p.charAt(1) !== '/' &&
    !hasUnsafeChar(p)
  );
}

function clip(value, max, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function readJson(event) {
  try {
    return event.data ? event.data.json() : null;
  } catch {
    return null;
  }
}

function readPayload(event) {
  const data = readJson(event);
  const d = data !== null && typeof data === 'object' ? data : {};
  return {
    // The system notification carries the app's own icon, so a leading emoji in the title is dropped.
    title: clip(
      typeof d.title === 'string'
        ? d.title.replace(/^(?:\p{Extended_Pictographic}️?\s*)+/u, '')
        : d.title,
      MAX_TITLE,
      'Relay',
    ),
    body: clip(d.body, MAX_BODY, ''),
    tag: clip(d.tag, 100, 'relay'),
    url: isSafeAppPath(d.url) ? d.url : '/',
    at: typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : Date.now(),
  };
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const n = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      icon: '/icon-192.png',
      // Android tints the badge's alpha channel for the status bar: white glyph on transparent.
      badge: '/badge-96.png',
      tag: n.tag,
      renotify: true,
      timestamp: n.at,
      data: { url: n.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const path = data && isSafeAppPath(data.url) ? data.url : '/';
  const scope = self.registration.scope;
  const origin = new URL(scope).origin;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === origin);
      if (open) {
        try {
          await open.focus();
        } catch {
          // focusing can be refused; the navigation message below still goes out
        }
        open.postMessage({ type: 'core:navigate', url: path });
        return;
      }
      await self.clients.openWindow(new URL(path, scope).href);
    })(),
  );
});
