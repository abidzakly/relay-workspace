import * as ns from 'web-push';

/**
 * `web-push` is CommonJS with no static named exports, so under Node's ESM loader (tsx, the esbuild bundle) the
 * functions live on `default`, not on the namespace. TypeScript's typings only describe the named form, so this
 * one module resolves whichever exists and re-exports it typed. Import the library from here only.
 */
type WebPushLib = typeof ns;
const lib: WebPushLib = (ns as unknown as { default?: WebPushLib }).default ?? ns;

export const sendNotification: WebPushLib['sendNotification'] = lib.sendNotification;
export const generateVAPIDKeys: WebPushLib['generateVAPIDKeys'] = lib.generateVAPIDKeys;
