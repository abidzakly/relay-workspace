// Generates a VAPID key pair for Web Push and prints it as .env lines.
//   pnpm push:keys
// Nothing is written to disk: copy the three lines into .env (git-ignored) yourself. The PRIVATE key is a
// secret: never commit it, never paste it into a chat. Changing the pair invalidates every existing browser
// subscription (re-enable notifications in the header afterwards).
import { generateVAPIDKeys } from '../src/services/webPushLib';

const { publicKey, privateKey } = generateVAPIDKeys();

console.log(`# Paste into .env (VAPID_SUBJECT: a mailto: address or an https URL you control)`);
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
