import { createHash } from 'node:crypto';
import type { CardStartAttachment } from '@relay/shared';
import { ActionError } from '../actionError';

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** A user file (Start dialog, Make more changes, Cockpit chat): real base64, at most 5 MB, a name safe to store. */
export function decodeAttachment(a: CardStartAttachment): CardStartAttachment {
  const bytes = Buffer.from(a.dataBase64, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== a.dataBase64.replace(/\s/g, '')) {
    throw new ActionError(422, 'invalid_attachment', `${a.name} is not valid base64.`);
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new ActionError(413, 'attachment_too_large', `${a.name} is larger than 5 MB.`);
  }
  const name = a.name.replace(/[^\w.\- ]+/g, '_').slice(-100) || 'file';
  return { name, dataBase64: bytes.toString('base64') };
}

/** A fresh attachment folder id: 16 hex chars, as the host agent requires. */
export function attachmentGroup(seed: string, now = Date.now()): string {
  return createHash('sha256').update(`${seed}:${now}`).digest('hex').slice(0, 16);
}

/** The chat message plus where the files are, so the agent opens them (Claude and Cursor both read paths). */
export function withAttachmentPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  return `${text}

Attachments saved on this machine. Open every one before you answer (images included):
${paths.map((p) => `- ${p}`).join('\n')}`;
}
